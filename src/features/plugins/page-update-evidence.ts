import { legacyPageFilter } from '../../core/auth/page-access';
import type { AppContext } from '../../core/http/context';
import type { Page } from '../../types';
import type { PluginAuth } from './api/types';
import { cmsConfig } from '../../cms-config';
import { ServiceMutationUnavailableError, type AuditActor } from '../../core/db/audit';
import { resolveDataClasses, classFor, classificationPolicyGuard, strongestClass } from '../../core/db/data-classes';
import { snapshot, guard, resultGuard, fingerprint, json, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { timingSafeEqualStr } from '../../core/http/crypto';
import { auditBackgroundReads } from '../../core/http/access-log';
import { beginServiceAuditedMutation, type PlannedWrite, type MutationGroup } from '../../core/evidence/audited-mutation';
import { requestContext } from '../../core/http/request-context';
import { NEXT_SNAPSHOT_ID_SQL, nextIdSql } from '../../core/pages/snapshot-id';
import { pageTypeScopeAllows } from './page-types';
import { REGISTRY, IDENTITY, unavailable, noteActingUser } from './evidence-common';

const APPROVAL = ['id','created_at','updated_at','plugin_id','page_type','access','approved_by'];
const PAGE = ['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'];
const CONTENT = ['name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'] as const;
const LINK = ['id','uuid','created_at','updated_at','page_id','tag_id','weight'];
const HISTORY = ['id','uuid','created_at','updated_at','page_id','action'];
const TAG = ['id','uuid','taxonomy_slug'];
const FLOOR = ['uuid','level'];
const brand = Symbol('plugin-page-mutation-authority');
/** Capture before reading the body. Blueprint declarations and wildcard
 * delegation remain requests: current exact write approvals are required. */
export async function capturePluginPageMutationAuthority(c: AppContext, auth: PluginAuth, purpose: 'create'|'update'|'duplicate'|'delete'|'tag-ensure'|'taxonomy-ensure'|'submission-ingest' = 'update') {
  try {
    const registration = auth.plugin.registration;
    if (!registration || !Number.isSafeInteger(registration.id) || registration.id <= 0) throw new Error('Missing registration identity');
    // A supported lifecycle writer can remove/re-create an identical pin within
    // one clock second. Its new durable registry receipt still changes this
    // witness, so a later automatic claim cannot revive this old request.
    const journal = await c.env.DB.prepare("SELECT COALESCE(MAX(seq),0) generation FROM audit_events WHERE target_type='plugin' AND target_id=?").bind(registration.uuid).first<{ generation: number }>();
    if (!journal || !Number.isSafeInteger(journal.generation) || journal.generation < 0) throw new Error('Registry witness unavailable');
    const policy = await resolveDataClasses(c.env, true);
    if (!policy.ok) throw new Error('Page policy unavailable');
    const rows = await snapshot<Row>(c, 'plugins', REGISTRY, 'id=?', [registration.id]);
    const pins = await snapshot<Row>(c, 'plugin_identity_approvals', IDENTITY, 'plugin_row_id=?', [registration.id]);
    const approvals = await snapshot<Row>(c, 'plugin_page_type_approvals', APPROVAL, 'plugin_id=?', [auth.pluginId]);
    const taxonomyGrant = purpose === 'taxonomy-ensure' && auth.plugin.requestedManifest?.capabilities?.includes('taxonomy:create')
      ? await c.env.DB.prepare("SELECT id FROM plugin_capability_approvals WHERE plugin_id=? AND capability='taxonomy:create'")
        .bind(auth.pluginId).first<{id: number}>() : null;
    const row = rows[0];
    if (!row || row.uuid !== registration.uuid || row.enabled !== 1 || row.url !== auth.plugin.binding || pins[0]?.manifest_id !== auth.pluginId || !row.secret
      || !timingSafeEqualStr(String(row.secret), auth.plugin.apiSecret) || !timingSafeEqualStr(String(row.secret), c.req.header('x-plugin-secret') ?? '')) throw new Error('Page credential changed');
    const writes = new Set(approvals.filter(r => r.access === 'write').map(r => String(r.page_type)));
    if (!auth.plugin.requestedManifest) throw new Error('Missing manifest observation');
    const requested = auth.plugin.requestedManifest.contentTypes;
    const allowed = new Set(Object.keys(requested?.blueprint ?? {}).filter(type => writes.has(type) && !Object.hasOwn(cmsConfig.blueprint, type)));
    for (const type of requested?.writeTypes ?? []) if (writes.has(type)) allowed.add(type);
    if (allowed.size !== auth.allowedTypes.size || [...allowed].some(type => !auth.allowedTypes.has(type))) throw new Error('Page scope changed');
    const actor: AuditActor = { userId: null, roles: null, sessionSid: null, via: `plugin:${registration.uuid}` };
    const context = requestContext.getStore(); if (context) context.readActor = actor;
    const dataClass = strongestClass(['plugins','plugin_identity_approvals','plugin_page_type_approvals','pages','page_versions','page_tags','tags','taxonomies','page_sensitivity_floors','audit_events',...(purpose==='taxonomy-ensure'?['plugin_capability_approvals']:[]),...(purpose==='delete'?['trash_pages','trash_page_versions','trash_page_tags']:[])].map(table => classFor(policy, 'table', table)).concat(classFor(policy, 'plugin', auth.pluginId)));
    await auditBackgroundReads(c.env, ['plugins','plugin_identity_approvals','plugin_page_type_approvals','audit_events'].map(table => ({ action: `plugin.page-${purpose}-authority-read`, kind: 'table' as const, key: table, targetType: table === 'audit_events' ? 'plugin_registry_journal' : table, ids: table === 'plugin_page_type_approvals' ? approvals.map(row => String(row.id)) : [table === 'audit_events' ? registration.uuid : String(registration.id)], count: table === 'plugin_page_type_approvals' ? approvals.length : 1, minimumClass: dataClass === 'none' ? undefined : dataClass })), actor);
    if (taxonomyGrant) await auditBackgroundReads(c.env, [{ action: 'plugin.capability-read', kind: 'table',
      key: 'plugin_capability_approvals', targetType: 'plugin_capability_approval', ids: [String(taxonomyGrant.id)], count: 1,
      minimumClass: dataClass === 'none' ? undefined : dataClass }], actor);
    const check = () => [...(taxonomyGrant ? [abortIf(c.env,
      "NOT EXISTS (SELECT 1 FROM plugin_capability_approvals WHERE id=? AND plugin_id=? AND capability='taxonomy:create')",
      [taxonomyGrant.id, auth.pluginId])] : []), guard(c, 'plugins', REGISTRY, rows, 'id=?', [registration.id]), guard(c, 'plugin_identity_approvals', IDENTITY, pins, 'plugin_row_id=?', [registration.id]), guard(c, 'plugin_page_type_approvals', APPROVAL, approvals, 'plugin_id=?', [auth.pluginId]), classificationPolicyGuard(c.env, policy), abortIf(c.env, "(SELECT COALESCE(MAX(seq),0) FROM audit_events WHERE target_type='plugin' AND target_id=?)<>?", [registration.uuid, journal.generation])];
    return { [brand]: true as const, purpose, actor, policy, dataClass, check, allowed, taxonomyCreationApproved: !!taxonomyGrant, registryId: registration.id, identityFingerprint: await fingerprint(auth.pluginId) };
  } catch { return unavailable(c); }
}
export type PluginPageMutationAuthority = Awaited<ReturnType<typeof capturePluginPageMutationAuthority>>;
type Authority = PluginPageMutationAuthority;
export function assertPluginPageAuthority(authority: Authority, purpose: 'create'|'update'|'duplicate'|'delete'|'tag-ensure'|'taxonomy-ensure'|'submission-ingest'): void {
  if (!authority?.[brand] || authority.purpose !== purpose) throw new Error('Invalid page authority');
}

/** Bounded selected rows; all result decisions, including mixed-batch denials,
 * are tied to this exact source through the final transaction. */
export async function readPluginPageUpdateSources(c: AppContext, authority: Authority, ids: number[]) {
  if (!authority?.[brand] || authority.purpose !== 'update' || ids.length > 100 ||
      ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    return unavailable(c, authority?.actor);
  }
  const args = [json(ids)];
  const where = `id IN (SELECT value FROM json_each(?)) AND ${legacyPageFilter('uuid')}`;
  const selected = `page_id IN (SELECT id FROM pages WHERE ${where})`;
  const mutation = await beginServiceAuditedMutation(c, {
    classify: [],
    snapshot: {
      pages: { table: 'pages', fields: PAGE, where, args, read: null },
      links: { table: 'page_tags', fields: LINK, where: selected, args, read: null },
      versions: { table: 'page_versions', fields: HISTORY, where: selected, args, read: null },
      tags: { table: 'tags', fields: TAG, where: `id IN (SELECT tag_id FROM page_tags WHERE ${selected})`, args, read: null },
      floors: { table: 'page_sensitivity_floors', fields: FLOOR, where: `uuid IN (SELECT uuid FROM pages WHERE ${where})`, args, read: null },
    },
    unavailable: () => new ServiceMutationUnavailableError(),
  }, authority);
  try {
    const { links, versions, tags, floors } = mutation.rows;
    const pages = mutation.rows.pages as unknown as Page[];
    if (floors.some(row => row.level !== 1 && row.level !== 2)) throw new Error('Invalid page floor');
    const classification = (page: Page, extraTags: Row[] = []) => strongestClass([authority.dataClass, classFor(authority.policy, 'page_type', page.page_type ?? 'default'),
      floors.find(row => row.uuid === page.uuid)?.level === 2 ? 'phi' : floors.find(row => row.uuid === page.uuid)?.level === 1 ? 'pii' : undefined,
      ...[...tags.filter(tag => links.some(link => link.page_id === page.id && link.tag_id === tag.id)), ...extraTags].map(tag => classFor(authority.policy, 'taxonomy', String(tag.taxonomy_slug ?? 'default')))]);
    await auditBackgroundReads(c.env, pages.map(page => {
      const dataClass = classification(page);
      const id = String(page.id);
      return {
        action: 'plugin.page-update-source-read', kind: 'page_type', key: page.page_type ?? 'default',
        targetType: 'page', ids: [id], count: 1, uuidById: { [id]: page.uuid },
        minimumClass: dataClass === 'none' ? undefined : dataClass,
      };
    }), authority.actor, { policy: authority.policy });
    return { authority, mutation, pages, links, versions, tags, floors, args, selected, classification };
  } catch { return unavailable(c, authority?.actor); }
}
type Sources = Awaited<ReturnType<typeof readPluginPageUpdateSources>>;
export interface PluginPageUpdate { before: Page; next: Page; action: string; tags?: number[] }
export interface PluginPageUpdateDenial { page: Page; reason: 'forbidden_page_type'|'version_precondition' }

/** Commit each accepted page change or denial in the same audited batch. */
export async function commitPluginPageUpdates(c: AppContext, source: Sources, changes: PluginPageUpdate[], denied: PluginPageUpdateDenial[] = []): Promise<Page[]> {
  const { authority, mutation } = source;
  const saved = await mutation.commit(async (_rows, tools) => {
    const changeIds = changes.map(change => change.before.id);
    const resultIds = [...changeIds, ...denied.map(row => row.page.id)];
    if (changes.length > 100 || new Set(resultIds).size !== resultIds.length) throw new Error('Invalid page update manifest');
    const extraIds = [...new Set(changes.flatMap(change => change.tags ?? []))];
    if (extraIds.length > 5000 || extraIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid association manifest');
    const extraArgs = [json(extraIds)];
    const extraWhere = 'id IN (SELECT value FROM json_each(?))';
    const [extraTags] = await tools.snapshot([{ table: 'tags', fields: TAG, where: extraWhere, args: extraArgs, read: null }]);
    if (extraTags.length !== extraIds.length) throw new Error('Tag target unavailable');
    for (const change of changes) {
      if (!source.pages.some(page => json(page) === json(change.before)) ||
          !pageTypeScopeAllows(authority.allowed, change.before.page_type ?? '') ||
          change.next.id !== change.before.id || change.next.uuid !== change.before.uuid ||
          change.next.page_type !== change.before.page_type) throw new Error('Page source or authority changed');
    }
    for (const denial of denied) {
      if (!source.pages.some(page => json(page) === json(denial.page)) ||
          (denial.reason === 'forbidden_page_type' && pageTypeScopeAllows(authority.allowed, denial.page.page_type ?? ''))) {
        throw new Error('Invalid page refusal');
      }
    }

    const minimum = strongestClass([
      ...changes.map(change => source.classification(change.before, extraTags)),
      ...denied.map(row => source.classification(row.page)),
    ]);
    const metadata = [
      { table: 'page_versions', ids: source.versions.map(row => String(row.id)), count: source.versions.length },
      { table: 'page_tags', ids: source.links.map(row => String(row.id)), count: source.links.length },
      { table: 'tags', ids: [...new Set([...source.tags, ...extraTags].map(row => String(row.id)))], count: source.tags.length + extraTags.length },
      ...['page_sensitivity_floors', 'audit_events'].map(table => ({
        table, ids: source.floors.map(row => String(row.uuid)), count: source.floors.length,
      })),
    ];
    await auditBackgroundReads(c.env, metadata.map(({ table, ids, count }) => ({
      action: 'plugin.page-update-metadata-read', kind: 'table', key: table, targetType: table, ids, count,
      minimumClass: minimum === 'none' ? undefined : minimum,
    })), authority.actor, { policy: tools.policy });

    const detail: Record<string, unknown> = {
      registry_id: authority.registryId,
      identity_fingerprint: authority.identityFingerprint,
      principal: 'credential_authenticated_plugin',
    };
    noteActingUser(c, detail);
    const retainedLinks = source.links.filter(link => !changes.some(change => change.before.id === link.page_id && change.tags !== undefined));
    const expectedLinks = [...retainedLinks];
    const newVersions: Array<{ uuid: string; page_id: number; lect: string | null; action: string }> = [];
    const relationshipGuards: D1PreparedStatement[] = [];

    const groups: MutationGroup[] = denied.map(refusal => ({
      evidence: {
        entry: { action: 'page.update', entityType: 'page', entityId: refusal.page.uuid,
          outcome: 'denied', detail: { ...detail, reason: refusal.reason } },
        dataClass: source.classification(refusal.page),
      },
    }));
    for (const change of changes) {
      const { before, next } = change;
      const check: D1PreparedStatement[] = [];
      if (next.page_id !== before.page_id && next.page_id !== null) {
        if (!Number.isSafeInteger(next.page_id) || next.page_id <= 0) throw new Error('Invalid parent');
        check.push(abortIf(c.env, `NOT EXISTS(SELECT 1 FROM pages WHERE id=? AND ${legacyPageFilter('pages.uuid')})`, [next.page_id]));
      }
      if (next.slug !== before.slug) {
        check.push(abortIf(c.env, 'EXISTS(SELECT 1 FROM pages WHERE slug=? AND id<>?)', [next.slug, before.id]));
      }
      relationshipGuards.push(...check);

      const writes: PlannedWrite[] = [{
        sql: `UPDATE pages SET ${CONTENT.map(field => `${field}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        args: [...CONTENT.map(field => next[field]), before.id],
      }];
      const oldLinks = source.links.filter(link => link.page_id === before.id);
      const newLinks: Row[] = [];
      if (change.tags !== undefined) {
        writes.push({ sql: 'DELETE FROM page_tags WHERE page_id=?', args: [before.id], changes: oldLinks.length });
        for (const tagId of new Set(change.tags)) {
          const uuid = crypto.randomUUID();
          newLinks.push({ uuid, page_id: before.id, tag_id: tagId, weight: 5, created_at: null, updated_at: null });
          writes.push({
            sql: `INSERT INTO page_tags(id,uuid,page_id,tag_id) SELECT ${nextIdSql('page_tags')},?,?,?`,
            args: [uuid, before.id, tagId],
          });
        }
        expectedLinks.push(...newLinks);
      }

      const version = { uuid: crypto.randomUUID(), page_id: before.id, lect: next.lect, action: change.action };
      newVersions.push(version);
      writes.push({
        sql: `INSERT INTO page_versions(id,uuid,page_id,lect,action) VALUES (${NEXT_SNAPSHOT_ID_SQL},?,?,?,?)`,
        args: [version.uuid, version.page_id, version.lect, version.action],
      });
      const linksEvidence = (links: Row[]) => links.map(({ uuid, tag_id, weight }) => ({ uuid, tag_id, weight }));
      groups.push({
        check, writes,
        evidence: {
          entry: {
            action: 'page.update', entityType: 'page', entityId: before.uuid,
            detail: {
              ...detail,
              fields: [...CONTENT.filter(field => before[field] !== next[field]), 'history', ...(change.tags === undefined ? [] : ['tags'])],
              version_uuid: version.uuid,
              ...(change.tags === undefined ? {} : { tags_before: linksEvidence(oldLinks), tags_after: linksEvidence(newLinks) }),
            },
          },
          dataClass: source.classification(before, extraTags),
        },
      });
    }
    json(expectedLinks);
    json(newVersions);

    const finalPages = source.pages.map(page => {
      const change = changes.find(change => change.before.id === page.id);
      return change ? { ...change.next, updated_at: null } : page;
    });
    return {
      groups,
      expect: since => [
        resultGuard(c, 'pages', PAGE, finalPages, since, 'id IN (SELECT value FROM json_each(?))', source.args),
        resultGuard(c, 'page_tags', LINK.filter(field => field !== 'id'), expectedLinks, since, source.selected, source.args),
        abortIf(c.env, "EXISTS(SELECT 1 FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?)) AND (typeof(id)<>'integer' OR id<1 OR id>9007199254740991))", source.args),
        abortIf(c.env, `(SELECT COUNT(*) FROM page_versions WHERE ${source.selected})<>?
          OR EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM page_versions r WHERE ${HISTORY.map(field => `r.${field} IS json_extract(e.value,'$.${field}')`).join(' AND ')}))`,
        [...source.args, source.versions.length + newVersions.length, json(source.versions)]),
        guard(c, 'tags', TAG, source.tags, extraWhere, [json([...new Set(source.links.map(link => link.tag_id))])]),
        guard(c, 'tags', TAG, extraTags, extraWhere, extraArgs),
        ...newVersions.map(version => abortIf(c.env, `NOT EXISTS(SELECT 1 FROM page_versions WHERE
          uuid=? AND page_id=? AND lect IS ? AND action=? AND typeof(id)='integer' AND id BETWEEN 1 AND 9007199254740991
          AND created_at>=? AND created_at<=CURRENT_TIMESTAMP AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP)`,
        [version.uuid, version.page_id, version.lect, version.action, since, since])),
        ...source.pages.map(page => {
          const retained = Number(source.floors.find(row => row.uuid === page.uuid)?.level ?? 0);
          const change = changes.find(change => change.before.id === page.id);
          const targets = change?.tags ?? source.links.filter(link => link.page_id === page.id).map(link => Number(link.tag_id));
          const classes = [classFor(tools.policy, 'page_type', page.page_type ?? 'default'),
            ...[...source.tags, ...extraTags].filter(tag => targets.includes(Number(tag.id)))
              .map(tag => classFor(tools.policy, 'taxonomy', String(tag.taxonomy_slug ?? 'default')))];
          const expected = change ? Math.max(retained, classes.includes('phi') ? 2 : classes.includes('pii') ? 1 : 0) : retained;
          return abortIf(c.env, 'COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<>?', [page.uuid, expected]);
        }),
        abortIf(c.env, `EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(
          SELECT 1 FROM page_tags r WHERE ${LINK.map(field => `r.${field} IS json_extract(e.value,'$.${field}')`).join(' AND ')}))`, [json(retainedLinks)]),
        ...relationshipGuards,
      ],
      returning: { sql: 'SELECT * FROM pages WHERE id IN (SELECT value FROM json_each(?))', args: [json(changeIds)] },
    };
  }) as unknown as Page[];
  const byId = new Map(saved.map(page => [page.id, page]));
  if (saved.length !== changes.length || changes.some(change => !byId.has(change.before.id))) return unavailable(c, authority.actor);
  return changes.map(change => byId.get(change.before.id)!);
}
