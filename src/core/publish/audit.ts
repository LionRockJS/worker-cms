import type { Env, Page } from '../../types';
import { writeBackgroundAuditRows, type AuditActor } from '../db/audit';
import { prepareReadAudits, type PendingRead } from '../http/access-log';
import type { PublishAdapter, PublishedTag } from './adapter';
import { auditOutboundIntent } from '../http/outbound-audit';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

/** Await disclosure intent before a publish destination receives content.
 * This is the existing read evidence pipeline, with destination attribution. */
export async function auditPublishTransfer(
  env: Env, adapter: PublishAdapter, operation: 'page' | 'tags',
  pages: Page[], tags: PublishedTag[],
  actor: AuditActor = { userId: null, roles: null, sessionSid: null, via: 'system:publish' },
): Promise<void> {
  assertRegulatedWritesAllowed(env);
  const detail = { destination: adapter.id, operation, delivery_id: crypto.randomUUID(), phase: 'intent' };
  const reads: PendingRead[] = [];
  // Parent identifiers travel in the snapshot/catalogue even when the parent
  // record itself is absent. Apply its policy before exposing that reference.
  const describedPages: Array<Pick<Page, 'id' | 'page_type'>> = [...pages];
  const pageIds = new Set(pages.map(page => page.id));
  const parents = [...new Set(pages.flatMap(page => page.page_id != null && !pageIds.has(page.page_id) ? [page.page_id] : []))];
  if (parents.length) {
    const rows = await env.DB.prepare('SELECT id, page_type FROM pages WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(parents)).all<Pick<Page, 'id' | 'page_type'>>();
    if (rows.results.length !== parents.length) throw new Error('Publish parent classification unavailable');
    describedPages.push(...rows.results);
  }
  const pageGroups = new Map<string, string[]>();
  for (const page of describedPages) {
    const key = page.page_type ?? 'default';
    const ids = pageGroups.get(key) ?? [];
    ids.push(String(page.id)); pageGroups.set(key, ids);
  }
  for (const [key, ids] of pageGroups) reads.push({ action: 'page.publish-disclosure', kind: 'page_type', key,
    targetType: 'page', ids, count: ids.length, detail, eventClass: 'export' });
  const describedTags: Array<Pick<PublishedTag, 'id' | 'taxonomy_slug'>> = [...tags];
  const tagIds = new Set(tags.map(tag => tag.id));
  const parentTags = [...new Set(tags.flatMap(tag => tag.parent_tag != null && !tagIds.has(tag.parent_tag) ? [tag.parent_tag] : []))];
  if (parentTags.length) {
    const rows = await env.DB.prepare('SELECT id, taxonomy_slug FROM tags WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(parentTags)).all<Pick<PublishedTag, 'id' | 'taxonomy_slug'>>();
    if (rows.results.length !== parentTags.length) throw new Error('Publish parent tag classification unavailable');
    describedTags.push(...rows.results);
  }
  const tagGroups = new Map<string, Set<string>>();
  for (const tag of describedTags) {
    const key = tag.taxonomy_slug ?? 'default';
    const ids = tagGroups.get(key) ?? new Set<string>();
    ids.add(String(tag.id)); tagGroups.set(key, ids);
  }
  for (const [key, ids] of tagGroups) reads.push({ action: 'tag.publish-disclosure', kind: 'taxonomy', key,
    targetType: 'tag', ids: [...ids], count: ids.size, detail, eventClass: 'export' });
  if (adapter.contributorId) reads.push({ action: 'plugin.publish-disclosure', kind: 'plugin', key: adapter.contributorId,
    targetType: 'plugin', ids: [adapter.contributorId], count: 1, detail, eventClass: 'export' });

  const groups = await prepareReadAudits(env, reads, actor, true);
  // Recheck at transfer time as well as at the earlier publication gate.
  // Contributor classification records the destination; it does not grant an
  // exception to the host's blanket prohibition on publishing PHI content.
  if (groups.some(group => group.rows.some(row => row.dataClass === 'phi' && row.targetType !== 'plugin'))) {
    throw new Error('Regulated publication refused');
  }
  for (const group of groups) await writeBackgroundAuditRows(env, group.rows, group.actor, true);
  // Audit preparation/persistence awaits I/O. Do not hand bytes to an adapter
  // if containment became active while that evidence was being prepared.
  assertRegulatedWritesAllowed(env);
}

/** Resolve only metadata. Draft, trash and published identifiers remain
 * attributable without loading bodies or depending on the optional trash feature. */
export interface WithdrawalRead extends PendingRead { withdrawalUuid?: string }

export async function withdrawalReads(env: Env, operation: 'unpublish' | 'remove-tag', ids: string[]): Promise<WithdrawalRead[]> {
  if (operation === 'remove-tag') {
    const rows = await env.DB.prepare('SELECT id, taxonomy_slug FROM tags WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids)).all<{ id: number; taxonomy_slug: string | null }>();
    if (rows.results.length !== ids.length) throw new Error('Withdrawal tag classification unavailable');
    return rows.results.map(row => ({ action: 'tag.withdrawal', kind: 'taxonomy', key: row.taxonomy_slug ?? 'default',
      targetType: 'tag', ids: [String(row.id)], count: 1 }));
  }
  const reads: WithdrawalRead[] = [];
  const remaining = new Set(ids);
  const active = await env.DB.prepare('SELECT id, uuid, page_type FROM pages WHERE uuid IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all<Pick<Page, 'id' | 'uuid' | 'page_type'>>();
  for (const row of active.results) {
    remaining.delete(row.uuid);
    reads.push({ action: 'page.withdrawal', kind: 'page_type', key: row.page_type ?? 'default', targetType: 'page', ids: [String(row.id)], count: 1, withdrawalUuid: row.uuid, uuidById: { [row.id]: row.uuid } });
  }
  if (remaining.size && await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trash_pages'").first()) {
    const trashed = await env.DB.prepare('SELECT id, uuid, page_type FROM trash_pages WHERE uuid IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify([...remaining])).all<Pick<Page, 'id' | 'uuid' | 'page_type'>>();
    for (const row of trashed.results) {
      remaining.delete(row.uuid);
      reads.push({ action: 'page.trash-withdrawal', kind: 'page_type', key: row.page_type ?? 'default', targetType: 'page', ids: [String(row.id)], count: 1, withdrawalUuid: row.uuid, uuidById: { [row.id]: row.uuid } });
    }
  }
  if (remaining.size && env.PUBLISHED_DB) {
    const published = await env.PUBLISHED_DB.prepare('SELECT uuid, page_type FROM pages WHERE uuid IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify([...remaining])).all<Pick<Page, 'uuid' | 'page_type'>>();
    for (const row of published.results) {
      remaining.delete(row.uuid);
      reads.push({ action: 'page.withdrawal', kind: 'page_type', key: row.page_type ?? 'default',
        targetType: 'published_page', ids: [row.uuid], count: 1, withdrawalUuid: row.uuid });
    }
  }
  if (remaining.size) throw new Error('Withdrawal page classification unavailable');
  return reads;
}

export function auditWithdrawal(env: Env, adapter: PublishAdapter, operation: 'unpublish' | 'remove-tag', ids: string[],
  reads: () => Promise<PendingRead[]>, actor: AuditActor = { userId: null, roles: null, sessionSid: null, via: 'system:withdrawal' },
): Promise<boolean> {
  return auditOutboundIntent(env, { action: 'publish.withdrawal-intent', destination: adapter.id, operation,
    targetType: operation === 'unpublish' ? 'withdrawal_page' : 'withdrawal_tag', ids, actor, containment: true,
    reads: async () => [...await reads(), ...(adapter.contributorId ? [{ action: 'plugin.withdrawal', kind: 'plugin' as const,
      key: adapter.contributorId, targetType: 'plugin', ids: [adapter.contributorId], count: 1 }] : [])],
  });
}
