import type { AppContext } from '../../core/http/context';
import type { Page } from '../../types';
import type { PluginAuth } from './api/types';
import { cmsConfig } from '../../cms-config';
import { serviceMutationAuditEvidence, ServiceMutationUnavailableError, type AuditActor } from '../../core/db/audit';
import { resolveDataClasses, classFor, classificationPolicyGuard } from '../../core/db/data-classes';
import { snapshot, guard, resultGuard, fingerprint, json, type Row } from '../../core/db/bounded-mutation';
import { abortIf } from '../../core/db/transaction-guard';
import { timingSafeEqualStr } from '../../core/http/crypto';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { requestContext } from '../../core/http/request-context';
import { NEXT_SNAPSHOT_ID_SQL } from '../../core/pages/snapshot-id';
import { pageTypeScopeAllows } from './page-types';

const REGISTRY = ['id','uuid','created_at','updated_at','label','url','enabled','config','sort_order','secret'];
const IDENTITY = ['plugin_row_id','manifest_id','created_at','updated_at','approved_by'];
const APPROVAL = ['id','created_at','updated_at','plugin_id','page_type','access','approved_by'];
const PAGE = ['id','uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'];
const CONTENT = ['name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'] as const;
const LINK = ['id','uuid','created_at','updated_at','page_id','tag_id','weight'];
const HISTORY = ['id','uuid','created_at','updated_at','page_id','action'];
const TAG = ['id','uuid','taxonomy_slug'];
const FLOOR = ['uuid','level'];
const brand = Symbol('plugin-page-update-authority');
type Class = 'none'|'pii'|'phi';
function maximum(classes: Array<Class | undefined | null>): Class { return classes.includes('phi') ? 'phi' : classes.includes('pii') ? 'pii' : 'none'; }
async function unavailable(c: AppContext, actor?: AuditActor): Promise<never> {
  await recordAuditOutage(c.env, 'health', [], actor, undefined, { captureIncomplete: true });
  throw new ServiceMutationUnavailableError();
}
/** Capture before reading the body. Blueprint declarations and wildcard
 * delegation remain requests: current exact write approvals are required. */
export async function capturePluginPageUpdateAuthority(c: AppContext, auth: PluginAuth) {
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
    const dataClass = maximum(['plugins','plugin_identity_approvals','plugin_page_type_approvals','pages','page_versions','page_tags','tags','taxonomies','page_sensitivity_floors','audit_events'].map(table => classFor(policy, 'table', table)).concat(classFor(policy, 'plugin', auth.pluginId)));
    await auditBackgroundReads(c.env, ['plugins','plugin_identity_approvals','plugin_page_type_approvals','audit_events'].map(table => ({ action: 'plugin.page-update-authority-read', kind: 'table' as const, key: table, targetType: table === 'audit_events' ? 'plugin_registry_journal' : table, ids: table === 'plugin_page_type_approvals' ? approvals.map(row => String(row.id)) : [table === 'audit_events' ? registration.uuid : String(registration.id)], count: table === 'plugin_page_type_approvals' ? approvals.length : 1, minimumClass: dataClass === 'none' ? undefined : dataClass })), actor);
    const check = () => [guard(c, 'plugins', REGISTRY, rows, 'id=?', [registration.id]), guard(c, 'plugin_identity_approvals', IDENTITY, pins, 'plugin_row_id=?', [registration.id]), guard(c, 'plugin_page_type_approvals', APPROVAL, approvals, 'plugin_id=?', [auth.pluginId]), classificationPolicyGuard(c.env, policy), abortIf(c.env, "(SELECT COALESCE(MAX(seq),0) FROM audit_events WHERE target_type='plugin' AND target_id=?)<>?", [registration.uuid, journal.generation])];
    return { [brand]: true as const, actor, policy, dataClass, check, allowed, registryId: registration.id, identityFingerprint: await fingerprint(auth.pluginId) };
  } catch { return unavailable(c); }
}
type Authority = Awaited<ReturnType<typeof capturePluginPageUpdateAuthority>>;

/** Bounded selected rows; all result decisions, including mixed-batch denials,
 * are tied to this exact source through the final transaction. */
export async function readPluginPageUpdateSources(c: AppContext, authority: Authority, ids: number[]) {
  try {
    if (!authority?.[brand] || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new Error('Invalid page source manifest');
    const args = [json(ids)], where = 'id IN (SELECT value FROM json_each(?))';
    const pages = await snapshot<Page>(c, 'pages', PAGE, where, args);
    const selected = 'page_id IN (SELECT value FROM json_each(?))';
    const links = await snapshot<Row>(c, 'page_tags', LINK, selected, args);
    const versions = await snapshot<Row>(c, 'page_versions', HISTORY, selected, args);
    const tags = await snapshot<Row>(c, 'tags', TAG, 'id IN (SELECT value FROM json_each(?))', [json([...new Set(links.map(link => link.tag_id))])]);
    const floorArgs = [json(pages.map(page => page.uuid))];
    const floors = await snapshot<Row>(c, 'page_sensitivity_floors', FLOOR, 'uuid IN (SELECT value FROM json_each(?))', floorArgs);
    if (floors.some(row => row.level !== 1 && row.level !== 2)) throw new Error('Invalid page floor');
    const classification = (page: Page, extraTags: Row[] = []) => maximum([authority.dataClass, classFor(authority.policy, 'page_type', page.page_type ?? 'default'),
      floors.find(row => row.uuid === page.uuid)?.level === 2 ? 'phi' : floors.find(row => row.uuid === page.uuid)?.level === 1 ? 'pii' : undefined,
      ...[...tags.filter(tag => links.some(link => link.page_id === page.id && link.tag_id === tag.id)), ...extraTags].map(tag => classFor(authority.policy, 'taxonomy', String(tag.taxonomy_slug ?? 'default')))]);
    await auditBackgroundReads(c.env, pages.map(page => ({ action: 'plugin.page-update-source-read', kind: 'page_type' as const, key: page.page_type ?? 'default', targetType: 'page', ids: [String(page.id)], count: 1, uuidById: { [String(page.id)]: page.uuid }, minimumClass: classification(page) === 'none' ? undefined : classification(page) as 'pii'|'phi' })), authority.actor);
    const check = () => [...authority.check(), guard(c, 'pages', PAGE, pages, where, args), guard(c, 'page_tags', LINK, links, selected, args), guard(c, 'page_versions', HISTORY, versions, selected, args), guard(c, 'tags', TAG, tags, 'id IN (SELECT value FROM json_each(?))', [json([...new Set(links.map(link => link.tag_id))])]), guard(c, 'page_sensitivity_floors', FLOOR, floors, 'uuid IN (SELECT value FROM json_each(?))', floorArgs)];
    return { pages, links, versions, tags, floors, ids, args, selected, classification, check };
  } catch { return unavailable(c, authority?.actor); }
}
type Sources = Awaited<ReturnType<typeof readPluginPageUpdateSources>>;
export interface PluginPageUpdate { before: Page; next: Page; action: string; tags?: number[] }
export interface PluginPageUpdateDenial { page: Page; reason: 'forbidden_page_type'|'version_precondition' }

/** All accepted page/history/tag changes and per-page success/denial receipts
 * share one transaction. No HTTP user or CMS session is manufactured. */
export async function commitPluginPageUpdates(c: AppContext, authority: Authority, source: Sources, changes: PluginPageUpdate[], denied: PluginPageUpdateDenial[] = []): Promise<Page[]> {
  assertRegulatedWritesAllowed(c.env);
  try {
    if (!authority?.[brand] || changes.length > 100 || new Set([...changes.map(change => change.before.id), ...denied.map(row => row.page.id)]).size !== changes.length + denied.length) throw new Error('Invalid page update manifest');
    const extraIds = [...new Set(changes.flatMap(change => change.tags ?? []))];
    if (extraIds.length > 5000 || extraIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid association manifest');
    const extraArgs = [json(extraIds)], extraWhere = 'id IN (SELECT value FROM json_each(?))';
    const extraTags = await snapshot<Row>(c, 'tags', TAG, extraWhere, extraArgs);
    if (extraTags.length !== extraIds.length) throw new Error('Tag target unavailable');
    for (const change of changes) {
      if (!source.pages.some(page => json(page) === json(change.before)) || !pageTypeScopeAllows(authority.allowed, change.before.page_type ?? '') || change.next.id !== change.before.id || change.next.uuid !== change.before.uuid || change.next.page_type !== change.before.page_type) throw new Error('Page source or authority changed');
    }
    for (const denial of denied) {
      if (!source.pages.some(page => json(page) === json(denial.page)) || (denial.reason === 'forbidden_page_type' && pageTypeScopeAllows(authority.allowed, denial.page.page_type ?? ''))) throw new Error('Invalid page refusal');
    }
    const minimum = maximum([...changes.map(change => source.classification(change.before, extraTags)), ...denied.map(row => source.classification(row.page))]);
    await auditBackgroundReads(c.env, ['page_versions','page_tags','tags','page_sensitivity_floors','audit_events'].map(table => ({ action: 'plugin.page-update-metadata-read', kind: 'table' as const, key: table, targetType: table, ids: table === 'page_versions' ? source.versions.map(row => String(row.id)) : table === 'page_tags' ? source.links.map(row => String(row.id)) : table === 'tags' ? [...new Set([...source.tags, ...extraTags].map(row => String(row.id)))] : source.floors.map(row => String(row.uuid)), count: table === 'page_versions' ? source.versions.length : table === 'page_tags' ? source.links.length : table === 'tags' ? source.tags.length + extraTags.length : source.floors.length, minimumClass: minimum === 'none' ? undefined : minimum })), authority.actor);
    if (await flushReadAudit(c)) throw new Error('Page source evidence unavailable');
    const clock = await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{ now: string }>();
    if (!clock) throw new Error('Clock unavailable');
    const operationId = crypto.randomUUID();
    const detail: Record<string,unknown> = { operation_id: operationId, registry_id: authority.registryId, identity_fingerprint: authority.identityFingerprint, principal: 'credential_authenticated_plugin' };
    const asserted = c.req.header('x-acting-user-id');
    if (asserted !== undefined) { const id = Number(asserted); detail.acting_user_verified = false; if (/^\d+$/.test(asserted) && Number.isSafeInteger(id) && id > 0) detail.asserted_user_id = id; else detail.acting_user_unrecordable = true; }
    const statements = [...source.check(), guard(c, 'tags', TAG, extraTags, extraWhere, extraArgs)];
    const expectedLinks = source.links.filter(link => !changes.some(change => change.before.id === link.page_id && change.tags !== undefined));
    const newVersions: Array<{uuid:string;page_id:number;lect:string|null;action:string}> = [];
    const receiptGuards: D1PreparedStatement[] = [];
    const relationshipGuards: D1PreparedStatement[] = [];
    for (const refusal of denied) {
      const receipt = serviceMutationAuditEvidence(c.env, { action: 'page.update', entityType: 'page', entityId: refusal.page.uuid, outcome: 'denied', detail: { ...detail, reason: refusal.reason } }, authority.actor, source.classification(refusal.page), authority.policy, c);
      statements.push(receipt.write, receipt.guard); receiptGuards.push(receipt.guard);
    }
    for (const change of changes) {
      const { before, next } = change;
      if (next.page_id !== before.page_id && next.page_id !== null) {
        if (!Number.isSafeInteger(next.page_id) || next.page_id <= 0) throw new Error('Invalid parent');
        // Existence, not an implicit grant to edit or read the parent's body.
        const parentGuard = abortIf(c.env, 'NOT EXISTS(SELECT 1 FROM pages WHERE id=?)', [next.page_id]);
        statements.push(parentGuard); relationshipGuards.push(parentGuard);
      }
      if (next.slug !== before.slug) { const slugGuard = abortIf(c.env, 'EXISTS(SELECT 1 FROM pages WHERE slug=? AND id<>?)', [next.slug, before.id]); statements.push(slugGuard); relationshipGuards.push(slugGuard); }
      statements.push(c.env.DB.prepare(`UPDATE pages SET ${CONTENT.map(field => `${field}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...CONTENT.map(field => next[field]), before.id), abortIf(c.env, 'changes()<>1'));
      if (change.tags !== undefined) {
        statements.push(c.env.DB.prepare('DELETE FROM page_tags WHERE page_id=?').bind(before.id));
        for (const tagId of [...new Set(change.tags)]) {
          const uuid = crypto.randomUUID();
          expectedLinks.push({ uuid, page_id: before.id, tag_id: tagId, weight: 5, created_at: null, updated_at: null });
          statements.push(c.env.DB.prepare(`INSERT INTO page_tags(id,uuid,page_id,tag_id) SELECT (SELECT MAX(COALESCE(MAX(id),0),(CAST(strftime('%s','now') AS INTEGER)-1563741060)*100000+(RANDOM() & 65535))+1 FROM page_tags),?,?,?`).bind(uuid, before.id, tagId), abortIf(c.env, 'changes()<>1'));
        }
      }
      const version = { uuid: crypto.randomUUID(), page_id: before.id, lect: next.lect, action: change.action }; newVersions.push(version);
      statements.push(c.env.DB.prepare(`INSERT INTO page_versions(id,uuid,page_id,lect,action) VALUES (${NEXT_SNAPSHOT_ID_SQL},?,?,?,?)`).bind(version.uuid, version.page_id, version.lect, version.action), abortIf(c.env, 'changes()<>1'));
      const oldLinks = source.links.filter(link => link.page_id === before.id);
      const receipt = serviceMutationAuditEvidence(c.env, { action: 'page.update', entityType: 'page', entityId: before.uuid, detail: { ...detail,
        fields: [...CONTENT.filter(field => before[field] !== next[field]), 'history', ...(change.tags === undefined ? [] : ['tags'])], version_uuid: version.uuid,
        ...(change.tags === undefined ? {} : { tags_before: oldLinks.map(link => ({ uuid: link.uuid, tag_id: link.tag_id, weight: link.weight })), tags_after: expectedLinks.filter(link => link.page_id === before.id).map(link => ({ uuid: link.uuid, tag_id: link.tag_id, weight: link.weight })) }) } }, authority.actor, source.classification(before, extraTags), authority.policy, c);
      statements.push(receipt.write, receipt.guard); receiptGuards.push(receipt.guard);
    }
    json(expectedLinks); json(newVersions);
    const finals = source.pages.map(page => { const change = changes.find(change => change.before.id === page.id); return change ? { ...change.next, updated_at: null } : page; });
    statements.push(resultGuard(c, 'pages', PAGE, finals, clock.now, 'id IN (SELECT value FROM json_each(?))', source.args),
      resultGuard(c, 'page_tags', LINK.filter(field => field !== 'id'), expectedLinks, clock.now, source.selected, source.args),
      abortIf(c.env, "EXISTS(SELECT 1 FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?)) AND (typeof(id)<>'integer' OR id<1 OR id>9007199254740991))", source.args),
      abortIf(c.env, `(SELECT COUNT(*) FROM page_versions WHERE ${source.selected})<>? OR EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM page_versions r WHERE ${HISTORY.map(field => `r.${field} IS json_extract(e.value,'$.${field}')`).join(' AND ')}))`, [...source.args, source.versions.length + newVersions.length, json(source.versions)]),
      guard(c, 'tags', TAG, source.tags, 'id IN (SELECT value FROM json_each(?))', [json([...new Set(source.links.map(link => link.tag_id))])]), guard(c, 'tags', TAG, extraTags, extraWhere, extraArgs));
    for (const version of newVersions) statements.push(abortIf(c.env, "NOT EXISTS(SELECT 1 FROM page_versions WHERE uuid=? AND page_id=? AND lect IS ? AND action=? AND typeof(id)='integer' AND id BETWEEN 1 AND 9007199254740991 AND created_at>=? AND created_at<=CURRENT_TIMESTAMP AND updated_at>=? AND updated_at<=CURRENT_TIMESTAMP)", [version.uuid, version.page_id, version.lect, version.action, clock.now, clock.now]));
    for (const page of source.pages) {
      const retained = source.floors.find(row => row.uuid === page.uuid)?.level ?? 0;
      const affected = changes.find(change => change.before.id === page.id);
      const targetIds = affected?.tags ?? source.links.filter(link => link.page_id === page.id).map(link => Number(link.tag_id));
      const classes = [classFor(authority.policy, 'page_type', page.page_type ?? 'default'), ...[...source.tags, ...extraTags].filter(tag => targetIds.includes(Number(tag.id))).map(tag => classFor(authority.policy, 'taxonomy', String(tag.taxonomy_slug ?? 'default')))];
      const expectedFloor = affected ? Math.max(Number(retained), classes.includes('phi') ? 2 : classes.includes('pii') ? 1 : 0) : retained;
      statements.push(abortIf(c.env, 'COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid=?),0)<>?', [page.uuid, expectedFloor]));
    }
    // A later page/version trigger must not corrupt an earlier page's receipt.
    // SELECT-only checks preserve SQLite changes() from the last receipt insert.
    const retainedLinks = source.links.filter(link => !changes.some(change => change.before.id === link.page_id && change.tags !== undefined));
    statements.push(abortIf(c.env, `EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM page_tags r WHERE ${LINK.map(field => `r.${field} IS json_extract(e.value,'$.${field}')`).join(' AND ')}))`, [json(retainedLinks)]));
    statements.push(...receiptGuards, ...relationshipGuards, ...authority.check(), c.env.DB.prepare('SELECT * FROM pages WHERE id IN (SELECT value FROM json_each(?))').bind(json(changes.map(change => change.before.id))));
    const results = await c.env.DB.batch(statements);
    const saved = results.at(-1)!.results as Page[];
    if (saved.length !== changes.length) throw new Error('Page result unavailable');
    return changes.map(change => saved.find(page => page.id === change.before.id)!);
  } catch { return unavailable(c, authority?.actor); }
}
