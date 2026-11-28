import type { ContainerKind, DataClass } from '../db/data-classes';
import { classFor, strongestClass } from '../db/data-classes';
import { guard, json, snapshotRows, snapshotStatement, type Row } from '../db/bounded-mutation';
import { abortIf } from '../db/transaction-guard';
import { pageAccessGuard, pageAllowed } from '../auth/page-access';
import type { SnapshotSource } from '../evidence/audited-mutation';

const PAGE = ['id', 'uuid', 'page_type', 'updated_at'];
export const PAGE_LINK = ['id', 'uuid', 'created_at', 'updated_at', 'page_id', 'tag_id', 'weight'];
const TAG = ['id', 'uuid', 'taxonomy_slug'];
const level = (dataClass: DataClass | 'none') => dataClass === 'phi' ? 2 : dataClass === 'pii' ? 1 : 0;

/** One draft page as a consistent unit: its row, tag links, linked tags and
 *  sensitivity floor. It owns the page rules writers otherwise repeat: write
 *  access, the one logged page read (keyed by page type and UUID), guards that
 *  everything is unchanged, and a floor that may rise but never fall. */
export interface PageAggregate {
  page: Row;
  links: Row[];
  tags: Row[];
  /** A fresh ID for a new link, unique across time and concurrent writers;
   *  the batch still refuses a collision through its final link checks. */
  allocateLinkId(): Promise<number>;
  /** Final-state checks. `links` is the expected final link set; `dataClass`
   *  is the change's evidence class, which caps the final floor. */
  expect(final: { links: Row[]; since: string; dataClass: DataClass | 'none' }): D1PreparedStatement[];
}

/** `null`: no such page. `'denied'`: the actor may not write it (nothing is
 *  read or logged beyond the page row). `extraTagIds`: tags the change adds. */
export function pageSnapshot(pageId: number, options: { readAction: string; extraTagIds?: number[] }): SnapshotSource<PageAggregate | null | 'denied'> {
  return {
    async load({ c, authority, policy, policyGuard }) {
      const env = c.env, user = c.get('user');
      const [, pageResult] = await env.DB.batch<{ snapshot: string }>([policyGuard(), snapshotStatement(c, 'pages', PAGE, 'id=?', [pageId])]);
      const pages = snapshotRows<Row>(PAGE, pageResult.results[0]);
      const page = pages[0];
      if (!page) return { value: null, classify: [], reads: [], guards: () => [guard(c, 'pages', PAGE, [], 'id=?', [pageId])] };
      const legacy = authority.permissions.has('content:write');
      if (!await pageAllowed(env, user, pageId, 'write', legacy)) return { value: 'denied', classify: [], reads: [], guards: () => [] };

      const [, linkResult, floorResult] = await env.DB.batch<Record<string, unknown>>([policyGuard(),
        snapshotStatement(c, 'page_tags', PAGE_LINK, 'page_id=?', [pageId]),
        env.DB.prepare('SELECT level FROM page_sensitivity_floors WHERE uuid=?').bind(page.uuid)]);
      const links = snapshotRows<Row>(PAGE_LINK, linkResult.results[0] as { snapshot: string });
      if (links.some(l => !Number.isSafeInteger(l.tag_id) || Number(l.tag_id) <= 0 || (l.weight !== null && !Number.isFinite(l.weight)))) throw new Error('Invalid association metadata');
      const floor = Number((floorResult.results[0] as { level?: number } | undefined)?.level ?? 0);
      if (floor !== 0 && floor !== 1 && floor !== 2) throw new Error('Invalid page sensitivity floor');

      const tagWhere = 'id IN (SELECT value FROM json_each(?))';
      const tagArgs = [json([...new Set([...links.map(l => l.tag_id), ...(options.extraTagIds ?? [])])])];
      const [, tagResult] = await env.DB.batch<{ snapshot: string }>([policyGuard(), snapshotStatement(c, 'tags', TAG, tagWhere, tagArgs)]);
      const tags = snapshotRows<Row>(TAG, tagResult.results[0]);

      const containers: Array<[ContainerKind, string]> = [['page_type', String(page.page_type ?? 'default')],
        ...tags.map(t => ['taxonomy', String(t.taxonomy_slug ?? 'default')] as [ContainerKind, string])];
      // A floor never falls below what the page type and its tags now imply.
      const minimum = Math.max(floor, level(strongestClass(containers.map(([kind, key]) => classFor(policy, kind, key)))));
      const floorClass: DataClass[] = floor === 2 ? ['phi'] : floor === 1 ? ['pii'] : [];
      const unchanged = () => [guard(c, 'tags', TAG, tags, tagWhere, tagArgs),
        abortIf(env, 'COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<>?', [page.uuid, floor])];
      return {
        value: {
          page, links, tags,
          async allocateLinkId() {
            const next = await env.DB.prepare(`SELECT MAX(COALESCE(MAX(id),0),(CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 id FROM page_tags`).first<{ id: number }>();
            if (!next || !Number.isSafeInteger(next.id) || next.id <= 0) throw new Error('Unsafe association identity');
            return next.id;
          },
          expect: ({ links: finalLinks, since, dataClass }) => [
            guard(c, 'pages', PAGE.filter(f => f !== 'updated_at'), pages, 'id=?', [pageId]),
            abortIf(env, 'NOT EXISTS (SELECT 1 FROM pages WHERE id=? AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP)', [pageId, since]),
            guard(c, 'page_tags', PAGE_LINK, finalLinks, 'page_id=?', [pageId]),
            guard(c, 'tags', TAG, tags, tagWhere, tagArgs),
            abortIf(env, `COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<? OR
              COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)>?`, [page.uuid, minimum, page.uuid, level(dataClass)]),
          ],
        },
        classify: [...containers, ...floorClass],
        reads: [{ action: options.readAction, kind: 'page_type', key: String(page.page_type ?? 'default'), targetType: 'page',
          ids: [String(page.id)], count: 1, uuidById: { [String(page.id)]: String(page.uuid) } }],
        guards: () => [pageAccessGuard(env, user, [String(page.uuid)], legacy),
          guard(c, 'pages', PAGE, pages, 'id=?', [pageId]), guard(c, 'page_tags', PAGE_LINK, links, 'page_id=?', [pageId]), ...unchanged()],
      };
    },
  };
}
