// ============================================================
// Audit logging.
//
// Everything recorded goes into one stream, audit_events: admin mutations,
// authentication, and permission denials. Reads and exports join them in a
// later phase. See docs/access-logging-design-2026-10-29.md.
//
// Two rules the envelope exists to keep:
//   - no email, ever. The actor is an internal user id, so erasing an account
//     removes the identity without touching the trail — an email copied into
//     every row survives in exactly the rows we are obliged to retain.
//   - occurred_at is set here, not by CURRENT_TIMESTAMP, whose whole seconds
//     cannot order concurrent events. Workers also freezes the clock between
//     I/O, so events inside one request share a timestamp; `seq` is what
//     orders those.
//
// Writes stay fire-and-forget via waitUntil so a logging failure can never
// break the action it records. Detail payloads should stay small (slugs,
// filenames, failure reasons) — never content bodies, and never an email or
// any other identifier that erasure has to be able to reach.
// ============================================================

import type { Env, JWTPayload } from '../../types';
import type { AppContext } from '../http/context';
import { recordAuditOutage } from './audit-outages';

/** Entity types whose changes are configuration rather than content. They get
 *  the longer `admin_config` retention: low volume, high forensic value. */
const ADMIN_ENTITY_TYPES = new Set([
  'user', 'role', 'plugin', 'settings', 'locale', 'shared_credits', 'page_type', 'block_type',
  // Reading the audit log is itself an administrative act and is kept as long.
  'audit',
]);

/** Longest user-agent we keep; the full string is unbounded and adds nothing. */
const USER_AGENT_LIMIT = 256;

type EventClass = 'auth' | 'read' | 'mutation' | 'export' | 'admin';
type Outcome = 'success' | 'denied' | 'error';

/** One recorded mutation. */
export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | number;
  detail?: Record<string, unknown>;
  outcome?: Outcome;
}

/** A fully resolved row, after class and retention have been decided. */
export interface AuditRow {
  /** Stable identity/time for idempotent administrative reconciliation receipts. */
  eventId?: string;
  occurredAt?: string;
  action: string;
  eventClass: EventClass;
  retentionClass: string;
  outcome: Outcome;
  /** 'none' until a classified container is involved. */
  dataClass: 'none' | 'pii' | 'phi';
  targetType: string | null;
  /** The single target, kept scalar so it is indexable. */
  targetId: string | null;
  /** Several targets, capped; targetCount stays authoritative. */
  targetIds: string[] | null;
  targetCount: number | null;
  containerKey: string | null;
  queryFingerprint: string | null;
  detail: Record<string, unknown> | null;
}

/** Who the action is attributed to. A contributor acting on its own behalf, or
 *  a sign-in that never identified anyone, has no user — hence the nulls. */
export interface AuditActor {
  userId: string | null;
  roles: string | null;
  sessionSid: string | null;
  via: string | null;
}

/** Request details every event carries. All null off a request — a queued job
 *  replays an action with no inbound headers of its own. */
interface AuditRequest {
  requestId: string | null;
  sourceIp: string | null;
  userAgent: string | null;
}

const NO_REQUEST: AuditRequest = { requestId: null, sourceIp: null, userAgent: null };
const NO_ACTOR: AuditActor = { userId: null, roles: null, sessionSid: null, via: null };

const INSERT = `INSERT INTO audit_events
    (event_id, occurred_at, event_class, data_class, retention_class, action, outcome,
     actor_user_id, actor_roles, acting_via, session_sid, request_id, source_ip, user_agent,
     target_type, target_id, target_ids, target_count, container_key, query_fingerprint, detail)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function statement(env: Env, row: AuditRow, actor: AuditActor, request: AuditRequest) {
  return env.DB.prepare(INSERT + (row.eventId ? ' ON CONFLICT(event_id) DO NOTHING' : '')).bind(
    row.eventId ?? crypto.randomUUID(),
    row.occurredAt ?? new Date().toISOString(),
    row.eventClass,
    row.dataClass,
    row.retentionClass,
    row.action,
    row.outcome,
    actor.userId,
    actor.roles,
    actor.via,
    actor.sessionSid,
    request.requestId,
    request.sourceIp,
    request.userAgent,
    row.targetType,
    row.targetId,
    row.targetIds ? JSON.stringify(row.targetIds) : null,
    row.targetCount,
    row.containerKey,
    row.queryFingerprint,
    row.detail ? JSON.stringify(row.detail) : null,
  );
}

/** Shared statement builder for health probes and reconciliation receipts. */
export function auditStatement(env: Env, row: AuditRow, actor: AuditActor) {
  return statement(env, row, actor, NO_REQUEST);
}

/** A mutation entry resolved to a row: the entity type picks the retention. */
function mutationRow(entry: AuditEntry): AuditRow {
  const eventClass: EventClass = ADMIN_ENTITY_TYPES.has(entry.entityType) ? 'admin' : 'mutation';
  const hasTarget = entry.entityId !== undefined && entry.entityId !== null;
  return {
    action: entry.action,
    eventClass,
    retentionClass: eventClass === 'admin' ? 'admin_config' : 'content_mutation',
    outcome: entry.outcome ?? 'success',
    dataClass: 'none',
    targetType: entry.entityType,
    targetId: hasTarget ? String(entry.entityId) : null,
    targetIds: null,
    targetCount: hasTarget ? 1 : null,
    containerKey: null,
    queryFingerprint: null,
    detail: entry.detail ?? null,
  };
}

function actorFromUser(user: JWTPayload | undefined, via: string | null = null): AuditActor {
  return {
    userId: user ? String(user.sub) : null,
    roles: user?.role ?? null,
    sessionSid: user?.sid ?? null,
    via,
  };
}

function requestFrom(c: AppContext): AuditRequest {
  const headers = c.req.raw.headers;
  return {
    requestId: headers.get('cf-ray'),
    sourceIp: headers.get('cf-connecting-ip'),
    userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_LIMIT) ?? null,
  };
}

/** Runs `promise` after the response, or detached where there is no
 *  ExecutionContext (unit tests). Never rejects. */
function afterResponse(c: AppContext, promise: Promise<unknown>, rows: AuditRow[], actor: AuditActor): void {
  const guarded = promise.catch(async (error) => {
    await recordAuditOutage(c.env, 'audit-write', rows, actor);
    console.error('audit log failed', error);
  });
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    void guarded;
  }
}

/** Records one mutation by the signed-in user. */
export function logAudit(
  c: AppContext,
  action: string,
  entityType: string,
  entityId?: string | number,
  detail?: Record<string, unknown>,
): void {
  const row = mutationRow({ action, entityType, entityId, detail });
  const actor = actorFromUser(c.get('user'));
  afterResponse(c, statement(c.env, row, actor, requestFrom(c)).run(), [row], actor);
}

/**
 * Records many mutations by one user in a single DB.batch — one round trip for
 * a whole bulk action instead of an INSERT per page. Resolves even on failure,
 * so callers can await it alongside their own work; the caller decides whether
 * to wait.
 */
export function logAuditBatch(env: Env, user: JWTPayload | undefined, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return Promise.resolve();
  const actor = actorFromUser(user);
  const rows = entries.map(mutationRow);
  return env.DB.batch(rows.map((row) => statement(env, row, actor, NO_REQUEST)))
    .then(() => undefined)
    .catch(async (error) => { await recordAuditOutage(env, 'audit-write', rows, actor); console.error('audit log failed', error); });
}

/**
 * Records mutations a contributor performed on its own behalf: no signed-in
 * user, the contributor id in acting_via. Attributing these to the user a
 * plugin acts for comes with plugin read logging.
 */
export function logAuditBatchVia(c: AppContext, via: string, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return Promise.resolve();
  const actor = actorFromUser(undefined, via);
  const request = requestFrom(c);
  const rows = entries.map(mutationRow);
  return c.env.DB.batch(rows.map((row) => statement(c.env, row, actor, request)))
    .then(() => undefined)
    .catch(async (error) => { await recordAuditOutage(c.env, 'audit-write', rows, actor); console.error('audit log failed', error); });
}

/** What an authentication event knows about its actor. A failed sign-in that
 *  never resolved an account leaves all three unset, which is honest: there is
 *  no internal id to attribute it to, and the attempted address must not be
 *  written here. */
export interface AuthActorInput {
  userId?: string | number | null;
  roles?: string | null;
  sessionSid?: string | null;
}

/**
 * Records an authentication or access-control event: sign-in, sign-out, a
 * rejected token rotation, a permission denial. These sit outside the admin
 * routes, so the actor is passed explicitly rather than read from the context —
 * during a sign-in there is no signed-in user yet.
 */
export function logAuthEvent(
  c: AppContext,
  action: string,
  opts: AuthActorInput & { outcome?: Outcome; detail?: Record<string, unknown> } = {},
): void {
  const actor: AuditActor = opts.userId === undefined || opts.userId === null
    ? NO_ACTOR
    : {
      userId: String(opts.userId),
      roles: opts.roles ?? null,
      sessionSid: opts.sessionSid ?? null,
      via: null,
    };
  const row: AuditRow = {
    action,
    eventClass: 'auth',
    retentionClass: 'auth',
    outcome: opts.outcome ?? 'success',
    dataClass: 'none',
    targetType: null,
    targetId: null,
    targetIds: null,
    targetCount: null,
    containerKey: null,
    queryFingerprint: null,
    detail: opts.detail ?? null,
  };
  afterResponse(c, statement(c.env, row, actor, requestFrom(c)).run(), [row], actor);
}

/** The signed-in user as an audit actor, or an actor-less one off an
 *  unauthenticated route. */
export function contextActor(c: AppContext, via: string | null = null): AuditActor {
  return actorFromUser(c.get('user') as JWTPayload | undefined, via);
}

/**
 * Writes pre-resolved rows in one batch. Used by the access-log middleware,
 * which has already decided each row's class and retention.
 *
 * `strict` is what makes ePHI fail closed: it rethrows so the caller can refuse
 * to serve a record it could not account for. Without it the write is
 * best-effort, like every other audit write.
 */
export async function writeAuditRows(
  c: AppContext,
  rows: AuditRow[],
  actor: AuditActor,
  strict = false,
): Promise<void> {
  if (!rows.length) return;
  const request = requestFrom(c);
  const statements = rows.map((row) => statement(c.env, row, actor, request));
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    await recordAuditOutage(c.env, 'audit-write', rows, actor);
    if (strict) throw error;
    console.error('audit log failed', error);
  }
}

/** Awaitable off-request writer for jobs, ingestion and pre-disclosure events. */
export async function writeBackgroundAuditRows(env: Env, rows: AuditRow[], actor: AuditActor, strict = true): Promise<void> {
  if (!rows.length) return;
  try { await env.DB.batch(rows.map(row => statement(env, row, actor, NO_REQUEST))); }
  catch (error) {
    await recordAuditOutage(env, 'audit-write', rows, actor);
    if (strict) throw error;
    console.error('background audit log failed', error);
  }
}
