import type { Env } from '../../types';
import { nextIdSql } from '../pages/snapshot-id';

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
    await db.prepare(`INSERT INTO page_tags (id, page_id, tag_id) VALUES (${nextIdSql('page_tags')}, ?, ?)`)
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

function numericTagIds(tags: unknown[]): number[] {
  return tags
    .map((tag) => Number(tag))
    .filter((tag): tag is number => Number.isFinite(tag));
}
