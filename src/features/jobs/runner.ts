// Running a claimed job: replay a recorded admin request, or walk a bulk page
// action one bounded slice at a time, re-queueing itself until the set is done.
//
// The bulk action itself is core (core/pages/bulk-action.ts) — the search
// screen runs the same code inline when this feature is not installed. What
// lives here is the durability: the claim, the cursor, the running totals.

import { coreExtensions } from '../../core/extensions';
import type { Env } from '../../types';
import {
  applyBulkPageAction,
  bulkActionFlash,
  resolveBulkTargetIds,
  BULK_ACTION_PAGE_LIMIT,
} from '../../core/pages/bulk-action';
import {
  claimAdminJob,
  completeAdminJob,
  failAdminJob,
  requeueAdminJob,
  type AdminJobRecord,
  type AdvancedSearchBulkActionPayload,
} from './queue';
import { appendQuery } from '../../core/http/forms';

export async function runCmsAdminJob(env: Env, jobId: string): Promise<void> {
  const job = await claimAdminJob(env.DB, jobId);
  if (!job) return;

  try {
    if (job.type === 'plugin_admin_action') {
      await runPluginAdminActionJob(env, job);
    } else if (job.type === 'advanced_search_bulk_action') {
      await runAdvancedSearchBulkActionJob(env, job);
    } else {
      throw new Error(`Unsupported admin job type ${job.type}`);
    }
  } catch (error) {
    await failAdminJob(env.DB, job.id, error);
    console.error(`[cms] admin job ${job.id} failed`, error);
  }
}

async function runPluginAdminActionJob(env: Env, job: AdminJobRecord): Promise<void> {
  if (!job.pluginId || !job.method || !job.path || !job.user) throw new Error('Admin job is missing plugin request data');

  const run = coreExtensions().runPluginAction;
  if (!run) throw new Error('Plugin admin actions require the plugin platform');

  const result = await run(env, {
    pluginId: job.pluginId,
    method: job.method,
    path: job.path,
    contentType: job.contentType,
    body: job.body,
    user: {
      sub: job.user.sub,
      email: job.user.email,
      name: job.user.name,
      role: job.user.role,
    },
  });

  await completeAdminJob(env.DB, job.id, result.status, result.location);
}

async function runAdvancedSearchBulkActionJob(env: Env, job: AdminJobRecord): Promise<void> {
  if (!job.user) throw new Error('Admin job is missing user data');
  let input = parseAdvancedSearchBulkActionJob(job.body);
  if (input.scope === 'all' && !input.resolvedAll) {
    input = {
      ...input,
      ids: await resolveBulkTargetIds(env, {
        pageTypes: input.pageTypes,
        criteria: input.criteria,
        operator: input.operator,
        status: input.status,
      }),
      cursor: 0,
      resolvedAll: true,
    };
  }

  const cursor = Math.max(0, input.cursor ?? 0);
  const pageIds = input.ids.slice(cursor, cursor + BULK_ACTION_PAGE_LIMIT);
  const outcome = await applyBulkPageAction(env, job.user, input.action, pageIds, {
    targetTagIds: input.targetTagIds,
    searchText: input.searchText,
    replacementText: input.replacementText,
  });
  const updated = (input.updated ?? 0) + outcome.updated;
  const refused = (input.refused ?? 0) + outcome.refused;
  const failedTargets = Array.from(new Set([...(input.failedTargets ?? []), ...outcome.failedTargets]));
  const nextCursor = cursor + pageIds.length;

  if (nextCursor < input.ids.length) {
    const nextInput: AdvancedSearchBulkActionPayload = {
      ...input,
      cursor: nextCursor,
      updated,
      refused,
      failedTargets,
    };
    await requeueAdminJob(env.DB, job.id, JSON.stringify(nextInput));
    if (env.ADMIN_JOBS_QUEUE) {
      await env.ADMIN_JOBS_QUEUE.send({ kind: 'cms_admin_job', jobId: job.id });
    } else {
      await runCmsAdminJob(env, job.id);
    }
    return;
  }

  await completeAdminJob(env.DB, job.id, 200, appendQuery(
    input.returnTo,
    `flash=${encodeURIComponent(bulkActionFlash(input.action, updated, refused, failedTargets))}`,
  ));
}

function parseAdvancedSearchBulkActionJob(body: string | null): AdvancedSearchBulkActionPayload {
  const value = body ? JSON.parse(body) as Partial<AdvancedSearchBulkActionPayload> : null;
  if (!value || typeof value !== 'object') throw new Error('Admin job is missing bulk action payload');
  if (value.action !== 'publish' && value.action !== 'unpublish' && value.action !== 'delete' && value.action !== 'add_tag' && value.action !== 'remove_tag' && value.action !== 'replace_text') {
    throw new Error('Admin job has invalid bulk action');
  }
  const scope = value.scope === 'all' ? 'all' : 'selected';
  const ids = Array.isArray(value.ids)
    ? value.ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
    : [];
  const pageTypes = Array.isArray(value.pageTypes)
    ? value.pageTypes.filter((pageType): pageType is string => typeof pageType === 'string' && pageType.length > 0)
    : [];
  const criteria = Array.isArray(value.criteria) ? value.criteria : [];
  const operator = value.operator === 'OR' || value.operator === 'NOT' ? value.operator : 'AND';
  const status = value.status === 'draft'
    || value.status === 'scheduled'
    || value.status === 'live'
    || value.status === 'ended'
    ? value.status
    : undefined;
  const targetTagIds = Array.isArray(value.targetTagIds)
    ? value.targetTagIds.filter((tagId): tagId is number => typeof tagId === 'number' && Number.isInteger(tagId) && tagId > 0)
    : [];
  const searchText = typeof value.searchText === 'string' ? value.searchText : '';
  const replacementText = typeof value.replacementText === 'string' ? value.replacementText : '';
  if (value.action === 'replace_text' && !searchText) throw new Error('Admin job is missing search text');
  if (searchText.length > 5000 || replacementText.length > 5000) throw new Error('Admin job replacement text is too long');
  const returnTo = typeof value.returnTo === 'string' && value.returnTo.startsWith('/admin')
    ? value.returnTo
    : '/admin/advanced-search';
  const cursor = typeof value.cursor === 'number' && Number.isFinite(value.cursor) ? Math.max(0, value.cursor) : 0;
  const updated = typeof value.updated === 'number' && Number.isFinite(value.updated) ? Math.max(0, value.updated) : 0;
  const refused = typeof value.refused === 'number' && Number.isFinite(value.refused) ? Math.max(0, value.refused) : 0;
  const failedTargets = Array.isArray(value.failedTargets)
    ? value.failedTargets.filter((target): target is string => typeof target === 'string' && target.length > 0)
    : [];
  const resolvedAll = value.resolvedAll === true;
  if (scope === 'all' && !pageTypes.length) throw new Error('Admin job is missing page types');
  return { action: value.action, scope, ids, pageTypes, criteria, operator, status, targetTagIds, searchText, replacementText, returnTo, resolvedAll, cursor, updated, refused, failedTargets };
}
