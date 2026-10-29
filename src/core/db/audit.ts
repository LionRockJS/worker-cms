// ============================================================
// Audit logging.
//
// Everything recorded goes into one stream, audit_events. Today that is the
// admin mutations that used to be written to audit_log; reads, authentication
// and exports join them in later phases. See
// docs/access-logging-design-2026-10-29.md.
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
// break the mutation it records. Detail payloads should stay small (slugs,
// filenames) — never content bodies.
// ============================================================

import type { Env, JWTPayload } from '../../types';
import type { AppContext } from '../http/context';

/** Entity types whose changes are configuration rather than content. They get
 *  the longer `admin_config` retention: low volume, high forensic value. */
const ADMIN_ENTITY_TYPES = new Set([
  'user', 'role', 'plugin', 'settings', 'locale', 'shared_credits', 'page_type', 'block_type',
]);

/** Longest user-agent we keep; the full string is unbounded and adds nothing. */
const USER_AGENT_LIMIT = 256;

/** One recorded action. */
export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | number;
  detail?: Record<string, unknown>;
  outcome?: 'success' | 'denied' | 'error';
}

/** Who the action is attributed to. A contributor acting on its own behalf has
 *  no user, which is why actor_user_id is nullable. */
interface AuditActor {
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

const INSERT = `INSERT INTO audit_events
    (event_id, occurred_at, event_class, retention_class, action, outcome,
     actor_user_id, actor_roles, acting_via, session_sid, request_id, source_ip, user_agent,
     target_type, target_id, target_count, detail)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function statement(env: Env, entry: AuditEntry, actor: AuditActor, request: AuditRequest) {
  const eventClass = ADMIN_ENTITY_TYPES.has(entry.entityType) ? 'admin' : 'mutation';
  const hasTarget = entry.entityId !== undefined && entry.entityId !== null;
  return env.DB.prepare(INSERT).bind(
    crypto.randomUUID(),
    new Date().toISOString(),
    eventClass,
    eventClass === 'admin' ? 'admin_config' : 'content_mutation',
    entry.action,
    entry.outcome ?? 'success',
    actor.userId,
    actor.roles,
    actor.via,
    actor.sessionSid,
    request.requestId,
    request.sourceIp,
    request.userAgent,
    entry.entityType,
    hasTarget ? String(entry.entityId) : null,
    hasTarget ? 1 : null,
    entry.detail ? JSON.stringify(entry.detail) : null,
  );
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
function afterResponse(c: AppContext, promise: Promise<unknown>): void {
  const guarded = promise.catch((error) => console.error('audit log failed', error));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    void guarded;
  }
}

/** Records one action by the signed-in user. */
export function logAudit(
  c: AppContext,
  action: string,
  entityType: string,
  entityId?: string | number,
  detail?: Record<string, unknown>,
): void {
  const entry: AuditEntry = { action, entityType, entityId, detail };
  afterResponse(c, statement(c.env, entry, actorFromUser(c.get('user')), requestFrom(c)).run());
}

/**
 * Records many actions by one user in a single DB.batch — one round trip for a
 * whole bulk action instead of an INSERT per page. Resolves even on failure, so
 * callers can await it alongside their own work; the caller decides whether to
 * wait.
 */
export function logAuditBatch(env: Env, user: JWTPayload | undefined, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return Promise.resolve();
  const actor = actorFromUser(user);
  return env.DB.batch(entries.map((entry) => statement(env, entry, actor, NO_REQUEST)))
    .then(() => undefined)
    .catch((error) => console.error('audit log failed', error));
}

/**
 * Records actions a contributor performed on its own behalf: no signed-in user,
 * the contributor id in acting_via. Attributing these to the user a plugin acts
 * for comes with plugin read logging.
 */
export function logAuditBatchVia(c: AppContext, via: string, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return Promise.resolve();
  const actor = actorFromUser(undefined, via);
  const request = requestFrom(c);
  return c.env.DB.batch(entries.map((entry) => statement(c.env, entry, actor, request)))
    .then(() => undefined)
    .catch((error) => console.error('audit log failed', error));
}
