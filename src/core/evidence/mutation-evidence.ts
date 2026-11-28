import type { Page, PageVersion } from '../../types';
import type { AppContext } from '../http/context';
import type { ContainerKind } from '../db/data-classes';
import { recordPolicyDenial } from '../auth/denials';
import { contextActor } from '../db/audit';
import { recordAuditOutage } from '../db/audit-outages';
import { abortIf } from '../db/transaction-guard';
import { DRAFT_CONTENT_FIELDS, pageSnapshot, type DraftContent } from '../pages/page-snapshot';
import { NEXT_SNAPSHOT_ID_SQL, nextIdSql } from '../pages/snapshot-id';
import { beginAuditedMutation, type DecideTools, type PlannedWrite } from './audited-mutation';
import { ContentBatchEvidenceUnavailableError } from './batch-mutation-evidence';

export type { DraftContent } from '../pages/page-snapshot';

const contentTables = ['pages', 'page_versions', 'page_tags', 'tags', 'taxonomies'];
const contentAssignments = DRAFT_CONTENT_FIELDS.map(field => field + ' = ?').join(', ');
const contentPlaceholders = DRAFT_CONTENT_FIELDS.map(() => '?').join(', ');

function sensitivityReview(error: unknown): boolean {
  return String(error).includes('sensitivity_reduction_requires_review');
}

function beginDraftMutation(c: AppContext, before?: Page, next?: DraftContent) {
  return beginAuditedMutation(c, {
    permission: before ? 'self' : 'content:write',
    onDenied: () => recordPolicyDenial(c, 'management_permission_changed'),
    classify: [
      ...contentTables.map(table => ['table', table] as [ContainerKind, string]),
      ['page_type', next?.page_type ?? 'default'],
    ],
    snapshot: {},
    unavailable: () => new ContentBatchEvidenceUnavailableError(),
    passthrough: sensitivityReview,
  });
}

async function loadDraftPage(c: AppContext, tools: DecideTools, before?: Page, tags?: unknown[]) {
  const page = await tools.source(pageSnapshot(before ?? null, {
    fields: 'content',
    readAction: 'page.mutation-read',
    extraTagIds: tags,
  }));
  if (page === 'denied') {
    await recordPolicyDenial(c, 'management_permission_changed');
    throw new Error('Content authority changed');
  }
  return page;
}

/** Page, new snapshot, tag replacement and exact classified event commit together. */
export async function saveDraftContent(c: AppContext, next: DraftContent, tags: unknown[] | undefined, before?: Page, source?: PageVersion, versionAction?: string): Promise<Page> {
  const mutation = await beginDraftMutation(c, before, next);
  const saved = await mutation.commit(async (_rows, tools) => {
    const page = await loadDraftPage(c, tools, before, tags);
    const uuid = before?.uuid ?? crypto.randomUUID();
    const versionUuid = crypto.randomUUID();
    const action = source ? 'restore' : before ? 'update' : 'create';
    const storedAction = versionAction ?? action;
    const lect = next.lect === null ? null : { document: next.lect };
    const contentValues = DRAFT_CONTENT_FIELDS.map(field => field === 'lect' ? lect : next[field]);
    const writes: PlannedWrite[] = [
      before
        ? { sql: 'UPDATE pages SET ' + contentAssignments + ', updated_at = CURRENT_TIMESTAMP WHERE id = ?', args: [...contentValues, before.id] }
        : { sql: 'INSERT INTO pages (uuid, ' + DRAFT_CONTENT_FIELDS.join(', ') + ') VALUES (?, ' + contentPlaceholders + ')', args: [uuid, ...contentValues] },
      {
        sql: 'DELETE FROM page_tags WHERE page_id = (SELECT id FROM pages WHERE uuid = ?)',
        args: [uuid],
        changes: page.linkCount,
      },
    ];
    if (!before && next.creator) writes.push({
      sql: 'INSERT INTO page_access_policies (page_uuid,owner_id,mode) VALUES (?,?,600)',
      args: [uuid, next.creator],
    });
    for (const tagId of page.targetTags) writes.push({
      sql: 'INSERT INTO page_tags (id,page_id,tag_id) SELECT ' + nextIdSql('page_tags') + ',id,? FROM pages WHERE uuid = ?',
      args: [tagId, uuid],
    });
    writes.push({
      sql: 'INSERT INTO page_versions (id,uuid,page_id,lect,action) SELECT ' + NEXT_SNAPSHOT_ID_SQL + ',?,id,?,? FROM pages WHERE uuid = ?',
      args: [versionUuid, lect, storedAction, uuid],
    });
    const admit = source ? [abortIf(c.env,
      'NOT EXISTS (SELECT 1 FROM page_versions WHERE id = ? AND page_id = ? AND uuid = ? AND lect IS ?)',
      [source.id, before!.id, source.uuid, source.lect],
    )] : undefined;
    return {
      admit,
      writes,
      evidence: { entry: {
        action: 'page.' + action, entityType: 'page', entityId: uuid,
        detail: {
          fields: before ? DRAFT_CONTENT_FIELDS.filter(field => before[field] !== next[field]) : [...DRAFT_CONTENT_FIELDS],
          version_uuid: versionUuid,
          ...(source ? { source_version_id: source.id } : {}),
          tag_count: page.targetTags.length,
        },
      } },
      expect: () => page.expectSave({ uuid, content: next, versionUuid, versionAction: storedAction, dataClass: tools.dataClass() }),
      returning: { sql: 'SELECT * FROM pages WHERE uuid = ?', args: [uuid] },
    };
  });
  return saved as unknown as Page;
}

export async function removeDraftHistory(c: AppContext, before: Page, versionId?: number): Promise<boolean> {
  const mutation = await beginDraftMutation(c, before);
  let found = versionId === undefined;
  await mutation.commit(async (_rows, tools) => {
    const page = await loadDraftPage(c, tools, before);
    const removed = versionId === undefined ? page.versionIds : page.versionIds.filter(id => id === versionId);
    if (!removed.length) return null;
    found = true;
    const remaining = versionId === undefined ? [] : page.versionIds.filter(id => id !== versionId);
    return {
      writes: [{
        sql: 'DELETE FROM page_versions WHERE page_id = ? AND id IN (SELECT value FROM json_each(?))',
        args: [before.id, JSON.stringify(removed)],
        changes: removed.length,
      }],
      evidence: { entry: {
        action: versionId === undefined ? 'page.versions.delete' : 'page.version.delete',
        entityType: 'page', entityId: before.uuid,
        detail: { removed_version_ids: removed, count: removed.length },
      } },
      expect: () => page.expectHistory(remaining),
    };
  });
  return found;
}

export async function contentMutationUnavailable(c: AppContext, error?: unknown): Promise<Response> {
  if (sensitivityReview(error)) throw error;
  if (!(error instanceof ContentBatchEvidenceUnavailableError)) await recordAuditOutage(c.env, 'health', [], contextActor(c), undefined, { captureIncomplete: true });
  return c.json({ error: 'Content change unavailable' }, 503, { 'Cache-Control': 'no-store' });
}
