import type { Env } from '../../types';
import type { Page, PageTag } from '../../types';
import { savePageVersion } from './admin-queries';
import { auditBackgroundReads } from '../http/access-log';
import type { AuditActor } from './audit';
import { incomingSensitivityStatements } from './sensitivity';
import { readD1PageSource } from '../publish/d1';
import { liveSourceReads } from '../publish/read-audit';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

export async function setDraftPageTags(
  db: D1DatabaseClient,
  pageId: number,
  tags: unknown,
  replace: boolean,
): Promise<void> {
  if (!Array.isArray(tags)) return;
  if (replace) {
    await db.prepare('DELETE FROM page_tags WHERE page_id = ?')
      .bind(pageId)
      .run();
  }

  for (const tagId of numericTagIds(tags)) {
    await db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)')
      .bind(pageId, tagId)
      .run();
  }
}

export async function notifyPageSaved(env: Env, pageId: number): Promise<void> {
  try {
    const id = env.PAGE_SYNC.idFromName(`page-${pageId}`);
    await env.PAGE_SYNC.get(id).fetch('https://page-sync/?action=saved', { method: 'POST' });
  } catch {
    // Sync is a non-critical overlay; never block a save on it.
  }
}

export interface PullPublishedPageResult {
  page: Page;
  created: boolean;
}

export async function pullPublishedPageToDraft(
  env: Env,
  uuid: string,
  actor: AuditActor,
): Promise<PullPublishedPageResult | null> {
  assertRegulatedWritesAllowed(env);
  const { DB: draftDb, PUBLISHED_DB: publishedDb } = env;
  const existing = await draftDb.prepare('SELECT * FROM pages WHERE uuid = ?')
    .bind(uuid)
    .first<Page>();
  if (existing) {
    await auditBackgroundReads(env, [{ action: 'page.pull-existing', kind: 'page_type', key: existing.page_type ?? 'default', targetType: 'page', ids: [String(existing.id)], count: 1,
      uuidById: { [String(existing.id)]: existing.uuid } }], actor);
    return { page: existing, created: false };
  }

  const source = await readD1PageSource<Page>(publishedDb, 'full', 'p.uuid = ?', [uuid]);
  const livePage = source.rows[0];
  if (!livePage) return null;

  // Source evidence must precede the copy, including classifications inherited
  // from the published tag catalogue rather than the draft's associations.
  const evidence = await auditBackgroundReads(env, await liveSourceReads(env, { id: 'd1' }, source.provenance, actor, 'page.pull-read'), actor);

  const parentId = await existingDraftParentId(draftDb, livePage.page_id);
  const insert = draftDb.prepare(
    `INSERT INTO pages (uuid, created_at, updated_at, name, slug, weight, start, end, timezone, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      livePage.uuid,
      livePage.created_at,
      livePage.updated_at,
      livePage.name,
      livePage.slug,
      livePage.weight,
      livePage.start,
      livePage.end,
      livePage.timezone,
      livePage.page_type,
      livePage.lect,
      parentId,
      livePage.creator,
      livePage.editors,
    );
  await draftDb.batch([...incomingSensitivityStatements(draftDb, evidence), insert]);

  const draftPage = await draftDb.prepare('SELECT * FROM pages WHERE uuid = ?')
    .bind(uuid)
    .first<Page>();
  if (!draftPage) return null;

  await copyPublishedTagsToDraft(draftDb, publishedDb, livePage.id, draftPage.id);
  // Records where the row came from; nothing about the page row changes, so
  // the copy selected above is already the final one.
  await savePageVersion(draftDb, draftPage.id, livePage.lect, 'pull-published');

  return { page: draftPage, created: true };
}

function numericTagIds(tags: unknown[]): number[] {
  return tags
    .map((tag) => Number(tag))
    .filter((tag): tag is number => Number.isFinite(tag));
}

async function existingDraftParentId(db: D1DatabaseClient, parentId: number | null): Promise<number | null> {
  if (!parentId) return null;
  const parent = await db.prepare('SELECT id FROM pages WHERE id = ?')
    .bind(parentId)
    .first<{ id: number }>();
  return parent?.id ?? null;
}

async function copyPublishedTagsToDraft(
  draftDb: D1DatabaseClient,
  publishedDb: D1DatabaseClient,
  livePageId: number,
  draftPageId: number,
): Promise<void> {
  const tags = await publishedDb.prepare(
    'SELECT uuid, tag_id, weight FROM page_tags WHERE page_id = ? ORDER BY weight ASC, id ASC',
  )
    .bind(livePageId)
    .all<Pick<PageTag, 'uuid' | 'tag_id' | 'weight'>>();

  for (const tag of tags.results) {
    await draftDb.prepare(
      'INSERT OR IGNORE INTO page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)',
    )
      .bind(tag.uuid, draftPageId, tag.tag_id, tag.weight)
      .run();
  }
}
