// The Files browser: what is in the media bucket and which pages reference it.
//
// Extracted from routes/admin/settings.ts, which mixed it in with branding,
// menu, language and credit settings.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { requirePermission } from '../../../core/auth/guards';
import { renderPage } from '../../../core/render/chrome';
import { logAudit } from '../../../core/db/audit';
import { recordRead } from '../../../core/http/access-log';
import { mediaObjectResponse } from '../security';
import { mediaClassifier } from '../regulated';
import { contentListPage, type ContentListMediaItem } from '../template';

export const mediaFilesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

mediaFilesRoutes.use('/settings/content', requirePermission('menu:manage'));
mediaFilesRoutes.use('/settings/content/*', requirePermission('menu:manage'));

const MEDIA_LIST_PAGE_SIZE = 50;

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function mediaHref(key: string): string {
  return `/media/${encodeKey(key)}`;
}

/** Where an authorized operator fetches an object the public route withholds. */
function regulatedMediaHref(key: string): string {
  return `/admin/media/${encodeKey(key)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function pageReferencesMedia(lect: string | null, key: string): boolean {
  if (!lect) return false;
  const path = `/media/${key}`;
  const encodedPath = mediaHref(key);
  for (const candidate of new Set([path, encodedPath])) {
    let start = lect.indexOf(candidate);
    while (start !== -1) {
      const after = lect[start + candidate.length];
      if (!after || /[?#'"\s<>)\]}]/.test(after)) return true;
      start = lect.indexOf(candidate, start + candidate.length);
    }
  }
  return false;
}

async function linkedPagesForMedia(
  db: D1DatabaseClient,
  keys: string[],
): Promise<Map<string, ContentListMediaItem['linkedPages']>> {
  const links = new Map<string, ContentListMediaItem['linkedPages']>(keys.map((key) => [key, []]));
  if (!keys.length) return links;

  type PageRow = { id: number; name: string; slug: string; lect: string | null };
  // Scan each media-bearing page once, then match only the current R2 batch
  // in memory. A dynamically generated OR-of-LIKE expression can exceed
  // SQLite's complexity limit when the bucket page contains many objects.
  const pages = await db.prepare(
    "SELECT id, name, slug, lect FROM pages WHERE instr(lect, '/media/') > 0 ORDER BY name ASC, id ASC",
  ).all<PageRow>();

  for (const page of pages.results) {
    for (const key of keys) {
      if (!pageReferencesMedia(page.lect, key)) continue;
      links.get(key)?.push({
        name: page.name,
        slug: page.slug,
        editHref: `/admin/pages/${page.id}/edit`,
      });
    }
  }
  return links;
}

mediaFilesRoutes.get('/settings/content', async (c) => {
  if (!c.env.MEDIA_BUCKET) {
    return renderPage(c, contentListPage, { bucketConfigured: false, media: [], nextHref: '' });
  }

  const cursor = c.req.query('cursor') || undefined;
  const listed = await c.env.MEDIA_BUCKET.list({ limit: MEDIA_LIST_PAGE_SIZE, cursor });
  const keys = listed.objects.map((object) => object.key);
  const linkedPages = await linkedPagesForMedia(c.env.DB, keys);
  // A withheld object 404s on /media/..., so the browser must point at the
  // authenticated route instead or every regulated row looks broken.
  const classify = await mediaClassifier(c.env);
  const media: ContentListMediaItem[] = listed.objects.map((object) => ({
    key: object.key,
    mediaHref: classify(object.key) === 'public'
      ? mediaHref(object.key)
      : regulatedMediaHref(object.key),
    size: formatBytes(object.size),
    uploadedAt: object.uploaded.toISOString(),
    linkedPages: linkedPages.get(object.key) ?? [],
  }));
  const nextHref = listed.truncated && listed.cursor
    ? `/admin/settings/content?cursor=${encodeURIComponent(listed.cursor)}`
    : '';

  return renderPage(c, contentListPage, { bucketConfigured: true, media, nextHref });
});

/**
 * Authenticated delivery of an object the public routes withhold. Its own
 * capability rather than `media:upload`, because uploading media and reading
 * regulated media are different job duties — no built-in role holds it, so a
 * deployment grants it deliberately through the Roles admin.
 *
 * Never cached: `no-store` and no validator, so a regulated object does not
 * come to rest in a shared or browser cache the way the public route's
 * year-long `max-age` allows. The read is announced, so the global access log
 * records it against the classified prefix with an actor attached — which is
 * the whole point of serving it here instead.
 */
mediaFilesRoutes.get('/media/:key{.+}', requirePermission('media:regulated'), async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.param('key');
  if (!await c.env.DB.prepare('SELECT 1 FROM media_files WHERE key = ?').bind(key).first()) {
    return c.notFound();
  }

  recordRead({ action: 'media.read', kind: 'media_prefix', key, targetType: 'media', ids: [key], count: 1 });

  const served = await mediaObjectResponse(c.env.MEDIA_BUCKET, key);
  if (!served) return c.notFound();
  const headers = new Headers(served.headers);
  headers.set('Cache-Control', 'no-store');
  headers.delete('ETag');
  return new Response(served.body, { headers });
});

mediaFilesRoutes.post('/settings/content/delete', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = String((await c.req.formData()).get('key') ?? '');
  if (!key) return c.notFound();

  await c.env.MEDIA_BUCKET.delete(key);
  await c.env.DB.prepare('DELETE FROM media_files WHERE key = ?').bind(key).run();
  logAudit(c, 'media.delete', 'media', key);
  return c.redirect('/admin/settings/content', 303);
});

