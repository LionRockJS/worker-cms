// Registration order inside the page admin.
//
// Hono matches in registration order, so a static path that also fits a
// parameter pattern has to be registered first. In this router that is
// POST /pages/batch-weight and POST /pages/reorder, which /pages/:id would
// otherwise swallow with id="batch-weight" — silently turning a bulk reorder
// into an update of a page that does not exist.
//
// Splitting pages.ts into dashboard/crud/lifecycle modules is exactly the kind
// of change that can reorder registrations, so this pins it. All three routes
// live in crud.ts to keep the constraint local.

import { describe, expect, it } from 'vitest';
import { pagesRoutes } from '../src/routes/admin/pages';

/** Registration order; Hono lists middleware and handler separately, so a
 *  route registered with a permission guard appears more than once. */
const table = () => pagesRoutes.routes.map((route) => `${route.method} ${route.path}`);

describe('admin page route order', () => {
  it('registers the static /pages paths before the :id patterns', () => {
    const order = table();
    const firstOf = (entry: string) => {
      const index = order.indexOf(entry);
      expect(index, `${entry} is not registered`).toBeGreaterThan(-1);
      return index;
    };
    expect(firstOf('POST /pages/batch-weight')).toBeLessThan(firstOf('POST /pages/:id'));
    expect(firstOf('POST /pages/reorder')).toBeLessThan(firstOf('POST /pages/:id'));
  });

  it('serves the whole page admin surface', () => {
    // De-duplicated: guards double up entries, and that is not what this pins.
    expect([...new Set(table())].sort()).toEqual([
      'GET /',
      'GET /pages/:id/edit',
      'GET /pages/:id/read',
      'GET /pages/create_by_type/:pageType',
      'GET /pages/list',
      'GET /pages/list/:pageType',
      'GET /pages/new',
      'GET /pages/search/:pageType',
      'POST /pages',
      'POST /pages/:id',
      'POST /pages/:id/delete',
      'POST /pages/:id/publish',
      'POST /pages/:id/unpublish',
      'POST /pages/:id/weight',
      'POST /pages/batch-weight',
      'POST /pages/new_post/:pageType',
      'POST /pages/pull/:uuid',
      'POST /pages/reorder',
    ]);
  });
});
