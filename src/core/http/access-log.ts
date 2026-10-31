// ============================================================
// Read logging.
//
// Handlers announce what they returned; this middleware decides what is worth
// recording and writes it once. Two reasons for the indirection:
//
//   - Reads are grouped by container rather than logged once per result.
//     Classified identifiers are split into bounded rows so none are discarded.
//   - Classification is resolved after the handler ran, in one place. A handler
//     never has to know whether what it served is regulated, so a new read
//     surface cannot forget to check.
//
// An unclassified container records nothing, so an install with no regulated
// data pays one `data_classes` query on requests that announced a read and
// writes no rows at all.
//
// See docs/access-logging-design-2026-10-29.md.
// ============================================================

import { createMiddleware } from 'hono/factory';
import type { Env, Variables } from '../../types';
import { requestContext } from './request-context';
import {
  classFor,
  failsClosed,
  resolveDataClasses,
  retentionClassFor,
  type ContainerKind,
  type DataClass,
} from '../db/data-classes';
import { contextActor, writeAuditRows, writeBackgroundAuditRows, type AuditActor, type AuditRow } from '../db/audit';
import { wantsJsonResponse } from '../auth/guards';
import type { AppContext } from './context';
import { inventoried } from './regulated-profile';
import { pageSensitivityFloors, typeSensitivityFloors } from '../db/sensitivity';

/** Bound each evidence row, preserving larger identifier sets in linked parts. */
const TARGET_ID_CAP = 100;

/** Shared read boundaries use this to withhold a response without exposing source errors. */
export class ReadAuditUnavailableError extends Error {
  constructor() { super('Sensitive read audit unavailable'); }
}

/** One announced read, before classification has been applied. */
export interface PendingRead {
  /** 'page.read' | 'page.list' | 'page.search' | 'media.read' | ... */
  action: string;
  kind: ContainerKind;
  /** The container: a page type slug, an R2 key, a contributor id. */
  key: string;
  /** 'page' | 'media' | 'query' | ... */
  targetType: string;
  ids: string[];
  /** Rows returned, which may exceed ids.length once capped. */
  count: number;
  /** Hash of the criteria for a search; never the terms themselves. */
  queryFingerprint?: string;
  /** Set by a caller that knows better than the request context — a
   *  contributor API read acting for a user. */
  actor?: AuditActor;
  /** Host-owned metadata only; never bodies, query terms or credentials. */
  detail?: Record<string, unknown>;
  eventClass?: 'read' | 'export';
  /** Trusted source sensitivity (e.g. an audit row); policy can raise it, never lower it. */
  minimumClass?: DataClass;
  /** Trusted UUID provenance for deferred metadata whose draft ID may be gone. */
  uuidById?: Record<string, string>;
}

function buffer(): PendingRead[] | undefined {
  const context = requestContext.getStore();
  if (!context) return undefined;
  context.pendingReads ??= [];
  return context.pendingReads;
}

/**
 * Announces that this request returned rows from a container. Cheap and
 * synchronous: it appends to the buffer on the request context and decides
 * nothing. Outside a request context it is a no-op.
 */
export function recordRead(read: PendingRead): void {
  buffer()?.push(read);
}

/**
 * Announces a set of pages, one entry per page type. A mixed list produces one
 * row per classified type — "read 12 patient_note rows" — rather than one row
 * for the whole page, which would be unattributable to a container, or one per
 * result, which would be unreadable.
 */
export function recordPageReads(
  action: string,
  pages: ReadonlyArray<{ id: number | string; uuid?: string; page_type?: string | null }>,
  opts: { actor?: AuditActor; queryFingerprint?: string } = {},
): void {
  if (!pages.length) return;
  const byType = new Map<string, string[]>();
  for (const page of pages) {
    const type = page.page_type ?? 'default';
    const ids = byType.get(type) ?? [];
    ids.push(String(page.id));
    byType.set(type, ids);
  }
  for (const [type, ids] of byType) {
    recordRead({
      action,
      kind: 'page_type',
      key: type,
      targetType: 'page',
      ids,
      count: ids.length,
      queryFingerprint: opts.queryFingerprint,
      actor: opts.actor,
      uuidById: Object.fromEntries(pages.filter(page => (page.page_type ?? 'default') === type && page.uuid).map(page => [String(page.id), page.uuid!])),
    });
  }
}

/** Taxonomy labels and tag values are sensitive even outside page reads. */
export function recordTagReads(action: string, tags: ReadonlyArray<{ id: string | number; taxonomy_slug?: string | null }>, actor?: AuditActor): void {
  const groups = new Map<string, Set<string>>();
  for (const tag of tags) {
    const key = tag.taxonomy_slug ?? 'default';
    const ids = groups.get(key) ?? new Set<string>();
    ids.add(String(tag.id));
    groups.set(key, ids);
  }
  for (const [key, ids] of groups) recordRead({ action, kind: 'taxonomy', key, targetType: 'tag', ids: [...ids], count: ids.size, actor });
}

export function recordTaxonomyReads(action: string, taxonomies: ReadonlyArray<{ slug: string }>, actor?: AuditActor): void {
  for (const { slug } of taxonomies) recordRead({ action, kind: 'taxonomy', key: slug, targetType: 'taxonomy', ids: [slug], count: 1, actor });
}

export function recordTableReads(action: string, table: string, ids: ReadonlyArray<string | number>, actor?: AuditActor): void {
  if (!ids.length) return;
  const unique = [...new Set(ids.map(String))];
  recordRead({ action, kind: 'table', key: table, targetType: table, ids: unique, count: unique.length, actor });
}

/** Shared metadata loaders may be used several times in one render. Keep one
 * identifier set per source/action/actor, including an empty lookup. No values. */
export function recordMetadataReads(action: string, table: string, ids: ReadonlyArray<string | number>, targetType = table): void {
  const pending = buffer();
  if (!pending) return;
  const previous = pending.find(read => read.action === action && read.kind === 'table' && read.key === table && read.targetType === targetType && !read.actor);
  const unique = [...new Set([...(previous?.ids ?? []), ...ids.map(String)])];
  if (previous) { previous.ids = unique; previous.count = unique.length; }
  else recordRead({ action, kind: 'table', key: table, targetType, ids: unique, count: unique.length });
}

export function recordContributorReads(action: string, ids: readonly string[]): void {
  for (const key of new Set(ids)) {
    const pending = buffer();
    if (!pending || pending.some(read => read.action === action && read.kind === 'plugin' && read.key === key && !read.actor)) continue;
    recordRead({ action, kind: 'plugin', key, targetType: 'plugin_metadata', ids: [key], count: 1 });
  }
}

/** Flush before a plugin/service side effect, not only before the HTTP reply. */
export async function flushReadAudit(c: AppContext, disclosure?: { destination: string; operation: string }): Promise<Response | null> {
  const context = requestContext.getStore();
  const pending = context?.pendingReads;
  if (!context || !pending?.length) return null;
  delete context.pendingReads;
  const detail = disclosure ? { ...disclosure, delivery_id: crypto.randomUUID(), phase: 'intent' } : undefined;
  const reads = detail ? pending.map(read => ({ ...read, detail: { ...read.detail, ...detail }, eventClass: 'export' as const })) : pending;
  try { await auditReads(c, reads, !!disclosure); return null; }
  catch (error) {
    console.error('access log unavailable; refusing disclosure', error);
    return auditUnavailable(c);
  }
}

/**
 * A stable, non-reversible token for a set of search criteria. The terms
 * themselves are never stored — in a CMS holding regulated data a search string
 * is frequently the identifier being searched for.
 */
export async function queryFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function rowFor(read: PendingRead, dataClass: 'pii' | 'phi'): AuditRow {
  const single = read.ids.length === 1 && read.count === 1;
  return {
    action: read.action,
    eventClass: read.eventClass ?? 'read',
    dataClass,
    retentionClass: retentionClassFor(dataClass),
    outcome: 'success',
    targetType: read.targetType,
    targetId: single ? read.ids[0] : null,
    targetIds: single ? null : read.ids.slice(0, TARGET_ID_CAP),
    targetCount: read.count,
    containerKey: read.key,
    queryFingerprint: read.queryFingerprint ?? null,
    detail: read.detail ?? null,
  };
}

/** Build the same classified evidence for HTTP and background work. */
export async function prepareReadAudits(env: Env, pending: PendingRead[], fallbackActor: AuditActor, fresh = false) {
  const classes = await resolveDataClasses(env, fresh);
  if (!classes.ok) throw new Error('Classification unavailable');
  // A tag association can itself be PHI even when the page type is public.
  // Expand before the output ID cap so later results are not silently missed.
  const reads: PendingRead[] = [];
  type FloorSource = Parameters<typeof pageSensitivityFloors>[2];
  const sourceFor = (read: PendingRead): FloorSource => read.kind !== 'page_type' ? undefined : read.targetType === 'page' ? (read.action.startsWith('page.trash') ? 'trash_pages' : 'pages')
    : read.targetType === 'page_version' ? 'page_versions' : ['published_page', 'live_page'].includes(read.targetType) ? 'uuid' : undefined;
  const sourceIds = new Map<Exclude<FloorSource, undefined>, Set<string>>();
  for (const read of pending) {
    const source = sourceFor(read);
    if (source && !read.ids.every(id => read.uuidById?.[id])) sourceIds.set(source, new Set([...(sourceIds.get(source) ?? []), ...read.ids]));
    if (read.uuidById) sourceIds.set('uuid', new Set([...(sourceIds.get('uuid') ?? []), ...Object.values(read.uuidById)]));
  }
  const bySource = new Map<FloorSource, Map<string, DataClass>>();
  for (const [source, ids] of sourceIds) bySource.set(source, await pageSensitivityFloors(env, [...ids], source));
  const queries = pending.filter(read => read.kind === 'page_type' && read.targetType === 'query');
  const typeFloors = await typeSensitivityFloors(env, queries.filter(read => !read.action.startsWith('page.trash')).map(read => read.key));
  const trashFloors = await typeSensitivityFloors(env, queries.filter(read => read.action.startsWith('page.trash')).map(read => read.key), true);
  for (const read of pending) {
    if (read.kind === 'page_type' && read.targetType === 'query') {
      const floor = (read.action.startsWith('page.trash') ? trashFloors : typeFloors).get(read.key);
      reads.push({ ...read, minimumClass: floor === 'phi' || read.minimumClass === 'phi' ? 'phi' : floor ?? read.minimumClass });
      continue;
    }
    const source = sourceFor(read);
    if (!source || !read.ids.length) { reads.push(read); continue; }
    const floors = bySource.get(source) ?? new Map<string, DataClass>();
    const hasUuidFloor = Object.values(read.uuidById ?? {}).some(uuid => bySource.get('uuid')?.has(uuid));
    if (!floors.size && !hasUuidFloor) { reads.push(read); continue; }
    if (read.count !== read.ids.length) throw new Error('Floored read identifier manifest incomplete');
    const partitions = new Map<DataClass | undefined, string[]>();
    for (const id of read.ids) {
      const uuidFloor = read.uuidById?.[id] ? bySource.get('uuid')?.get(read.uuidById[id]) : undefined;
      const floor = floors.get(id) === 'phi' || uuidFloor === 'phi' ? 'phi' : floors.get(id) ?? uuidFloor;
      const minimum = floor === 'phi' || read.minimumClass === 'phi' ? 'phi' : floor ?? read.minimumClass;
      const ids = partitions.get(minimum) ?? []; ids.push(id); partitions.set(minimum, ids);
    }
    for (const [minimumClass, ids] of partitions) reads.push({ ...read, ids, count: ids.length, minimumClass });
  }
  if (env.REGULATED_MODE === 'true' || [...classes.exact.keys()].some(key => key.startsWith('taxonomy:'))) {
    for (const read of pending) {
      if (read.kind !== 'page_type' || !['page', 'published_page'].includes(read.targetType) || !read.ids.length) continue;
      const published = read.targetType === 'published_page';
      const db = published ? env.PUBLISHED_DB : env.DB;
      if (!db) throw new Error('Page classification source unavailable');
      const links = await db.prepare(`SELECT DISTINCT ${published ? 'p.uuid' : 'pt.page_id'} AS page_id, t.taxonomy_slug, t.id AS tag_id
        FROM ${read.action.startsWith('page.trash') ? 'trash_page_tags' : 'page_tags'} pt LEFT JOIN tags t ON t.id = pt.tag_id
        ${published ? 'JOIN pages p ON p.id = pt.page_id' : ''}
        WHERE ${published ? 'p.uuid' : 'pt.page_id'} IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(read.ids))
        .all<{ page_id: number | string; taxonomy_slug: string | null; tag_id: number | null }>();
      const groups = new Map<string, Set<string>>();
      for (const link of links.results) {
        if (link.tag_id === null) throw new Error('Page taxonomy source unavailable');
        const key = link.taxonomy_slug ?? 'default';
        if (!inventoried(env, 'taxonomy', key)) throw new Error('Taxonomy not inventoried');
        if (!classFor(classes, 'taxonomy', key)) continue;
        const ids = groups.get(key) ?? new Set<string>();
        ids.add(String(link.page_id));
        groups.set(key, ids);
      }
      for (const [key, ids] of groups) reads.push({ ...read, kind: 'taxonomy', key, ids: [...ids], count: ids.size });
    }
  }
  // Keep attribution per event: a request can contain more than one actor.
  const groups = new Map<string, { actor: AuditActor; rows: AuditRow[]; strict: boolean }>();
  for (const read of reads) {
    if (!inventoried(env, read.kind, read.key)) throw new Error('Container not inventoried');
    const policyClass = classFor(classes, read.kind, read.key);
    const dataClass = policyClass === 'phi' || read.minimumClass === 'phi' ? 'phi' : policyClass ?? read.minimumClass;
    if (!dataClass) continue;
    if (read.eventClass === 'export' && read.targetType !== 'query' && read.count !== read.ids.length) {
      throw new Error('Export identifier manifest incomplete');
    }
    const actor = read.actor ?? requestContext.getStore()?.readActor ?? fallbackActor;
    const key = JSON.stringify(actor);
    let group = groups.get(key);
    if (!group) {
      group = { actor, rows: [], strict: false };
      groups.set(key, group);
    }
    if (read.ids.length > TARGET_ID_CAP) {
      // Keep every classified identifier without an unbounded audit row.
      // Each chunk contributes its own count, so monitoring totals stay correct.
      const manifestId = crypto.randomUUID();
      const parts = Math.ceil(read.ids.length / TARGET_ID_CAP);
      for (let offset = 0; offset < read.ids.length; offset += TARGET_ID_CAP) {
        const ids = read.ids.slice(offset, offset + TARGET_ID_CAP);
        const extra = offset + TARGET_ID_CAP >= read.ids.length ? Math.max(0, read.count - read.ids.length) : 0;
        group.rows.push(rowFor({ ...read, ids, count: ids.length + extra, detail: { ...read.detail,
          manifest_id: manifestId, manifest_part: offset / TARGET_ID_CAP + 1, manifest_parts: parts,
          manifest_id_count: read.ids.length, manifest_target_count: read.count, manifest_complete: read.ids.length === read.count,
        } }, dataClass));
      }
    } else group.rows.push(rowFor(read, dataClass));
    group.strict ||= failsClosed(dataClass);
  }
  return [...groups.values()];
}

export async function auditBackgroundReads(env: Env, pending: PendingRead[], actor: AuditActor): Promise<AuditRow[]> {
  const groups = await prepareReadAudits(env, pending, actor, true);
  for (const group of groups) {
    await writeBackgroundAuditRows(env, group.rows, group.actor, group.strict || group.rows.some(row => row.eventClass === 'export'));
  }
  return groups.flatMap(group => group.rows);
}

export async function auditReads(c: AppContext, pending: PendingRead[], strict = false): Promise<void> {
  const groups = await prepareReadAudits(c.env, pending, contextActor(c), strict);
  for (const group of groups.values()) {
    if (strict || group.strict) {
      await writeAuditRows(c, group.rows, group.actor, true);
    } else {
      const promise = writeAuditRows(c, group.rows, group.actor);
      try { c.executionCtx.waitUntil(promise); } catch { await promise; }
    }
  }
}

export function auditUnavailable(c: AppContext): Response {
  return wantsJsonResponse(c.req.raw)
    ? Response.json({ success: false, error: 'Audit log unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    : new Response('Audit log unavailable', { status: 503, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}

/**
 * Drains the request's announced reads and writes the classified ones.
 *
 * Mounted globally so it covers the admin screens, the contributor API and the
 * public media routes in one place. When nothing was announced it costs a map
 * lookup.
 */
export const accessLog = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  await next();
  const refused = await flushReadAudit(c);
  if (refused) c.res = refused;
});
