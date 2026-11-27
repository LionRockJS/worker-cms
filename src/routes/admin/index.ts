// ============================================================
// Admin routes (all protected by authMiddleware + editorGuard)
//
// Composed from feature sub-routers, all mounted under /admin:
//   pages   – dashboard, /pages/* CRUD, list, publish, trash-on-delete
//   tags    – /tags* and /taxonomies*
//   api     – /api/* JSON endpoints and /upload
//
// Optional features (src/features/index.ts) mount their own routers between
// `pages` and `tags` — where their explicit mounts used to sit. /trash* is
// one of those now.
//
// NOTE on ordering: Hono matches in registration order. The page routes are
// all rooted at /pages or /, so a feature mounted after them cannot be
// shadowed; the orderings that do matter are internal to each router.
// ============================================================

import { Hono } from 'hono';
import { authMiddleware, editorGuard } from '../../core/auth/guards';
import type { Env, Variables } from '../../types';
import { pagesRoutes } from './pages';
import { tagsRoutes } from './tags';
import { profileRoutes } from './profile';
import { apiRoutes } from './api';
import { settingsRoutes } from './settings';
import { configTransferRoutes } from './config-transfer';
import { i18nCatalogRoutes } from './i18n-catalog';
import { viewSourceFor } from '../../core/render/view-source';
import { featureRouters } from '../../features/routers';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply auth to all admin routes
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', editorGuard);

adminRoutes.get('/views/*', async (c) => {
  const path = c.req.path.slice('/admin/views'.length);
  if (!path.startsWith('/') || path.includes('..')) return c.notFound();

  const response = await viewSourceFor(c.env).fetch(`https://views.local${path}`);
  if (!response.ok) return c.notFound();

  const headers = new Headers(response.headers);
  if (path.endsWith('.json')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  } else if (path.endsWith('.liquid')) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
  }
  headers.set('Cache-Control', 'private, max-age=86400');
  return new Response(response.body, { status: response.status, headers });
});

// Mount feature sub-routers. Order matters — see the note above.
adminRoutes.route('/', profileRoutes);
adminRoutes.route('/', pagesRoutes);
// Installed optional features, mounted where their routers used to sit
// explicitly. Removing an entry from src/features/routers.ts unmounts it.
for (const { router } of featureRouters) {
  adminRoutes.route('/', router);
}
adminRoutes.route('/', tagsRoutes);
adminRoutes.route('/', i18nCatalogRoutes);
adminRoutes.route('/', settingsRoutes);
adminRoutes.route('/', configTransferRoutes);
adminRoutes.route('/', apiRoutes);
