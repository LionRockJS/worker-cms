// Admin JSON API endpoints.

import { Hono } from 'hono';
import { getLectLocalizedValue, safeParseLect } from '../../core/db/lect';
import type { Env, Variables, Tag, Taxonomy } from '../../types';
import { num } from '../../core/http/forms';
import { requirePermission } from '../../core/auth/guards';
import type { AppContext } from '../../core/http/context';
import { resolveCmsConfig } from '../../core/db/content-config';

export const apiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

apiRoutes.get('/api/parent-pages', requirePermission('content:read'), async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  const excludeId = num(c.req.query('exclude'), 0);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query) {
    const term = `%${query.replaceAll(' ', '%')}%`;
    conditions.push('(name LIKE ? OR slug LIKE ?)');
    params.push(term, term);
  }

  if (excludeId) {
    conditions.push('id != ?');
    params.push(excludeId);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pages = await c.env.DB.prepare(
    `SELECT id, name, slug
     FROM pages
     ${whereSql}
     ORDER BY updated_at DESC, name ASC
     LIMIT 20`,
  )
    .bind(...params)
    .all<{ id: number; name: string; slug: string }>();

  return c.json(pages.results.map((page) => ({
    id: page.id,
    name: page.name,
    slug: page.slug,
    label: `/${page.slug}`,
  })));
});

// Tags for the parent-tag combobox on the tag editor. `q` filters by name or
// slug; `exclude` drops a tag (the one being edited) so it can't be its own
// parent. Without a query, returns the lightest-weighted tags. Mirrors
// /api/parent-pages so the tag form scales past a plain <select>.
apiRoutes.get('/api/parent-tags', requirePermission('content:read'), async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  const excludeId = num(c.req.query('exclude'), 0);
  const config = await resolveCmsConfig(c.env);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query) {
    const term = `%${query.replaceAll(' ', '%')}%`;
    conditions.push('(name LIKE ? OR slug LIKE ?)');
    params.push(term, term);
  }

  if (excludeId) {
    conditions.push('id != ?');
    params.push(excludeId);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const tags = await c.env.DB.prepare(
    `SELECT id, name, slug, lect
     FROM tags
     ${whereSql}
     ORDER BY weight ASC, name ASC
     LIMIT 20`,
  )
    .bind(...params)
    .all<Tag>();

  return c.json(tags.results.map((tag) => ({
    id: tag.id,
    name: getLectLocalizedValue(safeParseLect(tag.lect), 'name', config.defaultLanguage) || tag.name,
    slug: tag.slug,
  })));
});

// Users for the editors combobox on the page editor. `q` filters by name or
// email; without it, returns the most recently active users. Requires
// content:write (not just read) since it enumerates user names/emails and only
// users who can save the form need it.
apiRoutes.get('/api/users', requirePermission('content:write'), async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  const params: unknown[] = [];
  let whereSql = '';

  if (query) {
    const term = `%${query.replaceAll(' ', '%')}%`;
    whereSql = 'WHERE (name LIKE ? OR email LIKE ?)';
    params.push(term, term);
  }

  const users = await c.env.DB.prepare(
    `SELECT id, name, email
     FROM users
     ${whereSql}
     ORDER BY updated_at DESC, name ASC
     LIMIT 20`,
  )
    .bind(...params)
    .all<{ id: number; name: string | null; email: string | null }>();

  return c.json(users.results.map((user) => ({
    id: user.id,
    name: user.name?.trim() || user.email || `#${user.id}`,
    email: user.email ?? '',
  })));
});

// Pages of a given type, for the page-reference field's search combobox
// (src/core/views/snippets/pagefield/page/basic.liquid). `q` filters by name/slug; `id`
// resolves a single page (used to label the current selection). With neither,
// returns the most-recently-updated pages of the type.
apiRoutes.get('/api/pages/:type', requirePermission('content:read'), async (c) => {
  const pageType = c.req.param('type');
  const query = c.req.query('q')?.trim() ?? '';
  const id = num(c.req.query('id'), 0);

  const conditions = ['page_type = ?'];
  const params: unknown[] = [pageType];
  if (id) {
    conditions.push('id = ?');
    params.push(id);
  } else if (query) {
    const term = `%${query.replaceAll(' ', '%')}%`;
    conditions.push('(name LIKE ? OR slug LIKE ?)');
    params.push(term, term);
  }

  const pages = await c.env.DB.prepare(
    `SELECT id, name, slug
     FROM pages
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC, name ASC
     LIMIT 20`,
  )
    .bind(...params)
    .all<{ id: number; name: string; slug: string }>();

  return c.json(pages.results.map((page) => ({
    id: page.id,
    // `page` retained for backward compatibility with earlier callers.
    page: page.id,
    name: page.name,
    slug: page.slug,
    label: `/${page.slug}`,
  })));
});

apiRoutes.get('/api/tags/:type', requirePermission('content:read'), async (c) => {
  const type = c.req.param('type');
  const dbTaxonomy = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE name = ? OR slug = ?')
    .bind(type, type)
    .first<Taxonomy>();
  const config = await resolveCmsConfig(c.env);
  const configSlug = Object.entries(config.taxonomies)
    .find(([slug, name]) => slug === type || name === type)?.[0];
  const taxonomySlug = dbTaxonomy?.slug ?? configSlug;
  if (!taxonomySlug) return c.json([]);
  const tags = await c.env.DB.prepare('SELECT * FROM tags WHERE taxonomy_slug = ? ORDER BY weight ASC, name ASC')
    .bind(taxonomySlug)
    .all<Tag>();
  return c.json(tags.results.map((tag) => ({
    value: tag.id,
    label: getLectLocalizedValue(safeParseLect(tag.lect), 'name', config.defaultLanguage) || tag.name,
  })));
});

apiRoutes.post('/api/page/:pageId/tag/:tagId', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  const tagId = parseInt(c.req.param('tagId'), 10);
  const existing = await c.env.DB.prepare(
    'SELECT id FROM page_tags WHERE page_id = ? AND tag_id = ?',
  )
    .bind(pageId, tagId)
    .first<{ id: number }>();
  if (existing) {
    return c.json({ type: 'ADD_PAGE_TAG', payload: { success: false, message: 'tag exist', id: existing.id } });
  }
  const result = await c.env.DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (?, ?)')
    .bind(pageId, tagId)
    .run();
  const pageTag = await c.env.DB.prepare('SELECT id FROM page_tags WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  await c.env.DB.prepare('UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(pageId).run();
  return c.json({ type: 'ADD_PAGE_TAG', payload: { success: true, id: pageTag?.id } });
});

apiRoutes.delete('/api/page/remove/page_tag/:id', requirePermission('content:write'), async (c) => deletePageTagApi(c));
apiRoutes.delete('/api/page_tag/:id', requirePermission('content:write'), async (c) => deletePageTagApi(c));

async function deletePageTagApi(c: AppContext) {
  const id = parseInt(c.req.param('id') ?? '', 10);
  const pageTag = await c.env.DB.prepare('SELECT page_id FROM page_tags WHERE id = ?')
    .bind(id)
    .first<{ page_id: number }>();
  await c.env.DB.prepare('DELETE FROM page_tags WHERE id = ?').bind(id).run();
  if (pageTag) {
    await c.env.DB.prepare('UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(pageTag.page_id)
      .run();
  }
  return c.json({ type: 'DELETE_PAGE_TAG', payload: { success: true, id } });
}

// ── Lect live sync: LWW fields + Y.Text richtext (WebSocket) ─────────────────

async function draftPageExists(c: AppContext, pageId: number): Promise<boolean> {
  const page = await c.env.DB.prepare('SELECT id FROM pages WHERE id = ?')
    .bind(pageId)
    .first<{ id: number }>();
  return !!page;
}

apiRoutes.get('/api/sync/:pageId', requirePermission('content:write'), async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.text('Invalid page ID', 400);
  if (!(await draftPageExists(c, pageId))) return c.text('Page not found', 404);

  const user = c.get('user');
  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    new Request(c.req.raw.url, {
      headers: {
        Upgrade: 'websocket',
        'X-User-Id': String(user.sub),
        'X-User-Name': user.name,
      },
    }),
  );
});

// ── Presence ─────────────────────────────────────────────────────────────────

apiRoutes.post('/api/presence/:pageId', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.json({ error: 'invalid_page_id' }, 400);
  if (!(await draftPageExists(c, pageId))) return c.json({ error: 'page_not_found' }, 404);

  const user = c.get('user');
  const body = await c.req.json().catch(() => ({})) as { lastActive?: unknown; userAvatar?: unknown };
  const now = new Date().toISOString();

  // Presence is best-effort: invalid fields degrade to safe values rather
  // than failing the heartbeat.
  const lastActive = typeof body.lastActive === 'string'
    && body.lastActive.length <= 40
    && Number.isFinite(Date.parse(body.lastActive))
    ? body.lastActive
    : now;
  const userAvatar = typeof body.userAvatar === 'string'
    && body.userAvatar.length <= 512
    && /^(https:\/\/|\/media\/)/.test(body.userAvatar)
    ? body.userAvatar
    : null;

  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    'https://page-sync/?action=presence',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': String(user.sub),
        'X-User-Name': user.name,
      },
      body: JSON.stringify({ lastSeen: now, lastActive, userAvatar }),
    },
  );
});

apiRoutes.get('/api/presence/:pageId', requirePermission('content:read'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.json({ error: 'invalid_page_id' }, 400);
  if (!(await draftPageExists(c, pageId))) return c.json({ error: 'page_not_found' }, 404);

  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    'https://page-sync/?action=presence',
  );
});

apiRoutes.delete('/api/presence/:pageId', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.json({ error: 'invalid_page_id' }, 400);
  if (!(await draftPageExists(c, pageId))) return c.json({ error: 'page_not_found' }, 404);

  const user = c.get('user');
  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    'https://page-sync/?action=presence',
    {
      method: 'DELETE',
      headers: { 'X-User-Id': String(user.sub) },
    },
  );
});
