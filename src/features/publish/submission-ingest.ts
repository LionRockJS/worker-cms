import type { SubmissionIngestAuthority } from '../publication';
import { auditBackgroundReads } from '../../core/http/access-log';
import { serviceMutationAuditEvidence, type AuditActor } from '../../core/db/audit';
import { classificationPolicyGuard, classFor, resolveDataClasses } from '../../core/db/data-classes';
import { abortIf } from '../../core/db/transaction-guard';
import { fingerprint, guard, json, resultGuard, snapshot } from '../../core/db/bounded-mutation';
import { NEXT_SNAPSHOT_ID_SQL } from '../../core/pages/snapshot-id';
import { readD1PageSource } from './d1';
import { liveSourceReads } from './read-audit';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
// ============================================================
// Generic submission ingest — published DB → draft pages.
//
// Any page that exists in the published D1 but has no draft row with the same
// uuid is a submission, regardless of its page type or which public Worker
// created it. This module mirrors those rows into draft so they are versioned,
// auditable, and visible to plugins; creating the draft copy fires the
// dedicated `submission` lifecycle hook.
//
// Idempotency: the draft copy keeps the source row's uuid, so the draft
// `uuid` unique constraint makes re-ingest a no-op. Progress is tracked by a
// (created_at, uuid) cursor in the settings table. A pass that reaches the
// end leaves the cursor there, so idle cron ticks read nothing and write
// nothing; the full re-scan restarts once REPASS_MS after that pass ended.
// Ingest never mutates or
// deletes a published row; purging a mirror erases its source separately
// (submission-erasure.ts).
//
// Budget: creates per run are capped so one invocation (cron tick or
// /__cms/ingest/submissions call) stays well inside the subrequest budget —
// the next run resumes from the cursor.
// ============================================================

import type { Env } from '../../types';
import { coreExtensions } from '../../core/extensions';

const CURSOR_SETTING_KEY = 'submissions.ingest.cursor';
/** Rows scanned from the published DB per run. */
const SCAN_LIMIT = 40;
/** Draft pages created per run (each can generate a hook delivery). */
const MAX_CREATES_PER_RUN = 8;
/** How long a completed pass stands before the scan restarts from the top. */
const REPASS_MS = 24 * 60 * 60 * 1000;

interface LiveSubmissionRow {
  uuid: string;
  created_at: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_type: string | null;
  lect: string | null;
  page_id: number | null;
}

export interface IngestResult {
  /** Rows read past the cursor this run. */
  scanned: number;
  /** Draft pages created (rows already in draft are skipped silently). */
  created: number;
  /** True when the caller should run another batch (cap reached or scan restarted). */
  more: boolean;
}

interface Cursor {
  created_at: string;
  uuid: string;
  /** When the pass that left this cursor reached the end of the published DB. */
  passed_at?: string;
}

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { created_at: '', uuid: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return {
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
      uuid: typeof parsed.uuid === 'string' ? parsed.uuid : '',
      ...(typeof parsed.passed_at === 'string' ? { passed_at: parsed.passed_at } : {}),
    };
  } catch {
    return { created_at: '', uuid: '' };
  }
}

const CURSOR_FIELDS = ['key', 'value', 'created_at', 'updated_at'];
const PAGE_FIELDS = ['uuid', 'created_at', 'name', 'slug', 'weight', 'start', 'end', 'timezone', 'page_type', 'lect', 'page_id'] as const;
const IDENTITY_FIELDS = ['id', 'uuid', 'page_type'];
type DraftIdentity = { id: number; uuid: string; page_type: string | null };
const UUID_SET = 'uuid IN (SELECT value FROM json_each(?))';
const ID_SET = 'id IN (SELECT value FROM json_each(?))';

export async function ingestSubmissions(
  env: Env,
  actor: AuditActor = { userId: null, roles: null, sessionSid: null, via: 'system:submission-ingest' },
  authority?: SubmissionIngestAuthority,
): Promise<IngestResult> {
  assertRegulatedWritesAllowed(env);
  const result = { scanned: 0, created: 0, more: false };
  if (!env.PUBLISHED_DB) return result;

  const db = env.DB;
  const context = { env };
  const policy = await resolveDataClasses(env, true);
  if (!policy.ok) throw new Error('Submission classification unavailable');
  const cursorArgs = [CURSOR_SETTING_KEY];
  const cursorRows = await snapshot<{ value: string; created_at: string }>(context, 'settings', CURSOR_FIELDS, 'key=?', cursorArgs);
  const cursor = parseCursor(cursorRows[0]?.value ?? null);
  const source = await readD1PageSource<LiveSubmissionRow>(env.PUBLISHED_DB, 'submission',
    'p.created_at > ? OR (p.created_at = ? AND p.uuid > ?)', [cursor.created_at, cursor.created_at, cursor.uuid, SCAN_LIMIT],
    'ORDER BY p.created_at ASC, p.uuid ASC LIMIT ?');
  const sourceRows = source.rows;
  let nextCursor: Cursor | undefined;
  if (!sourceRows.length && (cursor.created_at || cursor.uuid)) {
    const passedAt = Date.parse(cursor.passed_at ?? '');
    if (!Number.isFinite(passedAt)) {
      nextCursor = { ...cursor, passed_at: new Date().toISOString() };
    } else if (Date.now() - passedAt >= REPASS_MS) {
      nextCursor = { created_at: '', uuid: '' };
      result.more = true;
    }
  }

  const authorityChecks = () => [...(authority?.check() ?? []), classificationPolicyGuard(env, policy)];
  if (!sourceRows.length && !nextCursor) {
    if (authority) await db.batch(authorityChecks());
    return result;
  }

  const uuidArgs = [json(sourceRows.map(row => row.uuid))];
  const parentArgs = [json([...new Set(sourceRows.flatMap(row => row.page_id === null ? [] : [row.page_id]))])];
  const hasTrash = !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trash_pages'").first();
  const [drafts, erased, trashed, parents] = await Promise.all([
    snapshot<DraftIdentity>(context, 'pages', IDENTITY_FIELDS, UUID_SET, uuidArgs),
    snapshot<{ uuid: string }>(context, 'submission_erasures', ['uuid'], UUID_SET, uuidArgs),
    hasTrash ? snapshot<DraftIdentity>(context, 'trash_pages', IDENTITY_FIELDS, UUID_SET, uuidArgs) : [],
    snapshot<DraftIdentity>(context, 'pages', IDENTITY_FIELDS, ID_SET, parentArgs),
  ]);
  const floorArgs = [json([...new Set([...sourceRows, ...parents].map(row => row.uuid))])];
  const floors = await snapshot<{ uuid: string; level: number }>(context, 'page_sensitivity_floors', ['uuid', 'level'], UUID_SET, floorArgs);
  if (floors.some(floor => floor.level !== 1 && floor.level !== 2)) throw new Error('Invalid submission floor');
  const blocked = new Set([...drafts, ...erased, ...trashed].map(row => row.uuid));
  const parentIds = new Set(parents.map(row => row.id));
  const plans: Array<LiveSubmissionRow & { versionUuid: string }> = [];
  for (const row of sourceRows) {
    if (plans.length >= MAX_CREATES_PER_RUN) break;
    result.scanned++;
    if (!blocked.has(row.uuid)) {
      plans.push({ ...row, page_id: row.page_id !== null && parentIds.has(row.page_id) ? row.page_id : null, versionUuid: crypto.randomUUID() });
    }
  }
  if (sourceRows.length) {
    const last = sourceRows[result.scanned - 1];
    result.more = result.scanned < sourceRows.length || sourceRows.length === SCAN_LIMIT;
    const passedAt = cursor.passed_at ?? (result.more ? undefined : new Date().toISOString());
    nextCursor = { created_at: last.created_at, uuid: last.uuid, ...(passedAt ? { passed_at: passedAt } : {}) };
  }

  const reads = await liveSourceReads(env, { id: 'd1' }, source.provenance, actor, 'submission.ingest-read');
  const evidence = await auditBackgroundReads(env, reads, actor, { exact: true });
  const expectedFloors = new Map(floors.map(floor => [floor.uuid, floor.level]));
  for (const read of evidence) {
    if (read.dataClass === 'none') continue;
    for (const uuid of read.targetIds ?? (read.targetId ? [read.targetId] : [])) {
      expectedFloors.set(uuid, Math.max(expectedFloors.get(uuid) ?? 0, read.dataClass === 'phi' ? 2 : 1));
    }
  }

  const classes = [
    authority?.dataClass,
    ...evidence.map(row => row.dataClass),
    ...[...drafts, ...parents, ...trashed].map(row => classFor(policy, 'page_type', row.page_type ?? 'default')),
    ...['pages', 'page_versions', 'settings', 'submission_erasures', 'page_sensitivity_floors', 'audit_events',
      ...(hasTrash ? ['trash_pages'] : [])].map(table => classFor(policy, 'table', table)),
  ];
  const dataClass: 'none' | 'pii' | 'phi' = [...expectedFloors.values()].includes(2) || classes.includes('phi') ? 'phi'
    : expectedFloors.size || classes.includes('pii') ? 'pii' : 'none';
  const minimumClass = dataClass === 'none' ? undefined : dataClass;
  await auditBackgroundReads(env, [
    { action: 'submission.ingest-cursor-read', kind: 'table', key: 'settings', targetType: 'settings', ids: cursorRows.length ? cursorArgs : [], count: cursorRows.length, minimumClass },
    { action: 'submission.ingest-destination-read', kind: 'table', key: 'pages', targetType: 'page', ids: [...drafts, ...parents].map(row => String(row.id)), count: drafts.length + parents.length, minimumClass },
    { action: 'submission.ingest-protection-read', kind: 'table', key: 'page_sensitivity_floors', targetType: 'page', ids: floors.map(row => row.uuid), count: floors.length, minimumClass },
    { action: 'submission.ingest-erasure-read', kind: 'table', key: 'submission_erasures', targetType: 'page', ids: erased.map(row => row.uuid), count: erased.length, minimumClass },
    ...(hasTrash ? [{ action: 'submission.ingest-trash-read', kind: 'table' as const, key: 'trash_pages', targetType: 'page', ids: trashed.map(row => row.uuid), count: trashed.length, minimumClass }] : []),
  ], actor, { exact: true });

  const clock = await db.prepare('SELECT CURRENT_TIMESTAMP AS now').first<{ now: string }>();
  if (!clock) throw new Error('Submission clock unavailable');
  const stateChecks = () => [
    guard(context, 'pages', IDENTITY_FIELDS, parents, ID_SET, parentArgs),
    guard(context, 'submission_erasures', ['uuid'], erased, UUID_SET, uuidArgs),
    abortIf(env, "(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='trash_pages')<>?", [hasTrash ? 1 : 0]),
    ...(hasTrash ? [guard(context, 'trash_pages', IDENTITY_FIELDS, trashed, UUID_SET, uuidArgs)] : []),
  ];
  const statements = [
    ...authorityChecks(),
    ...stateChecks(),
    guard(context, 'settings', CURSOR_FIELDS, cursorRows, 'key=?', cursorArgs),
    guard(context, 'pages', IDENTITY_FIELDS, drafts, UUID_SET, uuidArgs),
    guard(context, 'page_sensitivity_floors', ['uuid', 'level'], floors, UUID_SET, floorArgs),
  ];
  const raisedFloors = [...expectedFloors].filter(([uuid, level]) => !floors.some(floor => floor.uuid === uuid && floor.level === level));
  if (raisedFloors.length) {
    statements.push(db.prepare(`INSERT INTO page_sensitivity_floors(uuid,level)
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?) WHERE true
      ON CONFLICT(uuid) DO UPDATE SET level=MAX(page_sensitivity_floors.level,excluded.level)`).bind(json(raisedFloors)));
  }

  for (const plan of plans) {
    statements.push(
      db.prepare(`INSERT INTO pages (${PAGE_FIELDS.join(',')}) VALUES (${PAGE_FIELDS.map(() => '?').join(',')})`)
        .bind(plan.uuid, plan.created_at, plan.name, plan.slug, plan.weight, plan.start, plan.end, plan.timezone, plan.page_type, plan.lect, plan.page_id),
      abortIf(env, 'changes()<>1'),
      db.prepare(`INSERT INTO page_versions (id,uuid,page_id,lect,action)
        VALUES (${NEXT_SNAPSHOT_ID_SQL},?,(SELECT id FROM pages WHERE uuid=?),?,'ingest-submission')`)
        .bind(plan.versionUuid, plan.uuid, plan.lect),
      abortIf(env, 'changes()<>1'),
    );
  }
  const cursorValue = json(nextCursor);
  statements.push(db.prepare(`INSERT INTO settings(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(CURSOR_SETTING_KEY, cursorValue),
    abortIf(env, 'changes()<>1'));

  const operationId = crypto.randomUUID();
  const detail = { ...authority?.detail, operation_id: operationId, source: 'published_d1' };
  const receipts = plans.map(plan => serviceMutationAuditEvidence(env, {
    action: 'submission.ingest', entityType: 'page', entityId: plan.uuid,
    detail: { ...detail, version_uuid: plan.versionUuid, parent_id: plan.page_id },
  }, actor, dataClass, policy));
  receipts.push(serviceMutationAuditEvidence(env, {
    action: 'submission.ingest.batch', entityType: 'submission_ingest_operation', entityId: operationId,
    detail: {
      ...detail, scanned: result.scanned, more: result.more,
      cursor_before_fingerprint: await fingerprint(cursorRows[0]?.value ?? ''),
      cursor_after_fingerprint: await fingerprint(cursorValue),
      created_uuids: plans.map(plan => plan.uuid),
      skipped_uuids: sourceRows.slice(0, result.scanned).filter(row => blocked.has(row.uuid)).map(row => row.uuid),
    },
  }, actor, dataClass, policy));
  for (const receipt of receipts) statements.push(receipt.write, receipt.guard);

  const plannedArgs = [json(plans.map(plan => plan.uuid))];
  statements.push(
    ...stateChecks(),
    ...authorityChecks(),
    guard(context, 'pages', IDENTITY_FIELDS, drafts, `${UUID_SET} AND uuid NOT IN (SELECT value FROM json_each(?))`, [...uuidArgs, ...plannedArgs]),
    guard(context, 'page_sensitivity_floors', ['uuid', 'level'], [...expectedFloors].map(([uuid, level]) => ({ uuid, level })), UUID_SET, floorArgs),
    resultGuard(context, 'settings', CURSOR_FIELDS, [{ key: CURSOR_SETTING_KEY, value: cursorValue, created_at: cursorRows[0]?.created_at ?? null, updated_at: null }], clock.now, 'key=?', cursorArgs),
    abortIf(env, `EXISTS(SELECT 1 FROM pages WHERE ${UUID_SET} AND (typeof(id)<>'integer' OR id NOT BETWEEN 1 AND 9007199254740991))
      OR EXISTS(SELECT 1 FROM page_tags JOIN pages ON pages.id=page_tags.page_id WHERE pages.${UUID_SET})`, [...plannedArgs, ...plannedArgs]),
  );
  for (const plan of plans) {
    statements.push(abortIf(env, `NOT EXISTS(SELECT 1 FROM pages
        WHERE ${PAGE_FIELDS.map(field => `${field} IS ?`).join(' AND ')}
        AND creator IS NULL AND editors IS NULL AND updated_at BETWEEN ? AND CURRENT_TIMESTAMP)
      OR (SELECT COUNT(*) FROM page_versions WHERE page_id=(SELECT id FROM pages WHERE uuid=?))<>1
      OR NOT EXISTS(SELECT 1 FROM page_versions JOIN pages ON pages.id=page_versions.page_id
        WHERE pages.uuid=? AND page_versions.uuid=? AND page_versions.lect IS ? AND action='ingest-submission'
        AND typeof(page_versions.id)='integer' AND page_versions.id BETWEEN 1 AND 9007199254740991
        AND page_versions.created_at BETWEEN ? AND CURRENT_TIMESTAMP AND page_versions.updated_at BETWEEN ? AND CURRENT_TIMESTAMP)`,
    [...PAGE_FIELDS.map(field => plan[field]), clock.now, plan.uuid, plan.uuid, plan.versionUuid, plan.lect, clock.now, clock.now]));
  }
  statements.push(...receipts.map(receipt => receipt.guard),
    db.prepare(`SELECT id,uuid,name,slug,page_type FROM pages WHERE ${UUID_SET} ORDER BY created_at,uuid`).bind(...plannedArgs));
  const committed = await db.batch(statements);
  const pages = committed.at(-1)!.results as Array<{ id: number; uuid: string; page_type: string | null; name: string; slug: string }>;
  result.created = pages.length;
  for (const page of pages) {
    await coreExtensions().notifyPageEvent?.(env, undefined, 'submission', [page], actor);
  }
  return result;
}
