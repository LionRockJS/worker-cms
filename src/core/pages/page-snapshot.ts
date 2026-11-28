import type { ContainerKind, DataClass } from '../db/data-classes';
import type { Page } from '../../types';
import type { AppContext } from '../http/context';
import { classFor, strongestClass } from '../db/data-classes';
import { guard, json, snapshotRows, snapshotStatement, type Row } from '../db/bounded-mutation';
import { abortIf } from '../db/transaction-guard';
import { pageAccessGuard, pageAllowed } from '../auth/page-access';
import type { SnapshotSource } from '../evidence/audited-mutation';

const PAGE = ['id', 'uuid', 'page_type', 'updated_at'];
export const PAGE_LINK = ['id', 'uuid', 'created_at', 'updated_at', 'page_id', 'tag_id', 'weight'];
const TAG = ['id', 'uuid', 'taxonomy_slug'];
const level = (dataClass: DataClass | 'none') => dataClass === 'phi' ? 2 : dataClass === 'pii' ? 1 : 0;
export const DRAFT_CONTENT_FIELDS = ['name', 'slug', 'weight', 'start', 'end', 'timezone', 'page_type', 'lect', 'page_id', 'creator', 'editors'] as const;
export type DraftContent = Pick<Page, typeof DRAFT_CONTENT_FIELDS[number]>;
const CONTENT_PAGE = ['uuid', 'created_at', 'updated_at', ...DRAFT_CONTENT_FIELDS] as const;

type AssociationOptions = { readAction: string; extraTagIds?: number[] };
type ContentOptions = { fields: 'content'; readAction: string; extraTagIds?: unknown[] };

interface ContentPageAggregate {
  versionIds: number[];
  linkCount: number;
  targetTags: number[];
  expectHistory(remaining: number[]): D1PreparedStatement[];
  expectSave(final: {
    uuid: string;
    content: DraftContent;
    versionUuid: string;
    versionAction: string;
    dataClass: DataClass | 'none';
  }): D1PreparedStatement[];
}

/** Link, taxonomy and floor reads share one protected batch. The editor also
 *  reads the version IDs and only needs tag membership from the link rows. */
async function relatedRows(c: AppContext, policyGuard: () => D1PreparedStatement, pageId: number | null, uuid: string | null,
  tagIds: number[], content: boolean) {
  const db = c.env.DB;
  const linkFields = content ? ['tag_id'] : PAGE_LINK;
  const tagFields = content ? ['id', 'taxonomy_slug'] : TAG;
  const tagWhere = 'id IN (SELECT value FROM json_each(?)) OR id IN (SELECT tag_id FROM page_tags WHERE page_id=?)';
  const [, linkResult, tagResult, floorResult, versionResult] = await db.batch([
    policyGuard(),
    snapshotStatement(c, 'page_tags', linkFields, 'page_id=?', [pageId]),
    snapshotStatement(c, 'tags', tagFields, tagWhere, [json(tagIds), pageId]),
    db.prepare('SELECT level FROM page_sensitivity_floors WHERE uuid=?').bind(uuid),
    ...(content ? [db.prepare('SELECT id FROM page_versions WHERE page_id=? ORDER BY id LIMIT 5001').bind(pageId)] : []),
  ]);
  const versionIds = (versionResult?.results as Array<{ id: number }> | undefined)?.map(row => row.id) ?? [];
  if (versionIds.length > 5000) throw new Error('Content manifest requires review');
  const floor = (floorResult.results[0] as { level: number } | undefined)?.level ?? null;
  if (floor !== null && floor !== 1 && floor !== 2) throw new Error('Invalid page sensitivity floor');
  return {
    links: snapshotRows<Row>(linkFields, linkResult.results[0] as { snapshot: string }),
    tags: snapshotRows<Row>(tagFields, tagResult.results[0] as { snapshot: string }),
    floor, versionIds,
  };
}

function pageContainers(pageType: string, tags: Row[]): Array<[ContainerKind, string]> {
  return [['page_type', pageType], ...tags.map(tag => ['taxonomy', String(tag.taxonomy_slug ?? 'default')] as [ContainerKind, string])];
}

function pageRead(action: string, page: { id: number; uuid: string; page_type?: string | null }) {
  const id = String(page.id);
  return { action, kind: 'page_type' as const, key: page.page_type ?? 'default', targetType: 'page',
    ids: [id], count: 1, uuidById: page.uuid ? { [id]: page.uuid } : {} };
}

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
export function pageSnapshot(pageId: number, options: AssociationOptions): SnapshotSource<PageAggregate | null | 'denied'>;
export function pageSnapshot(page: Page | null, options: ContentOptions): SnapshotSource<ContentPageAggregate | 'denied'>;
export function pageSnapshot(page: number | Page | null, options: AssociationOptions | ContentOptions) {
  return typeof page === 'number' ? associationSnapshot(page, options as AssociationOptions) : contentSnapshot(page, options);
}

function associationSnapshot(pageId: number, options: AssociationOptions): SnapshotSource<PageAggregate | null | 'denied'> {
  return {
    async load({ c, authority, policy, policyGuard }) {
      const env = c.env, user = c.get('user');
      const [, pageResult] = await env.DB.batch<{ snapshot: string }>([policyGuard(), snapshotStatement(c, 'pages', PAGE, 'id=?', [pageId])]);
      const pages = snapshotRows<Row>(PAGE, pageResult.results[0]);
      const page = pages[0];
      if (!page) return { value: null, classify: [], reads: [], guards: () => [guard(c, 'pages', PAGE, [], 'id=?', [pageId])] };
      const legacy = authority.permissions.has('content:write');
      if (!await pageAllowed(env, user, pageId, 'write', legacy)) return { value: 'denied', classify: [], reads: [], guards: () => [] };

      const { links, tags, floor: retained } = await relatedRows(c, policyGuard, pageId, String(page.uuid), options.extraTagIds ?? [], false);
      if (links.some(l => !Number.isSafeInteger(l.tag_id) || Number(l.tag_id) <= 0 || (l.weight !== null && !Number.isFinite(l.weight)))) throw new Error('Invalid association metadata');
      const floor = retained ?? 0;
      const tagWhere = 'id IN (SELECT value FROM json_each(?))';
      const tagArgs = [json([...new Set([...links.map(l => l.tag_id), ...(options.extraTagIds ?? [])])])];

      const containers = pageContainers(String(page.page_type ?? 'default'), tags);
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
        reads: [pageRead(options.readAction, { id: pageId, uuid: String(page.uuid), page_type: String(page.page_type ?? 'default') })],
        guards: () => [pageAccessGuard(env, user, [String(page.uuid)], legacy),
          guard(c, 'pages', PAGE, pages, 'id=?', [pageId]), guard(c, 'page_tags', PAGE_LINK, links, 'page_id=?', [pageId]), ...unchanged()],
      };
    },
  };
}

/** Draft routes supply the row they planned against, so a stale working copy
 *  still fails admission even if the page changed before the source loaded. */
function contentSnapshot(before: Page | null, options: Pick<ContentOptions, 'readAction' | 'extraTagIds'>): SnapshotSource<ContentPageAggregate | 'denied'> {
  return {
    async load({ c, authority, policyGuard }) {
      const env = c.env;
      const actor = c.get('user');
      const legacy = authority.permissions.has('content:write');
      if (before && !await pageAllowed(env, actor, before.id, 'write', legacy)) {
        return { value: 'denied', classify: [], reads: [], guards: () => [] };
      }

      const selected = options.extraTagIds && [...new Set(options.extraTagIds.map(Number).filter(Number.isFinite))];
      if ((selected?.length ?? 0) > 5000) throw new Error('Content tag manifest requires review');
      if (selected?.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid content tags');
      const { links, tags, floor, versionIds } = await relatedRows(c, policyGuard, before?.id ?? null, before?.uuid ?? null, selected ?? [], true);
      const oldTags = links.map(link => Number(link.tag_id));
      const targetTags = selected ?? oldTags;
      const tagIds = new Set(tags.map(tag => tag.id));
      if (targetTags.some(id => !tagIds.has(id))) throw new Error('Content tag unavailable');

      const pageUnchanged = (page: Page) => abortIf(env, `NOT EXISTS (SELECT 1 FROM pages WHERE id=? AND ${CONTENT_PAGE.map(f => `${f} IS ?`).join(' AND ')})`,
        [page.id, ...CONTENT_PAGE.map(f => page[f])]);
      const linksMatch = (uuid: string, ids: number[]) => abortIf(env, `(SELECT json_group_array(tag_id) FROM (
        SELECT tag_id FROM page_tags WHERE page_id=(SELECT id FROM pages WHERE uuid=?) ORDER BY tag_id)) IS NOT ?`,
      [uuid, json([...ids].sort((a, b) => a - b))]);
      const floorUnchanged = (uuid: string) => abortIf(env, '(SELECT level FROM page_sensitivity_floors WHERE uuid=?) IS NOT ?', [uuid, floor]);
      const versionsMatch = (pageId: number, ids: number[]) => abortIf(env, `(SELECT COUNT(*) FROM page_versions WHERE page_id=?)<>?
        OR EXISTS (SELECT 1 FROM page_versions WHERE page_id=? AND id NOT IN (SELECT value FROM json_each(?)))`,
      [pageId, ids.length, pageId, json(ids)]);
      const tagsUnchanged = () => abortIf(env, `EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (
        SELECT 1 FROM tags WHERE id=json_extract(e.value,'$.id') AND taxonomy_slug IS json_extract(e.value,'$.taxonomy_slug')))`, [json(tags)]);
      const accessGuard = (uuid: string) => pageAccessGuard(env, actor, [uuid], legacy);
      const existingGuards = (page: Page) => [pageUnchanged(page), linksMatch(page.uuid, oldTags), floorUnchanged(page.uuid)];
      const classify = pageContainers(before?.page_type ?? 'default', tags);

      return {
        value: {
          versionIds, linkCount: links.length, targetTags,
          expectHistory: remaining => {
            if (!before) throw new Error('Content history has no page');
            return [...existingGuards(before), versionsMatch(before.id, remaining)];
          },
          expectSave: ({ uuid, content, versionUuid, versionAction, dataClass }) => [
            ...(!before && content.creator ? [abortIf(env, `NOT EXISTS (SELECT 1 FROM page_access_policies
              WHERE page_uuid=? AND owner_id=? AND enabled=1 AND mode=600 AND group_role IS NULL AND revision=1)`, [uuid, content.creator])] : []),
            ...(before ? [accessGuard(uuid)] : []),
            abortIf(env, `NOT EXISTS (SELECT 1 FROM pages WHERE uuid=? AND ${DRAFT_CONTENT_FIELDS.map(f => `${f} IS ?`).join(' AND ')})`,
              [uuid, ...DRAFT_CONTENT_FIELDS.map(f => content[f])]),
            linksMatch(uuid, targetTags),
            tagsUnchanged(),
            abortIf(env, `NOT EXISTS (SELECT 1 FROM page_versions v JOIN pages p ON p.id=v.page_id
                WHERE p.uuid=? AND v.uuid=? AND v.lect IS ? AND v.action=? AND v.id BETWEEN 1 AND 9007199254740991)
              OR (SELECT COUNT(*) FROM page_versions WHERE page_id=(SELECT id FROM pages WHERE uuid=?))<>?
              OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (
                SELECT 1 FROM page_versions WHERE id=e.value AND page_id=(SELECT id FROM pages WHERE uuid=?)))`,
            [uuid, versionUuid, content.lect, versionAction, uuid, versionIds.length + 1, json(versionIds), uuid]),
            abortIf(env, `COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<?
              OR COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)>?
              OR (? IS NOT NULL AND (SELECT id FROM pages WHERE uuid=?) IS NOT ?)`,
            [uuid, floor ?? 0, uuid, level(dataClass), before?.id ?? null, uuid, before?.id ?? null]),
          ],
        },
        classify: [...classify, ...(floor === 2 ? ['phi' as const] : floor === 1 ? ['pii' as const] : [])],
        reads: before ? [pageRead(options.readAction, before)] : [],
        readMode: 'request',
        guards: () => [
          ...(before ? [accessGuard(before.uuid), ...existingGuards(before), versionsMatch(before.id, versionIds)] : []),
          tagsUnchanged(),
        ],
      };
    },
  };
}
