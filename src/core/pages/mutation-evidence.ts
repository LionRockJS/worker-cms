import { ContentBatchEvidenceUnavailableError } from './batch-mutation-evidence';
import type { Page, PageVersion } from '../../types';
import type { AppContext } from '../http/context';
import { captureAccessAuthorization } from '../auth/access-authorization';
import { recordPolicyDenial } from '../auth/denials';
import { classFor, resolveDataClasses, classificationPolicyGuard } from '../db/data-classes';
import { mutationAuditEvidence, contextActor } from '../db/audit';
import { recordAuditOutage } from '../db/audit-outages';
import { abortIf } from '../db/transaction-guard';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';
import { recordPageReads, flushReadAudit } from '../http/access-log';

const fields = ['uuid','created_at','updated_at','name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'] as const;
export type DraftContent = Pick<Page, 'name'|'slug'|'weight'|'start'|'end'|'timezone'|'page_type'|'lect'|'page_id'|'creator'|'editors'>;
const contentFields = ['name','slug','weight','start','end','timezone','page_type','lect','page_id','creator','editors'] as const;

function pageGuard(c: AppContext, page: Page) {
  return abortIf(c.env, `NOT EXISTS (SELECT 1 FROM pages WHERE id = ? AND ${fields.map(f => `${f} IS ?`).join(' AND ')})`,
    [page.id, ...fields.map(f => page[f])]);
}
function tagsGuard(c: AppContext, uuid: string, ids: number[]) {
  return abortIf(c.env, `(SELECT COUNT(*) FROM page_tags WHERE page_id = (SELECT id FROM pages WHERE uuid = ?)) <> ?
    OR EXISTS (SELECT 1 FROM page_tags WHERE page_id = (SELECT id FROM pages WHERE uuid = ?) AND tag_id NOT IN (SELECT value FROM json_each(?)))`,
  [uuid, ids.length, uuid, JSON.stringify(ids)]);
}

/** Admin draft edits only. Other writer identities must supply their own
 * service/delegation contract rather than manufacturing an HTTP actor. */
async function prepare(c: AppContext, before: Page | undefined, next: DraftContent | undefined, submittedTags?: unknown[]) {
  assertRegulatedWritesAllowed(c.env);
  const authority = await captureAccessAuthorization(c.env, c.get('user'), 'content:write');
  if (!authority.allowed) { await recordPolicyDenial(c, 'management_permission_changed'); throw new Error('Content authority changed'); }
  const policy = await resolveDataClasses(c.env, true);
  if (!policy.ok) throw new Error('Content classification unavailable');
  const selected = submittedTags === undefined ? undefined : [...new Set(submittedTags.map(Number).filter(Number.isFinite))];
  if ((selected?.length ?? 0) > 5000) throw new Error('Content tag manifest requires review');
  if (selected?.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid content tags');
  const [links, tags, floor, versions] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ? ORDER BY tag_id LIMIT 5001').bind(before?.id ?? -1),
    c.env.DB.prepare(`SELECT id, taxonomy_slug FROM tags WHERE id IN (SELECT value FROM json_each(?))
      OR id IN (SELECT tag_id FROM page_tags WHERE page_id = ?) ORDER BY id LIMIT 5001`).bind(JSON.stringify(selected ?? []), before?.id ?? -1),
    c.env.DB.prepare('SELECT level FROM page_sensitivity_floors WHERE uuid = ?').bind(before?.uuid ?? ''),
    c.env.DB.prepare('SELECT id FROM page_versions WHERE page_id = ? ORDER BY id LIMIT 5001').bind(before?.id ?? -1),
  ]);
  if (versions.results.length > 5000 || links.results.length > 5000 || tags.results.length > 5000) throw new Error('Content manifest requires review');
  const oldTags = (links.results as Array<{ tag_id: number }>).map(row => row.tag_id);
  const targetTags = selected ?? oldTags;
  const tagRows = tags.results as Array<{ id: number; taxonomy_slug: string | null }>;
  if (targetTags.some(id => !tagRows.some(row => row.id === id))) throw new Error('Content tag unavailable');
  const retained = (floor.results[0] as { level: number } | undefined)?.level ?? null;
  if (retained !== null && retained !== 1 && retained !== 2) throw new Error('Content floor invalid');
  const classes = ['pages','page_versions','page_tags','tags','taxonomies'].map(table => classFor(policy,'table',table));
  for (const type of [before?.page_type, next?.page_type]) classes.push(classFor(policy,'page_type',type ?? 'default'));
  for (const tag of tagRows) classes.push(classFor(policy,'taxonomy',tag.taxonomy_slug ?? 'default'));
  if (retained) classes.push(retained === 2 ? 'phi' : 'pii');
  const dataClass = classes.includes('phi') ? 'phi' : classes.includes('pii') ? 'pii' : 'none';
  if (before) recordPageReads('page.mutation-read',[before]);
  if (await flushReadAudit(c)) throw new Error('Content read evidence unavailable');
  const guards = [authority.guard(), classificationPolicyGuard(c.env,policy)];
  if (before) guards.push(pageGuard(c,before),tagsGuard(c,before.uuid,oldTags),
    abortIf(c.env,'(SELECT level FROM page_sensitivity_floors WHERE uuid = ?) IS NOT ?',[before.uuid,retained]));
  guards.push(abortIf(c.env, `EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM tags t
    WHERE t.id = json_extract(e.value,'$.id') AND t.taxonomy_slug IS json_extract(e.value,'$.taxonomy_slug')))`,[JSON.stringify(tagRows)]));
  const versionIds = (versions.results as Array<{id:number}>).map(row=>row.id);
  guards.push(versionSetGuard(c,before?.id ?? -1,versionIds));
  return { guards, policy, retained, dataClass: dataClass as 'none'|'pii'|'phi', targetTags, versionIds };
}
function versionSetGuard(c: AppContext, pageId: number, ids: number[]) {
  return abortIf(c.env, `(SELECT COUNT(*) FROM page_versions WHERE page_id = ?) <> ?
    OR EXISTS (SELECT 1 FROM page_versions WHERE page_id = ? AND id NOT IN (SELECT value FROM json_each(?)))`,[pageId,ids.length,pageId,JSON.stringify(ids)]);
}

/** Page, new snapshot, tag replacement and exact classified event commit together. */
export async function saveDraftContent(c: AppContext, next: DraftContent, tags: unknown[] | undefined, before?: Page, source?: PageVersion, versionAction?: string): Promise<Page> {
  const prepared = await prepare(c,before,next,tags);
  const uuid = before?.uuid ?? crypto.randomUUID();
  const versionUuid = crypto.randomUUID();
  const statements = prepared.guards;
  if (source) statements.push(abortIf(c.env,'NOT EXISTS (SELECT 1 FROM page_versions WHERE id = ? AND page_id = ? AND uuid = ? AND lect IS ?)',[source.id,before!.id,source.uuid,source.lect]));
  if (before) {
    statements.push(c.env.DB.prepare(`UPDATE pages SET ${contentFields.map(f=>`${f} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(...contentFields.map(f=>next[f]),before.id));
  } else {
    statements.push(c.env.DB.prepare(`INSERT INTO pages (uuid, ${contentFields.join(',')}) VALUES (?, ${contentFields.map(()=>'?').join(',')})`)
      .bind(uuid,...contentFields.map(f=>next[f])));
  }
  statements.push(abortIf(c.env,'changes() <> 1'),
    c.env.DB.prepare('DELETE FROM page_tags WHERE page_id = (SELECT id FROM pages WHERE uuid = ?)').bind(uuid));
  for (const tag of prepared.targetTags) statements.push(c.env.DB.prepare('INSERT INTO page_tags (page_id,tag_id) SELECT id, ? FROM pages WHERE uuid = ?').bind(tag,uuid));
  const action = source ? 'restore' : before ? 'update' : 'create';
  const storedAction = versionAction ?? action;
  statements.push(c.env.DB.prepare('INSERT INTO page_versions (uuid,page_id,lect,action) SELECT ?,id,?,? FROM pages WHERE uuid = ?')
    .bind(versionUuid,next.lect,storedAction,uuid));
  const evidence = mutationAuditEvidence(c,{action:`page.${action}`,entityType:'page',entityId:uuid,
    detail:{fields:before ? contentFields.filter(f=>before[f]!==next[f]) : [...contentFields],version_uuid:versionUuid,
      ...(source ? {source_version_id:source.id}:{}), tag_count:prepared.targetTags.length}},prepared.dataClass,{requirePreviousChange:true,policy:prepared.policy});
  statements.push(evidence.write,evidence.guard,
    abortIf(c.env,`NOT EXISTS (SELECT 1 FROM pages WHERE uuid = ? AND ${contentFields.map(f=>`${f} IS ?`).join(' AND ')})`,[uuid,...contentFields.map(f=>next[f])]),
    tagsGuard(c,uuid,prepared.targetTags),
    abortIf(c.env,`NOT EXISTS (SELECT 1 FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.uuid = ? AND v.uuid = ? AND v.lect IS ? AND v.action = ?)
      OR (SELECT COUNT(*) FROM page_versions WHERE page_id = (SELECT id FROM pages WHERE uuid = ?)) <> ?
      OR EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM page_versions WHERE id = e.value AND page_id = (SELECT id FROM pages WHERE uuid = ?)))`,
    [uuid,versionUuid,next.lect,storedAction,uuid,prepared.versionIds.length+1,JSON.stringify(prepared.versionIds),uuid]),
    abortIf(c.env, `COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid = ?),0) < ?
      OR COALESCE((SELECT level FROM page_sensitivity_floors WHERE uuid = ?),0) > ?
      OR (? IS NOT NULL AND (SELECT id FROM pages WHERE uuid = ?) IS NOT ?)`,
    [uuid,prepared.retained ?? 0,uuid,prepared.dataClass === 'phi' ? 2 : prepared.dataClass === 'pii' ? 1 : 0,before?.id ?? null,uuid,before?.id ?? null]),
    c.env.DB.prepare('SELECT * FROM pages WHERE uuid = ?').bind(uuid));
  const results = await c.env.DB.batch(statements);
  const saved = results[results.length-1].results[0] as Page | undefined;
  if (!saved) throw new Error('Content result unavailable');
  return saved;
}

export async function removeDraftHistory(c: AppContext, before: Page, versionId?: number): Promise<boolean> {
  const prepared = await prepare(c,before,undefined);
  const removed = versionId === undefined ? prepared.versionIds : prepared.versionIds.filter(id=>id===versionId);
  if (!removed.length) return versionId === undefined;
  const remaining = prepared.versionIds.filter(id=>!removed.includes(id));
  const evidence = mutationAuditEvidence(c,{action:versionId === undefined ? 'page.versions.delete':'page.version.delete',entityType:'page',entityId:before.uuid,
    detail:{removed_version_ids:removed,count:removed.length}},prepared.dataClass,{policy:prepared.policy});
  await c.env.DB.batch([...prepared.guards,
    c.env.DB.prepare('DELETE FROM page_versions WHERE page_id = ? AND id IN (SELECT value FROM json_each(?))').bind(before.id,JSON.stringify(removed)),
    abortIf(c.env,'changes() <> ?',[removed.length]),
    evidence.write,evidence.guard,pageGuard(c,before),tagsGuard(c,before.uuid,prepared.targetTags),
    abortIf(c.env,'(SELECT level FROM page_sensitivity_floors WHERE uuid = ?) IS NOT ?',[before.uuid,prepared.retained]),versionSetGuard(c,before.id,remaining)]);
  return true;
}

export async function contentMutationUnavailable(c: AppContext, error?: unknown): Promise<Response> {
  if (String(error).includes('sensitivity_reduction_requires_review')) throw error;
  if (!(error instanceof ContentBatchEvidenceUnavailableError)) await recordAuditOutage(c.env,'health',[],contextActor(c),undefined,{captureIncomplete:true});
  return c.json({error:'Content change unavailable'},503,{'Cache-Control':'no-store'});
}
