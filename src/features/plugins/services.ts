// Plugin-platform services exposed to other optional features through the
// generated service registry. No consumer imports this module directly.

import type { FeatureServiceEntry } from '../services';
import type { Env } from '../../types';
import { getPlugins, pluginById } from './registry';
import { limitScopeTypes } from './limits';
import { listPlugins } from './store';
import { pluginConfigTransferSection } from './config-transfer';
import type { PluginCreditDef, ResolvedPlugin } from './types';

interface CreditContributorPayload {
  id: string;
  name: string;
  credits: readonly PluginCreditDef[];
  pricablePageTypes: ReadonlySet<string>;
  manageHref?: string;
}

export const pluginsServices: FeatureServiceEntry = {
  id: 'plugins',
  configTransferSections: [pluginConfigTransferSection],

  async call(operation, env, input): Promise<unknown> {
    if (operation === 'credit-contributors') {
      const [plugins, hrefs] = await Promise.all([getPlugins(env), manageHrefs(env)]);
      return Promise.all(plugins.map((plugin) => asCreditContributor(env, plugin, hrefs)));
    }
    if (operation === 'credit-contributor') {
      const id = typeof input === 'object' && input !== null && 'id' in input
        ? String((input as { id: unknown }).id)
        : '';
      if (!id) return null;
      const plugin = await pluginById(env, id);
      return plugin ? asCreditContributor(env, plugin, await manageHrefs(env)) : null;
    }
    return undefined;
  },
};

async function manageHrefs(env: Env): Promise<(binding: string, section: 'credits' | 'limits') => string> {
  const records = await listPlugins(env.DB);
  const idByUrl = new Map(records.map((record) => [record.url, record.id]));
  return (binding, section) => {
    const id = idByUrl.get(binding);
    return id ? `/admin/plugins-manage/${id}/${section}` : '/admin/plugins-manage';
  };
}

async function asCreditContributor(
  env: Env,
  plugin: ResolvedPlugin,
  hrefs: (binding: string, section: 'credits' | 'limits') => string,
): Promise<CreditContributorPayload> {
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name || plugin.label || plugin.manifest.id,
    credits: plugin.manifest.credits ?? [],
    // Only types the plugin owns or has approval to write may carry a price.
    pricablePageTypes: await limitScopeTypes(env.DB, plugin.manifest),
    manageHref: hrefs(plugin.binding, 'credits'),
  };
}
