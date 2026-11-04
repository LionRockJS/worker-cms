// Page creation for /__cms, shared by POST /pages and POST /pages/batch.
//
// Ids/slugs are planned up front. Durable intent precedes the optional credit
// reservation; pages, history, tags and final receipts share one guarded batch.

import type { AppContext } from '../../../core/http/context';
import type { ApiPage, PageInput, PluginAuth, PreparedCreate } from './types';
import { forbiddenPageTypeBody } from './auth';
import { asFiniteNumber, asPositiveSafeInteger, coerceLect, hasSubmittedValue } from './serialize';
import { emitPluginHooks } from './hooks';
import { blueprintToLect, mergeLects, stringifyLect } from '../../../core/db/lect';
import { resolveCmsConfig } from '../../../core/db/content-config';
import { withDraftMetadata } from '../../../core/db/page-logic';
import { slugify } from '../../../core/http/forms';
import { pageTypeScopeAllows } from '../page-types';
import { reservePageCreates, type FeatureReservation } from '../../services';
import type { PluginPageMutationAuthority } from '../page-update-evidence';
import { preparePluginPageCreates, commitPluginPageCreates, recordPluginCreateReservationRefusal, recordPluginCreateFailure, PluginPageCreateUnavailableError } from '../page-create-evidence';
import { serializePage } from './serialize';
import type { Page } from '../../../types';
import { assertRegulatedWritesAllowed } from '../../../core/http/regulated-writes';
import { recordAuditOutage } from '../../../core/db/audit-outages';

/** Largest batch accepted by POST /pages/batch — bounds D1 write volume per call. */

/** Rows per DB.batch in POST /pages/duplicate. */
/** Max children cloned in one POST /pages/duplicate request before yielding a cursor. */

/** Rows trashed per DB.batch in DELETE /pages/children. */
/** Max children trashed in one DELETE /pages/children request before yielding (done:false). */

const CMS_ID_EPOCH_OFFSET = 1563741060;

/** Body accepted by POST /pages/duplicate — clone a related collection with a transform. */

// ── Create (shared by POST /pages and POST /pages/batch) ──────────────────────

/** Per-item create failure. `status` is what a batch-of-one maps it to. */
export interface CreateItemError {
  index: number;
  error: string;
  status: number;
  page_type?: string;
  message?: string;
}

export type BatchCreateResult =
  | { ok: true; created: ApiPage[]; errors: CreateItemError[] }
  | { ok: false; status: 400 | 402 | 409; body: Record<string, unknown> };

/**
 * Legacy caller-asserted payer/attribution selector; it is not CMS-user or
 * session proof. Public flows without this selector remain uncharged in v1.
 */
export function actingUserId(c: AppContext): number | null {
  return asFiniteNumber((c.req.header('x-acting-user-id') ?? '').trim() || null);
}
export type PrepareCreateResult = { ok: true; input: PreparedCreate } | { ok: false; status: number; error: string; page_type?: string; message?: string };

export function prepareCreateInput(
  c: AppContext,
  auth: PluginAuth,
  config: Awaited<ReturnType<typeof resolveCmsConfig>>,
  input: PageInput,
): PrepareCreateResult {
  const pageType = typeof input.page_type === 'string' ? input.page_type : '';
  if (!pageType) return { ok: false, status: 400, error: 'page_type_required' };
  if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) return { ok: false, status: 403, ...forbiddenPageTypeBody(auth, pageType) };

  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim()
    : `Untitled ${pageType.replace(/[_-]/g, ' ')}`;
  const desiredSlug = typeof input.slug === 'string' && input.slug.trim()
    ? slugify(input.slug)
    : slugify(name);
  const baseSlug = desiredSlug || slugify(name) || pageType;
  const lect = stringifyLect(
    withDraftMetadata(
      mergeLects(
        blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
        coerceLect(input.lect),
      ),
      0,
    ),
  );

  const id = asPositiveSafeInteger(input.id);
  if (hasSubmittedValue(input.id) && id === null) return { ok: false, status: 400, error: 'invalid_id' };
  const tags = [...new Set(tagIds(input.tags))];
  if (tags.length > 5000 || tags.some(id => !Number.isSafeInteger(id) || id <= 0)) return { ok: false, status: 400, error: 'invalid_tags' };
  const parentId = asPositiveSafeInteger(input.page_id);
  if (hasSubmittedValue(input.page_id) && parentId === null) return { ok: false, status: 400, error: 'invalid_page_id' };

  return {
    ok: true,
    input: {
      id,
      pageType,
      name,
      baseSlug,
      lect,
      weight: asFiniteNumber(input.weight) ?? 5,
      start: typeof input.start === 'string' ? input.start : null,
      end: typeof input.end === 'string' ? input.end : null,
      timezone: typeof input.timezone === 'string' ? input.timezone : (c.env.DEFAULT_TIMEZONE ?? '+0800'),
      parentId,
      tags,
    },
  };
}

export function tagIds(tags: unknown): number[] {
  if (!Array.isArray(tags)) return [];
  return tags.map(asFiniteNumber).filter((tagId): tagId is number => tagId !== null);
}

export async function draftPageIds(db: D1DatabaseClient, ids: number[]): Promise<Set<number>> {
  const unique = [...new Set(ids)];
  const out = new Set<number>();
  for (let index = 0; index < unique.length; index += 100) {
    const chunk = unique.slice(index, index + 100);
    if (!chunk.length) continue;
    const rows = await db.prepare(`SELECT id FROM pages WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: number }>();
    for (const row of rows.results) out.add(row.id);
  }
  return out;
}

export async function reservedPageIds(db: D1DatabaseClient, ids: number[]): Promise<Set<number>> {
  const unique = [...new Set(ids)];
  const out = new Set<number>();
  // Each id is bound twice (draft + trash). Keep each statement at no more
  // than 100 SQL variables for local D1/SQLite compatibility.
  for (let index = 0; index < unique.length; index += 50) {
    const chunk = unique.slice(index, index + 50);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT id FROM pages WHERE id IN (${placeholders})
       UNION
       SELECT id FROM trash_pages WHERE id IN (${placeholders})`,
    )
      .bind(...chunk, ...chunk)
      .all<{ id: number }>();
    for (const row of rows.results) out.add(row.id);
  }
  return out;
}

/** Allocates a whole batch of page ids with one collision query in the normal
 * case, rather than spending one D1 subrequest per generated id. */
export async function generatedPageIds(db: D1DatabaseClient, count: number, usedIds: Set<number>): Promise<number[]> {
  const ids: number[] = [];
  while (ids.length < count) {
    const candidates = Array.from({ length: count - ids.length }, () => cmsId(usedIds));
    const reserved = await reservedPageIds(db, candidates);
    ids.push(...candidates.filter((id) => !reserved.has(id)));
  }
  return ids;
}

/**
 * Shared create executor behind POST /pages and POST /pages/batch: per-item
 * validation and id/parent finalization, an all-or-nothing quota check and
 * credit charge, then one DB.batch commit for the whole set. Single create is
 * a batch of one, so the two paths cannot drift apart.
 *
 * Credits: a batch of one charges the per-type action with entityType (the
 * ledger row plugins and admins expect from a single create); larger batches
 * charge one aggregate `page_create:batch` row with a per-type note.
 */
export async function createPages(c: AppContext, auth: PluginAuth, authority: PluginPageMutationAuthority, items: PageInput[]): Promise<BatchCreateResult> {
  assertRegulatedWritesAllowed(c.env);
  try { return await create(c, auth, authority, items); }
  catch (error) {
    if (error instanceof PluginPageCreateUnavailableError) throw error;
    await recordAuditOutage(c.env, 'health', [], authority.actor, undefined, { captureIncomplete: true });
    throw new PluginPageCreateUnavailableError(false);
  }
}
async function create(c: AppContext, auth: PluginAuth, authority: PluginPageMutationAuthority, items: PageInput[]): Promise<BatchCreateResult> {
  const config = await resolveCmsConfig(c.env);
  const forbiddenTypes: string[] = [];
  const prepared: PreparedCreate[] = [];
  const preparedIndexes: number[] = [];
  const created: ApiPage[] = [];
  const errors: CreateItemError[] = [];
  for (let i = 0; i < items.length; i++) {
    const result = prepareCreateInput(c, { ...auth, allowedTypes: authority.allowed }, config, items[i]);
    if (result.ok) {
      prepared.push(result.input);
      preparedIndexes.push(i);
    }
    else { errors.push({ index: i, error: result.error, status: result.status, page_type: result.page_type, message: result.message }); if (result.error === 'forbidden_page_type' && result.page_type) forbiddenTypes.push(result.page_type); }
  }

  if (!prepared.length) { await preparePluginPageCreates(c, authority, [], forbiddenTypes); return { ok: true, created, errors }; }

  const requestedIds = prepared.map((item) => item.id).filter((id): id is number => id !== null);
  const reservedIds = await reservedPageIds(c.env.DB, requestedIds);
  const usedIds = new Set<number>(requestedIds);
  const seenRequestedIds = new Set<number>();
  const actualIdByRequestedId = new Map<number, number>();
  const finalized: PreparedCreate[] = [];
  const finalizedIndexes: number[] = [];
  const allocatedIds: number[] = [];
  const generatedIds = await generatedPageIds(
    c.env.DB,
    prepared.filter((item) => item.id === null).length,
    usedIds,
  );
  let generatedIdIndex = 0;
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    if (item.id !== null) {
      if (reservedIds.has(item.id) || seenRequestedIds.has(item.id)) {
        errors.push({ index: preparedIndexes[i], error: 'id_conflict', status: 409 });
        continue;
      }
      seenRequestedIds.add(item.id);
      usedIds.add(item.id);
      actualIdByRequestedId.set(item.id, item.id);
      finalized.push(item);
      finalizedIndexes.push(preparedIndexes[i]);
      allocatedIds.push(item.id);
      continue;
    }

    const id = generatedIds[generatedIdIndex++];
    finalized.push(item);
    finalizedIndexes.push(preparedIndexes[i]);
    allocatedIds.push(id);
  }
  for (let i = 0; i < finalized.length; i++) {
    const item = finalized[i];
    finalized[i] = {
      ...item,
      parentId: item.parentId !== null && actualIdByRequestedId.has(item.parentId)
        ? actualIdByRequestedId.get(item.parentId)!
        : item.parentId,
    };
  }

  const parentIds = finalized.map((item) => item.parentId).filter((id): id is number => id !== null);
  if (parentIds.length) {
    const existingParents = await draftPageIds(c.env.DB, parentIds);
    let removedInvalidParent = true;
    while (removedInvalidParent) {
      removedInvalidParent = false;
      const allocatedIdSet = new Set(allocatedIds);
      for (let i = finalized.length - 1; i >= 0; i--) {
        const parentId = finalized[i].parentId;
        if (parentId !== null && !existingParents.has(parentId) && !allocatedIdSet.has(parentId)) {
          finalized.splice(i, 1);
          allocatedIds.splice(i, 1);
          errors.push({ index: finalizedIndexes[i], error: 'parent_not_found', status: 400 });
          finalizedIndexes.splice(i, 1);
          removedInvalidParent = true;
        }
      }
    }
  }
  if (!finalized.length) { await preparePluginPageCreates(c, authority, [], forbiddenTypes); return { ok: true, created, errors }; }

  const usedSlugs = await existingSlugSet(c.env.DB, finalized.map(item => item.baseSlug));
  const plans = finalized.map((item,index) => ({ ...item, id: allocatedIds[index], uuid: crypto.randomUUID(), slug: allocateSlug(item.baseSlug, usedSlugs) }));
  const source = await preparePluginPageCreates(c, authority, plans, forbiddenTypes);
  if (source.violation) return { ok: false, status: 409, body: { error: 'limit_exceeded', violation: source.violation } };
  const typeCounts = new Map<string,number>();
  for (const item of finalized) typeCounts.set(item.pageType,(typeCounts.get(item.pageType) ?? 0)+1);
  let reservation: FeatureReservation | undefined;
  let saved: Page[];
  try {
    reservation = await reservePageCreates(c.env, { pageTypes: [...typeCounts].map(([pageType,count]) => ({ pageType,count })), payerUserId: actingUserId(c), contributorId: auth.pluginId, operationId: source.operationId });
    if (!reservation.ok) {
      await recordPluginCreateReservationRefusal(c, source, reservation.code);
      return { ok: false, status: reservation.status, body: { error: reservation.code, ...(reservation.details ?? {}) } };
    }
    saved = await commitPluginPageCreates(c, source, reservation.charged);
  } catch (error) {
    // Refund only a known non-commit. A lost D1 acknowledgment can follow a
    // complete page/receipt commit and must never give those pages away free.
    const known = error instanceof PluginPageCreateUnavailableError ? error.rollbackKnown : true;
    let refundState = reservation?.ok ? 'not_required' : reservation ? 'refused' : 'reservation_unconfirmed';
    if (reservation?.ok && reservation.charged > 0) {
      refundState = 'withheld_commit_unknown';
      if (known) { try { await reservation.refund(); refundState = 'attempted'; } catch { refundState = 'unconfirmed'; } }
    }
    await recordPluginCreateFailure(c, source, known, refundState);
    throw error instanceof PluginPageCreateUnavailableError ? error : new PluginPageCreateUnavailableError(known);
  }
  emitPluginHooks(c, 'create', saved.map(page => ({ id: page.id, uuid: page.uuid, page_type: page.page_type, name: page.name, slug: page.slug })), auth.pluginId, { evidenceCommitted: true, actor: authority.actor });
  return { ok: true, created: saved.map(serializePage), errors };
}

export async function existingSlugSet(db: D1DatabaseClient, baseSlugs: string[]): Promise<Set<string>> {
  const bases = [...new Set(baseSlugs)];
  const out = new Set<string>();
  for (let index = 0; index < bases.length; index += 25) {
    const chunk = bases.slice(index, index + 25);
    // D1 caps LIKE/GLOB patterns at 50 bytes, which is shorter than a valid
    // generated slug (for example a shipment EDM subject). Use an indexed
    // lexical range for the `<base>-*` suffixes instead. Slugs contain only
    // [a-z0-9-], so `.` is the exclusive upper bound immediately after `-`.
    const where = chunk.map(() => '(slug = ? OR (slug >= ? AND slug < ?))').join(' OR ');
    const params = chunk.flatMap((base) => [base, `${base}-`, `${base}.`]);
    const rows = await db.prepare(`SELECT slug FROM pages WHERE ${where}`)
      .bind(...params)
      .all<{ slug: string }>();
    for (const row of rows.results) out.add(row.slug);
  }
  return out;
}

export function allocateSlug(baseSlug: string, used: Set<string>): string {
  let candidate = baseSlug;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export function cmsTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function cmsId(used: Set<number>): number {
  const random = new Uint32Array(1);
  let id = 0;
  do {
    crypto.getRandomValues(random);
    id = ((Math.floor(Date.now() / 1000) - CMS_ID_EPOCH_OFFSET) * 100000) + (random[0] % 100000);
  } while (used.has(id));
  used.add(id);
  return id;
}

export interface BulkPageRow {
  id: number;
  uuid: string;
  createdAt: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  pageType: string;
  versionId: number;
  lect: string;
  parentId: number | null;
}

/**
 * The pages + page_versions INSERT pair for one bulk-created page.
 * Ids, uuids, and timestamps are assigned by the caller so a whole batch
 * commits in a single DB.batch without per-row SELECT-backs.
 */
export function bulkPageInsertStatements(db: D1DatabaseClient, row: BulkPageRow): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO pages (id, uuid, created_at, updated_at, name, slug, weight, start, end, timezone, page_type, lect, page_id, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.uuid, row.createdAt, row.createdAt, row.name, row.slug, row.weight, row.start,
      row.end, row.timezone, row.pageType, row.lect, row.parentId, null,
    ),
    db.prepare(
      `INSERT INTO page_versions (id, uuid, created_at, updated_at, page_id, lect, action)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.versionId, crypto.randomUUID(), row.createdAt, row.createdAt, row.id, row.lect, 'create'),
  ];
}
