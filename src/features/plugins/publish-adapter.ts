// ============================================================
// Plugin publish target — forwards publish traffic to a plugin
// Worker that declared `publishTarget: true` in its manifest.
// This is how external destinations (IPFS, search indexes,
// webhooks, …) plug in without any CMS code changes.
//
// Contract (all POST, JSON body, x-plugin-secret header):
//   /__plugin/publish/page        full PublishSnapshot
//   /__plugin/publish/remove      { uuid }
//   /__plugin/publish/tags        { tags: PublishedTag[] }
//   /__plugin/publish/remove-tag  { tagId }
//
// Unlike lifecycle hooks (fire-and-forget), publish calls are
// awaited and a non-2xx response counts as a target failure.
// ============================================================

import type { ResolvedPlugin } from './types';
import type { Env } from '../../types';
import type { PublishAdapter, PublishSnapshot, PublishedTag } from '../../core/publish/adapter';
import { pluginById, PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';

async function post(plugin: ResolvedPlugin, secret: string, tenantId: string, path: string, body: unknown, optional = false, env?: Env): Promise<void> {
  if (env) {
    const current = await pluginById(env, plugin.manifest.id);
    if (!current?.secret || !current.manifest.publishTarget) throw new Error('Publish plugin is no longer available');
    plugin = current;
    secret = current.secret;
  }
  const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/publish/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-plugin-secret': secret,
      ...(tenantId ? { 'x-cms-tenant': tenantId } : {}),
    },
    body: JSON.stringify(body),
  });
  await response.body?.cancel();
  // Optional endpoints (tags, remove-tag) may simply not exist in a plugin.
  if (optional && response.status === 404) return;
  if (!response.ok) {
    throw new Error(`plugin ${plugin.manifest.id} publish/${path} returned ${response.status}`);
  }
}

export function pluginAdapter(plugin: ResolvedPlugin, secret: string, tenantId = '', env?: Env): PublishAdapter {
  return {
    id: `plugin:${plugin.manifest.id}`,
    contributorId: plugin.manifest.id,

    async publish(snapshot: PublishSnapshot): Promise<void> {
      await post(plugin, secret, tenantId, 'page', snapshot, false, env);
    },

    async unpublish(uuid: string): Promise<void> {
      await post(plugin, secret, tenantId, 'remove', { uuid }, false, env);
    },

    async publishTags(tags: PublishedTag[]): Promise<void> {
      await post(plugin, secret, tenantId, 'tags', { tags }, true, env);
    },

    async removeTag(tagId: number): Promise<void> {
      await post(plugin, secret, tenantId, 'remove-tag', { tagId }, true, env);
    },
  };
}
