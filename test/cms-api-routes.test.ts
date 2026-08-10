// The /__cms plugin write-back surface, pinned.
//
// This router is a public contract: live plugin Workers call these paths with
// their own secret, so a path that moves or disappears breaks them silently
// from the CMS side. It is also order-sensitive — Hono matches in registration
// order, so `DELETE /pages/batch` must stay ahead of `DELETE /pages/:id` or
// "batch" starts being read as a page id. The same holds for
// PATCH /pages/batch and the static /pages/* POSTs.
//
// Splitting cms-api.ts into per-resource modules is exactly the kind of change
// that can reorder registrations without any other test noticing.
//
// The surface is assembled from two routers mounted at the same prefix: the
// platform's own write-back API, and the credits endpoints, which live with
// the credits engine so the two features install independently. Callers see
// one flat set of paths, so that is what this pins.

import { describe, expect, it } from 'vitest';
import { cmsApiRoutes } from '../src/features/plugins/api';
import { creditApiRoutes } from '../src/features/credits/routes/contributor-api';

const pathsOf = (router: { routes: Array<{ method: string; path: string }> }) =>
  router.routes.map((route) => `${route.method} ${route.path}`);

const EXPECTED = [
  'GET /limits',
  'GET /credits',
  'GET /credits/quote',
  'POST /credits/charge',
  'POST /credits/usage',
  'GET /credits/subscriptions',
  'GET /content-meta',
  'POST /tags/ensure',
  'GET /pages',
  'POST /pages/list-batch',
  'POST /pages/search',
  'POST /pages/publish',
  'GET /pages/:id',
  'POST /pages',
  'POST /pages/batch',
  'POST /pages/duplicate',
  'PATCH /pages/batch',
  'PUT /pages/:id',
  'PATCH /pages/:id',
  'DELETE /pages/batch',
  'DELETE /pages/children',
  'POST /ingest/submissions',
  'DELETE /pages/:id',
  'GET /state',
  'GET /state/:key',
  'PUT /state/:key',
  'DELETE /state/:key',
  'GET /files',
  'HEAD /files',
  'PUT /files',
];

describe('/__cms route table', () => {
  it('registers exactly the documented plugin API surface', () => {
    // Compared as a set: the order of two routes that cannot both match a
    // request (say GET /credits vs DELETE /pages/:id) carries no meaning, and
    // pinning it would just make grouping routes by resource look like a
    // breaking change. The order that does matter is asserted below.
    const table = [...pathsOf(cmsApiRoutes), ...pathsOf(creditApiRoutes)];
    expect(table.slice().sort()).toEqual(EXPECTED.slice().sort());
    expect(table).toHaveLength(EXPECTED.length);
  });

  it('keeps the static /pages sub-paths ahead of the :id catch-alls', () => {
    const table = pathsOf(cmsApiRoutes);
    const before = (specific: string, catchAll: string) => {
      expect(table.indexOf(specific), `${specific} missing`).toBeGreaterThan(-1);
      expect(table.indexOf(catchAll), `${catchAll} missing`).toBeGreaterThan(-1);
      expect(table.indexOf(specific)).toBeLessThan(table.indexOf(catchAll));
    };
    before('DELETE /pages/batch', 'DELETE /pages/:id');
    before('DELETE /pages/children', 'DELETE /pages/:id');
    before('PATCH /pages/batch', 'PATCH /pages/:id');
  });
});
