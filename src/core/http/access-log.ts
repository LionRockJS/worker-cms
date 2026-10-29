// ============================================================
// Read logging.
//
// Handlers announce what they returned; this middleware decides what is worth
// recording and writes it once. Two reasons for the indirection:
//
//   - One row per request, not per result. A 200-row list view announces one
//     read of 200 ids, which is what keeps the D1 write budget survivable and
//     the log readable.
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
} from '../db/data-classes';
import { contextActor, writeAuditRows, type AuditActor, type AuditRow } from '../db/audit';
import { wantsJsonResponse } from '../auth/guards';

/** At most this many ids go into target_ids; target_count stays authoritative. */
const TARGET_ID_CAP = 100;

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
  pages: ReadonlyArray<{ id: number | string; page_type?: string | null }>,
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
      ids: ids.slice(0, TARGET_ID_CAP),
      count: ids.length,
      queryFingerprint: opts.queryFingerprint,
      actor: opts.actor,
    });
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
    eventClass: 'read',
    dataClass,
    retentionClass: retentionClassFor(dataClass),
    outcome: 'success',
    targetType: read.targetType,
    targetId: single ? read.ids[0] : null,
    targetIds: single ? null : read.ids,
    targetCount: read.count,
    containerKey: read.key,
    queryFingerprint: read.queryFingerprint ?? null,
    detail: null,
  };
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

  const context = requestContext.getStore();
  const pending = context?.pendingReads;
  if (!context || !pending?.length) return;
  delete context.pendingReads;

  const classes = await resolveDataClasses(c.env);
  const rows: AuditRow[] = [];
  let strict = false;
  let actor: AuditActor | undefined;
  for (const read of pending) {
    const dataClass = classFor(classes, read.kind, read.key);
    if (!dataClass) continue;
    if (failsClosed(dataClass)) strict = true;
    actor ??= read.actor;
    rows.push(rowFor(read, dataClass));
  }
  if (!rows.length) return;

  if (!strict) {
    // Ordinary PII: written after the response, like every other audit write.
    const promise = writeAuditRows(c, rows, actor ?? contextActor(c));
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      void promise;
    }
    return;
  }

  // ePHI: the record has to exist before the data leaves. If the write fails
  // the response is replaced, so the rows the handler fetched are never served.
  try {
    await writeAuditRows(c, rows, actor ?? contextActor(c), true);
  } catch (error) {
    console.error('access log failed; refusing to serve the record', error);
    c.res = wantsJsonResponse(c.req.raw)
      ? Response.json({ success: false, error: 'Audit log unavailable' }, { status: 503 })
      : new Response('Audit log unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
});
