// The plugin platform's implementations of core's extension points.
//
// Importing this module registers them. Core calls whatever is registered and
// does nothing when the platform is absent, which is what makes the platform
// droppable: nothing in core/ names it.

import {
  registerCoreExtensions,
  type ContentTypeContributorInfo,
  type ContributedContentTypes,
  type ContributedNavItem,
  type ContributedLimitSummary,
  type ContributedPermission,
  type ImportExportHrefs,
  type ApiCallerIdentity,
  type EditViewContext,
  type PageCreateCandidate,
  type ReadViewContext,
} from '../../core/extensions';
import type { PublishAdapter } from '../../core/publish/adapter';
import type { PublishLectRule } from '../../core/publish/projection';
import { flattenMessages } from '../../core/i18n';
import type { AppContext } from '../../core/http/context';
import type { Env, JWTPayload } from '../../types';
import { allPluginPermissions, getPlugins, pluginAutoPublishesPageType, pluginById, pluginNav, PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';
import { pluginTenantId, pluginUserHeader, pluginUserPermissions, setPluginAuthHeaders } from './proxy';
import { deliverHooks } from './hooks';
import { pluginAdapter } from './publish-adapter';
import { checkCreateLimits, createCandidate, effectiveLimitsForPlugin, limitViolationMessage } from './limits';
import { importExportHrefs } from './import-export';
import { pluginEditView, pluginNewView, pluginReadView } from './edit-view';
import { viewsFor } from './views';
import { listPlugins } from './store';
import { authenticatePlugin } from './api/auth';
import { actingUserId } from './api/create';

registerCoreExtensions({
  async publishAdapters(env: Env): Promise<PublishAdapter[]> {
    const adapters: PublishAdapter[] = [];
    for (const plugin of (await getPlugins(env)).filter((candidate) => candidate.manifest.publishTarget)) {
      if (!plugin.secret) {
        console.error(`Plugin ${plugin.manifest.id} declares publishTarget but has no secret configured`);
        continue;
      }
      adapters.push(pluginAdapter(plugin, plugin.secret, pluginTenantId(env)));
    }
    return adapters;
  },

  async contentTypes(env: Env): Promise<ContributedContentTypes[]> {
    return (await getPlugins(env))
      .map((plugin) => plugin.manifest.contentTypes)
      .filter((types): types is NonNullable<typeof types> => Boolean(types));
  },

  async sidebarNav(env: Env): Promise<ContributedNavItem[]> {
    return pluginNav(env);
  },

  async localeCatalog(env: Env, localeCode: string): Promise<Record<string, string>> {
    const views = (await getPlugins(env))
      .filter((plugin) => plugin.manifest.i18n === true)
      .map((plugin) => plugin.fetcher);
    return pluginBundledCatalog(views, localeCode);
  },

  /**
   * A rule is honored only when the declaring plugin also owns the type's
   * blueprint, so a plugin cannot thin out pages it does not own. First
   * declaration wins on (unexpected) overlap.
   */
  async lectRules(env: Env): Promise<Record<string, PublishLectRule>> {
    const rules: Record<string, PublishLectRule> = {};
    for (const plugin of await getPlugins(env)) {
      const declared = plugin.manifest.contentTypes?.publishLect ?? {};
      const owned = plugin.manifest.contentTypes?.blueprint ?? {};
      for (const [pageType, rule] of Object.entries(declared)) {
        if (!Object.hasOwn(owned, pageType)) continue;
        if (!Object.hasOwn(rules, pageType)) rules[pageType] = rule;
      }
    }
    return rules;
  },

  async notifyPageEvent(env, user: JWTPayload | undefined, event, pages): Promise<void> {
    await deliverHooks(env, user, event, pages);
  },

  /** Replays a queued admin request against the plugin that owns it. */
  async runPluginAction(env: Env, job): Promise<{ status: number; location: string | null }> {
    const plugin = await pluginById(env, job.pluginId);
    if (!plugin) throw new Error(`Plugin ${job.pluginId} is not available`);
    if (!plugin.secret) throw new Error(`Plugin ${job.pluginId} has no secret configured`);

    const headers = new Headers();
    headers.set('x-cms-user', pluginUserHeader(job.user, await pluginUserPermissions(env, plugin.manifest, job.user.role)));
    setPluginAuthHeaders(headers, plugin.secret, pluginTenantId(env));
    headers.set('x-cms-background-job', '1');
    if (job.contentType) headers.set('content-type', job.contentType);

    const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${job.path}`, {
      method: job.method,
      headers,
      body: job.method === 'GET' || job.method === 'HEAD' ? undefined : job.body ?? undefined,
      redirect: 'manual',
    });

    if (response.status < 200 || response.status >= 400) {
      const text = await response.text().catch(() => '');
      throw new Error(`Plugin action returned ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    return { status: response.status, location: response.headers.get('location') };
  },

  /** CMS assets first, then each active plugin's own view endpoint. */
  viewSource(env: Env): Fetcher {
    return viewsFor(env);
  },

  async contentTypeContributors(env: Env): Promise<ContentTypeContributorInfo[]> {
    return (await getPlugins(env)).map((plugin) => ({
      name: plugin.manifest.name,
      contentTypes: plugin.manifest.contentTypes,
    }));
  },

  async autoPublishesPageType(env: Env, pageType: string): Promise<boolean> {
    return pluginAutoPublishesPageType(env, pageType);
  },

  async checkCreateLimits(env: Env, candidates: readonly PageCreateCandidate[]): Promise<string | null> {
    const violation = await checkCreateLimits(
      env,
      candidates.map((candidate) => createCandidate(candidate.pageType, candidate.parentId, candidate.lect)),
    );
    return violation ? limitViolationMessage(violation) : null;
  },

  async importExportHrefs(env: Env, pageType?: string): Promise<ImportExportHrefs> {
    return importExportHrefs(env, pageType);
  },

  async contributedPermissions(env: Env): Promise<ContributedPermission[]> {
    return allPluginPermissions(env);
  },

  /** `mode` picks the endpoint: a plugin declares editViews and newViews separately. */
  async pageEditView(c: AppContext, context: EditViewContext): Promise<Response | null> {
    return context.mode === 'new'
      ? pluginNewView(c, context.pageType, context)
      : pluginEditView(c, context.pageType, context);
  },

  async pageReadView(c: AppContext, context: ReadViewContext): Promise<Response | null> {
    return pluginReadView(c, context.pageType, context);
  },

  async limitSummaries(env: Env): Promise<ContributedLimitSummary[]> {
    const [plugins, records] = await Promise.all([getPlugins(env), listPlugins(env.DB)]);
    const idByUrl = new Map(records.map((record) => [record.url, record.id]));
    const hrefs = (binding: string, section: 'credits' | 'limits') => {
      const id = idByUrl.get(binding);
      return id ? `/admin/plugins-manage/${id}/${section}` : '/admin/plugins-manage';
    };
    const summaries = await Promise.all(plugins.map(async (plugin) => {
      const limits = await effectiveLimitsForPlugin(env, plugin);
      const contributorLabel = plugin.manifest.name || plugin.label || plugin.manifest.id;
      return limits.map((limit) => ({
        contributorId: plugin.manifest.id,
        contributorLabel,
        key: limit.def.key,
        label: limit.def.label,
        description: limit.def.description,
        scope: limit.def.scope,
        pointerKey: limit.def.pointerKey ?? undefined,
        value: limit.value,
        manageHref: hrefs(plugin.binding, 'limits'),
      }));
    }));
    return summaries.flat();
  },

  async authenticateApiCaller(c: AppContext): Promise<ApiCallerIdentity | Response> {
    const auth = await authenticatePlugin(c);
    return auth instanceof Response ? auth : { callerId: auth.pluginId };
  },

  actingUserId(c: AppContext): number | null {
    return actingUserId(c);
  },
});

async function pluginBundledCatalog(plugins: Fetcher[], code: string): Promise<Record<string, string>> {
  const catalogs = await Promise.all(plugins.map(async (plugin) => {
    try {
      const response = await plugin.fetch(
        `${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/views/locales/${encodeURIComponent(code)}.json`,
      );
      if (!response.ok) return {};
      return flattenMessages(await response.json());
    } catch {
      return {};
    }
  }));
  return Object.assign({}, ...catalogs);
}
