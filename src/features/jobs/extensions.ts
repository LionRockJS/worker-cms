// The jobs feature's implementations of core's extension points.
//
// Both enqueue points return false rather than throwing when they cannot take
// the work — no queue binding configured — so the caller falls back to running
// it inline. That is also what an install without this feature gets, where the
// extension is simply absent: the decision to queue and the ability to queue
// are the same question, asked in one place.

import {
  registerCoreExtensions,
  type QueuedAdminAction,
  type QueuedBulkAction,
} from '../../core/extensions';
import type { AppContext } from '../../core/http/context';
import type { Env } from '../../types';
import {
  cmsAdminJobMessage,
  createAdvancedSearchBulkActionJob,
  createPluginAdminActionJob,
  isCmsAdminJobMessage,
} from './queue';
import { runCmsAdminJob } from './runner';

registerCoreExtensions({
  async handleQueueMessage(env: Env, body: unknown): Promise<boolean> {
    if (!isCmsAdminJobMessage(body)) return false;
    await runCmsAdminJob(env, body.jobId);
    return true;
  },

  async enqueueAdminAction(c: AppContext, input: QueuedAdminAction): Promise<boolean> {
    if (!c.env.ADMIN_JOBS_QUEUE) return false;
    const job = await createPluginAdminActionJob(c.env.DB, {
      pluginId: input.contributorId,
      method: input.method,
      path: input.path,
      contentType: input.contentType,
      body: input.body,
      user: c.get('user'),
    });
    await c.env.ADMIN_JOBS_QUEUE.send(cmsAdminJobMessage(job.id));
    return true;
  },

  async enqueueBulkAction(c: AppContext, input: QueuedBulkAction): Promise<boolean> {
    const job = await createAdvancedSearchBulkActionJob(c.env.DB, {
      action: input.action,
      scope: input.scope,
      ids: input.ids,
      pageTypes: input.pageTypes,
      criteria: input.criteria,
      operator: input.operator,
      status: input.status,
      targetTagIds: input.targetTagIds ?? [],
      searchText: input.searchText ?? '',
      replacementText: input.replacementText ?? '',
      returnTo: input.returnTo,
      user: c.get('user'),
    });
    if (c.env.ADMIN_JOBS_QUEUE) {
      await c.env.ADMIN_JOBS_QUEUE.send(cmsAdminJobMessage(job.id));
    } else {
      // No queue binding: still durable (the row carries the cursor and the
      // running totals), just driven by this invocation instead of the queue.
      c.executionCtx.waitUntil(runCmsAdminJob(c.env, job.id));
    }
    return true;
  },
});
