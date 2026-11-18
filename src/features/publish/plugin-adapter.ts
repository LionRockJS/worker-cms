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

import type { PublishAdapter, PublishPluginTarget, PublishSnapshot, PublishedTag } from '../../core/publish/adapter';

async function post(plugin: PublishPluginTarget, path: string, body: unknown, optional = false): Promise<void> {
  const response = await plugin.send(`/publish/${path}`, body);
  await response.body?.cancel();
  // Optional endpoints (tags, remove-tag) may simply not exist in a plugin.
  if (optional && response.status === 404) return;
  if (!response.ok) {
    throw new Error(`plugin ${plugin.id} publish/${path} returned ${response.status}`);
  }
}

export function pluginAdapter(plugin: PublishPluginTarget): PublishAdapter {
  return {
    id: `plugin:${plugin.id}`,
    contributorId: plugin.id,

    async publish(snapshot: PublishSnapshot): Promise<void> {
      await post(plugin, 'page', snapshot);
    },

    async unpublish(uuid: string): Promise<void> {
      await post(plugin, 'remove', { uuid });
    },

    async publishTags(tags: PublishedTag[]): Promise<void> {
      await post(plugin, 'tags', { tags }, true);
    },

    async removeTag(tagId: number): Promise<void> {
      await post(plugin, 'remove-tag', { tagId }, true);
    },
  };
}
