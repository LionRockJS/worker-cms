import type { Page, PageTag } from '../../types';
import { pageAccessGuard, pageAccessFilter } from '../../core/auth/page-access';
import { contextActor, mutationAuditEvidence } from '../../core/db/audit';
import { guard, json, snapshot } from '../../core/db/bounded-mutation';
import { classFor, classificationPolicyGuard, strongestClass } from '../../core/db/data-classes';
import { pinSensitivityStatement } from '../../core/db/sensitivity';
import { abortIf } from '../../core/db/transaction-guard';
import { captureMutationAuthority } from '../../core/evidence/mutation-authority';
import { auditBackgroundReads } from '../../core/http/access-log';
import type { AppContext } from '../../core/http/context';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { NEXT_SNAPSHOT_ID_SQL, nextIdSql } from '../../core/pages/snapshot-id';
import { liveSourceReads } from './read-audit';

const pageFields = ['uuid', 'created_at', 'updated_at', 'name', 'slug', 'weight', 'start', 'end', 'timezone',
  'page_type', 'lect', 'page_id', 'creator', 'editors'] as const;
const draftPageId = '(SELECT id FROM pages WHERE uuid = ?)';
type PublishedLink = Pick<PageTag, 'uuid' | 'tag_id'> & { weight: number | null; taxonomy_slug: string | null };

type PullResult = { page: Page; created: true } | { page: Pick<Page, 'id'>; created: false };

export async function pullPublishedPageToDraft(c: AppContext, uuid: string): Promise<PullResult | null> {
  const env = c.env;
  assertRegulatedWritesAllowed(env);
  const { DB: db, PUBLISHED_DB: publishedDb } = env;
  if (!publishedDb) return null;

  const user = c.get('user');
  const actor = contextActor(c);
  const { authority, policy } = await captureMutationAuthority(c, 'content:write');
  const access = pageAccessFilter(user, 'write', 'target.uuid', true);
  if (!await db.prepare(`SELECT 1 FROM (SELECT ? uuid) target WHERE ${access.sql}`).bind(uuid, ...access.args).first()) return null;
  const authorityChecks = () => [authority.guard(), pageAccessGuard(env, user, [uuid], true), classificationPolicyGuard(env, policy)];
  const selectDraft = () => db.prepare('SELECT * FROM pages WHERE uuid = ?').bind(uuid);
  const existing = await db.prepare('SELECT id, uuid, page_type FROM pages WHERE uuid = ?')
    .bind(uuid).first<Pick<Page, 'id' | 'uuid' | 'page_type'>>();
  if (existing) {
    await auditBackgroundReads(env, [{ action: 'page.pull-existing', kind: 'page_type', key: existing.page_type ?? 'default',
      targetType: 'page', ids: [String(existing.id)], count: 1, uuidById: { [String(existing.id)]: uuid } }], actor, { exact: true });
    await db.batch([...authorityChecks(), guard(c, 'pages', ['id', 'uuid', 'page_type'],
      [{ id: existing.id, uuid, page_type: existing.page_type }], 'uuid = ?', [uuid])]);
    return { page: existing, created: false };
  }

  // Capture links and their taxonomy provenance in the same source snapshot.
  const source = await publishedDb.prepare(`SELECT p.*, (SELECT json_group_array(json_object(
    'uuid', link.uuid, 'tag_id', link.tag_id, 'weight', link.weight, 'taxonomy_slug',
    CASE WHEN t.id IS NULL THEN NULL ELSE COALESCE(t.taxonomy_slug, 'default') END))
    FROM (SELECT uuid, tag_id, weight FROM page_tags WHERE page_id = p.id ORDER BY weight, id LIMIT 5001) link
    LEFT JOIN tags t ON t.id = link.tag_id) AS links_json FROM pages p WHERE p.uuid = ?`)
    .bind(uuid).first<Page & { links_json: string }>();
  if (!source) return null;
  const links = JSON.parse(source.links_json) as PublishedLink[];
  if (links.length > 5000 || links.some(link => !Number.isSafeInteger(link.tag_id))) throw new Error('Published links require review');
  const taxonomySlugs = links.every(link => link.taxonomy_slug)
    ? [...new Set(links.map(link => link.taxonomy_slug!))] : undefined;
  const reads = await liveSourceReads(env, { id: 'd1' }, [
    { uuid, page_type: source.page_type, taxonomy_slugs: taxonomySlugs },
  ], actor, 'page.pull-read');
  const evidence = await auditBackgroundReads(env, reads, actor, { exact: true });

  const tagArgs = [json([...new Set(links.map(link => link.tag_id))])];
  const tagWhere = 'id IN (SELECT value FROM json_each(?))';
  const tagFields = ['id', 'taxonomy_slug'];
  const parentFields = ['id', 'uuid'];
  const [tags, parent, floors] = await Promise.all([
    snapshot<{ id: number; taxonomy_slug: string | null }>(c, 'tags', tagFields, tagWhere, tagArgs),
    snapshot<{ id: number; uuid: string }>(c, 'pages', parentFields, 'id = ? AND uuid <> ?', [source.page_id, uuid]),
    snapshot<{ level: number }>(c, 'page_sensitivity_floors', ['level'], 'uuid = ?', [uuid]),
  ]);
  const retained = floors[0]?.level;
  if (retained !== undefined && retained !== 1 && retained !== 2) throw new Error('Invalid draft sensitivity floor');
  const pageClass = strongestClass([
    ...evidence.map(row => row.dataClass),
    classFor(policy, 'page_type', source.page_type ?? 'default'),
    ...tags.map(tag => classFor(policy, 'taxonomy', tag.taxonomy_slug ?? 'default')),
    retained === 2 ? 'phi' : retained === 1 ? 'pii' : 'none',
  ]);
  const receiptClass = strongestClass([pageClass, ...['pages', 'page_versions', 'page_tags', 'tags',
    'taxonomies', 'page_sensitivity_floors', 'audit_events'].map(table => classFor(policy, 'table', table))]);

  const parentId = parent[0]?.id ?? null;
  const draft = { ...source, page_id: parentId };
  const values = pageFields.map(field => draft[field]);
  const plannedLinks = links.map(({ uuid, tag_id, weight }) => ({ uuid, tag_id, weight }));
  const linkManifest = json(plannedLinks);
  const versionUuid = crypto.randomUUID();
  const receipt = mutationAuditEvidence(c, { action: 'page.pull', entityType: 'page', entityId: uuid,
    detail: { source: 'published_d1', version_uuid: versionUuid, parent_id: parentId, tag_links: plannedLinks } },
  receiptClass, { policy });

  const localChecks = () => [
    guard(c, 'pages', parentFields, parent, 'id = ? AND uuid <> ?', [source.page_id, uuid]),
    guard(c, 'tags', tagFields, tags, tagWhere, tagArgs),
  ];
  const result = await db.batch([
    ...authorityChecks(),
    ...localChecks(),
    guard(c, 'page_sensitivity_floors', ['level'], floors, 'uuid = ?', [uuid]),
    ...(pageClass === 'none' ? [] : [pinSensitivityStatement(db, uuid, pageClass)]),
    db.prepare(`INSERT INTO pages (${pageFields.join(',')}) VALUES (${pageFields.map(() => '?').join(',')})`).bind(...values),
    abortIf(env, 'changes() <> 1'),
    db.prepare(`INSERT INTO page_tags (id, uuid, page_id, tag_id, weight)
      SELECT ${nextIdSql('page_tags')} + CAST(key AS INTEGER), json_extract(value, '$.uuid'), ${draftPageId},
        json_extract(value, '$.tag_id'), json_extract(value, '$.weight') FROM json_each(?) ORDER BY CAST(key AS INTEGER)`)
      .bind(uuid, linkManifest),
    db.prepare(`INSERT INTO page_versions (id, uuid, page_id, lect, action)
      VALUES (${NEXT_SNAPSHOT_ID_SQL}, ?, ${draftPageId}, ?, 'pull-published')`).bind(versionUuid, uuid, source.lect),
    abortIf(env, 'changes() <> 1'),
    receipt.write, receipt.guard,
    ...authorityChecks(),
    ...localChecks(),
    guard(c, 'page_sensitivity_floors', ['level'],
      pageClass === 'none' ? [] : [{ level: pageClass === 'phi' ? 2 : 1 }], 'uuid = ?', [uuid]),
    abortIf(env, `NOT EXISTS (SELECT 1 FROM pages WHERE ${pageFields.map(field => `${field} IS ?`).join(' AND ')}
      AND id BETWEEN 1 AND 9007199254740991)`, values),
    abortIf(env, `(SELECT COUNT(*) FROM page_tags WHERE page_id = ${draftPageId}) <> ?
      OR EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
        SELECT 1 FROM page_tags actual WHERE page_id = ${draftPageId}
          AND actual.uuid IS json_extract(expected.value, '$.uuid') AND actual.tag_id IS json_extract(expected.value, '$.tag_id')
          AND actual.weight IS json_extract(expected.value, '$.weight')
          AND typeof(actual.id) = 'integer' AND actual.id BETWEEN 1 AND 9007199254740991))`,
    [uuid, plannedLinks.length, linkManifest, uuid]),
    abortIf(env, `(SELECT COUNT(*) FROM page_versions WHERE page_id = ${draftPageId}) <> 1
      OR NOT EXISTS (SELECT 1 FROM page_versions WHERE page_id = ${draftPageId}
        AND uuid = ? AND lect IS ? AND action = 'pull-published' AND typeof(id) = 'integer' AND id BETWEEN 1 AND 9007199254740991)`,
    [uuid, uuid, versionUuid, source.lect]),
    selectDraft(),
  ]);
  return { page: result.at(-1)!.results[0] as Page, created: true };
}
