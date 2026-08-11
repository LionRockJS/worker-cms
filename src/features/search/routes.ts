// Advanced search pages and bulk actions. (CSV export moved to the
// import-export plugin; renderAdvancedSearch links there when it's installed.)

import { Hono } from 'hono';
import { requirePermission } from '../../core/auth/guards';
import { resolveCmsConfig } from '../../core/db/content-config';
import type { Env, Permission, Variables } from '../../types';
import { coreExtensions } from '../../core/extensions';
import {
  applyBulkPageAction,
  bulkActionFlash,
  resolveBulkTargetIds,
  BULK_ACTION_PAGE_LIMIT,
  type BulkPageAction,
} from '../../core/pages/bulk-action';
import { renderAdvancedSearch, renderBulkReplacePreview } from './render';
import { userCan } from '../../core/auth/permissions';
import type { AppContext } from '../../core/http/context';
import { appendQuery, dashboardStatusFilter, safeAdminReturnPath, str } from '../../core/http/forms';
import {
  advancedSearchOperator,
  advancedSearchSelectedPageType,
  advancedSearchTargetPageTypes,
  parseAdvancedSearchCriteria,
} from '../../core/db/search';

export const searchRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

searchRoutes.get('/advanced-search', requirePermission('content:read'), (c) => renderAdvancedSearch(c));

searchRoutes.post('/advanced-search/bulk', (c) => bulkAdvancedSearch(c));

searchRoutes.get('/advanced-search/:pageType', requirePermission('content:read'), (c) => {
  const pageType = c.req.param('pageType');
  return renderAdvancedSearch(c, pageType, false);
});

searchRoutes.post('/advanced-search/:pageType/bulk', (c) => {
  const pageType = c.req.param('pageType');
  return bulkAdvancedSearch(c, pageType, false);
});

type FormDataEntryValue = string | File;

const BULK_ACTIONS: Record<BulkPageAction, { permission: Permission; queued: string }> = {
  publish: { permission: 'content:publish', queued: 'Bulk publish queued. It may take a moment to finish.' },
  unpublish: { permission: 'content:publish', queued: 'Bulk unpublish queued. It may take a moment to finish.' },
  delete: { permission: 'content:delete', queued: 'Bulk deletion queued. It may take a moment to finish.' },
  add_tag: { permission: 'content:write', queued: 'Bulk tag addition queued. It may take a moment to finish.' },
  remove_tag: { permission: 'content:write', queued: 'Bulk tag removal queued. It may take a moment to finish.' },
  replace_text: { permission: 'content:write', queued: 'Bulk text replacement queued. It may take a moment to finish.' },
};

function bulkAction(value: FormDataEntryValue | null): BulkPageAction | null {
  const action = str(value);
  return action === 'publish' || action === 'unpublish' || action === 'delete' || action === 'add_tag' || action === 'remove_tag' || action === 'replace_text'
    ? action
    : null;
}

function uniqueNumericIds(values: FormDataEntryValue[]): number[] {
  const ids = values
    .map((value) => str(value))
    .filter((value) => /^\d+$/.test(value))
    .map((value) => parseInt(value, 10));
  return Array.from(new Set(ids));
}

function uniquePageIds(values: FormDataEntryValue[]): number[] {
  return uniqueNumericIds(values);
}

function rawText(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

async function bulkAdvancedSearch(
  c: AppContext,
  defaultPageType = 'all',
  canSelectPageType = true,
): Promise<Response> {
  const form = await c.req.formData();
  const action = bulkAction(form.get('bulk_action'));
  const returnTo = safeAdminReturnPath(form.get('return_to'), '/admin/advanced-search');
  if (!action) return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('Choose a bulk action')}`));

  if (!(await userCan(c, BULK_ACTIONS[action].permission))) {
    return c.text('Forbidden: insufficient permissions', 403);
  }

  const scope = str(form.get('scope')) === 'all' ? 'all' : 'selected';
  const ids = uniquePageIds(form.getAll('page_ids'));
  const isTagAction = action === 'add_tag' || action === 'remove_tag';
  const targetTagIds = isTagAction ? uniqueNumericIds(form.getAll('tag_ids')) : [];
  if (isTagAction && !targetTagIds.length) {
    return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('Choose at least one tag')}`));
  }
  const searchText = action === 'replace_text' ? rawText(form.get('search_text')) : '';
  const replacementText = action === 'replace_text' ? rawText(form.get('replacement_text')) : '';
  if (action === 'replace_text' && !searchText) {
    return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('Enter text to find')}`));
  }
  if (searchText.length > 5000 || replacementText.length > 5000) {
    return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('Search and replacement text must be 5000 characters or fewer')}`));
  }
  let pageTypes: string[] = [];
  const criteria = parseAdvancedSearchCriteria(c.req.url);
  const operator = advancedSearchOperator(c.req.query('operator'));
  const isDashboardBulk = c.req.query('dashboard') === '1';
  const status = isDashboardBulk
    ? dashboardStatusFilter(c.req.query('status')) || undefined
    : undefined;

  if (scope === 'all') {
    if (isDashboardBulk) {
      if (defaultPageType !== 'all') {
        // Page-list routes may contain stored page types that are no longer in
        // the active blueprint. Keep the bulk scope on that exact list.
        pageTypes = [defaultPageType];
      } else {
        const rows = await c.env.DB.prepare(
          "SELECT DISTINCT page_type FROM pages WHERE page_type IS NOT NULL AND page_type != ''",
        ).all<{ page_type: string }>();
        pageTypes = rows.results.map((row) => row.page_type);
      }
    } else {
      const config = await resolveCmsConfig(c.env);
      const selectedPageType = canSelectPageType
        ? advancedSearchSelectedPageType(c.req.query('page_type'), defaultPageType, config)
        : advancedSearchSelectedPageType(undefined, defaultPageType, config);
      pageTypes = advancedSearchTargetPageTypes(selectedPageType, config);
    }
  }

  if (scope === 'selected' && !ids.length) {
    return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('No matching pages')}`));
  }

  if (action === 'replace_text' && str(form.get('confirmed')) !== '1') {
    return renderBulkReplacePreview(c, {
      scope,
      ids,
      pageTypes,
      criteria,
      operator,
      status,
      searchText,
      replacementText,
      returnTo,
    });
  }

  // Hand the whole set to a durable runner when one is installed: it walks the
  // ids in bounded slices, surviving the invocation that started it.
  const queued = await coreExtensions().enqueueBulkAction?.(c, {
    action,
    scope,
    ids: scope === 'all' ? [] : ids,
    pageTypes,
    criteria,
    operator,
    status,
    targetTagIds,
    searchText,
    replacementText,
    returnTo,
  }) ?? false;
  if (queued) {
    return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent(BULK_ACTIONS[action].queued)}`));
  }

  return bulkAdvancedSearchInline(c, {
    action,
    scope,
    ids,
    pageTypes,
    criteria,
    operator,
    status,
    targetTagIds,
    searchText,
    replacementText,
    returnTo,
  });
}

/**
 * The no-durable-runner path: apply one bounded slice now and report exactly
 * what was done. Without somewhere to keep a cursor there is nothing to resume
 * from, so a larger set is deliberately left partly done rather than run
 * unbounded into the subrequest limit — the flash says so, and submitting again
 * takes the next slice.
 */
async function bulkAdvancedSearchInline(
  c: AppContext,
  input: {
    action: BulkPageAction;
    scope: 'selected' | 'all';
    ids: number[];
    pageTypes: string[];
    criteria: ReturnType<typeof parseAdvancedSearchCriteria>;
    operator: ReturnType<typeof advancedSearchOperator>;
    status?: 'draft' | 'scheduled' | 'live' | 'ended';
    targetTagIds: number[];
    searchText: string;
    replacementText: string;
    returnTo: string;
  },
): Promise<Response> {
  const targetIds = input.scope === 'all'
    ? await resolveBulkTargetIds(c.env, {
      pageTypes: input.pageTypes,
      criteria: input.criteria,
      operator: input.operator,
      status: input.status,
    })
    : input.ids;

  const slice = targetIds.slice(0, BULK_ACTION_PAGE_LIMIT);
  const outcome = await applyBulkPageAction(c.env, c.get('user'), input.action, slice, {
    targetTagIds: input.targetTagIds,
    searchText: input.searchText,
    replacementText: input.replacementText,
  });
  const remaining = targetIds.length - slice.length;
  const flash = bulkActionFlash(
    input.action,
    outcome.updated,
    outcome.refused,
    [...outcome.failedTargets],
  );
  const note = remaining > 0 ? `${flash}; ${remaining} left — run it again to continue` : flash;
  return c.redirect(appendQuery(input.returnTo, `flash=${encodeURIComponent(note)}`));
}
