import type { Env } from '../../types';
import type { AuditActor } from '../db/audit';
import { resolveDataClasses } from '../db/data-classes';
import { auditBackgroundReads, recordRead, ReadAuditUnavailableError, type PendingRead } from '../http/access-log';
import { requestContext } from '../http/request-context';
import type { LivePageSnapshot, PublishAdapter } from './adapter';

/** Prepare evidence from captured source provenance, without a later tag lookup.
 * Copy producers must persist the returned reads before materializing rows. */
export async function liveSourceReads(env: Env, reader: Pick<PublishAdapter, 'id' | 'contributorId'>,
  pages: ReadonlyArray<Pick<LivePageSnapshot, 'uuid' | 'page_type' | 'taxonomy_slugs'>>, actor?: AuditActor, action = 'page.live-read'): Promise<PendingRead[]> {
  if (!pages.length) return [];
  try {
    const classes = await resolveDataClasses(env, true);
    if (!classes.ok) throw new Error('Classification unavailable');
    const regulated = env.REGULATED_MODE === 'true';
    const requireType = regulated || [...classes.exact.keys()].some(key => key.startsWith('page_type:'));
    const requireTaxonomies = regulated || [...classes.exact.keys()].some(key => key.startsWith('taxonomy:'));
    const grouped = new Map<string, PendingRead>();
    const add = (kind: 'page_type' | 'taxonomy' | 'plugin', key: string, uuid: string) => {
      const groupKey = `${kind}:${key}`;
      let read = grouped.get(groupKey);
      if (!read) {
        read = { action, kind, key, targetType: 'live_page', ids: [], count: 0, actor, detail: { source: reader.id } };
        grouped.set(groupKey, read);
      }
      if (!read.ids.includes(uuid)) { read.ids.push(uuid); read.count++; }
    };
    for (const page of pages) {
      const knownType = page.page_type === null || typeof page.page_type === 'string' && page.page_type.length > 0;
      if (!knownType && requireType) throw new Error('Live source type unavailable');
      if (knownType) add('page_type', page.page_type ?? 'default', page.uuid);
      const knownTaxonomies = Array.isArray(page.taxonomy_slugs) && page.taxonomy_slugs.every(key => typeof key === 'string' && key.length > 0);
      if (!knownTaxonomies && requireTaxonomies) throw new Error('Live source taxonomy provenance unavailable');
      if (knownTaxonomies) for (const key of page.taxonomy_slugs!) add('taxonomy', key, page.uuid);
      if (reader.contributorId) add('plugin', reader.contributorId, page.uuid);
    }
    return [...grouped.values()];
  } catch { throw new ReadAuditUnavailableError(); }
}

/** Classify the live source itself, including comparisons that return only a status. */
export async function auditLiveReads(env: Env, reader: Pick<PublishAdapter, 'id' | 'contributorId'>,
  pages: ReadonlyArray<Pick<LivePageSnapshot, 'uuid' | 'page_type' | 'taxonomy_slugs'>>, actor?: AuditActor, action = 'page.live-read'): Promise<void> {
  if (!pages.length) return;
  try {
    const reads = await liveSourceReads(env, reader, pages, actor, action);
    // Preserve HTTP source IP/session context at the common flush. Outside
    // HTTP, await evidence explicitly rather than silently dropping the buffer.
    if (requestContext.getStore()) for (const read of reads) recordRead(read);
    else await auditBackgroundReads(env, reads, actor ?? { userId: null, roles: null, sessionSid: null, via: 'system:live-reader' });
  } catch { throw new ReadAuditUnavailableError(); }
}
