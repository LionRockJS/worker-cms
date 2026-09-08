// ============================================================
// Composite view source — wraps env.VIEWS so plugin-owned Liquid
// templates (field/block snippets) resolve transparently.
//
// The admin template endpoint calls `.fetch()` on the returned view source, so
// a Fetcher-shaped wrapper can add a fallback chain without touching template
// endpoint signatures.
//
// Resolution order for a path like /snippets/pagefield/events-map/basic.liquid:
//   1. primary CMS assets (env.VIEWS)
//   2. each active plugin's GET /__plugin/views/<path>
// ============================================================

import { pluginTrustLevel } from './types';
import type { Env } from '../../types';
import { getPlugins, PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';

/**
 * Returns a Fetcher that resolves view files from the CMS assets first, then
 * falls back to plugin Workers. When no plugins are configured this is just
 * env.VIEWS, so the common path adds zero overhead.
 */
export function viewsFor(env: Env): Fetcher {
  // Plugins are resolved from D1 (cached). The fallback chain only runs when the
  // primary CMS asset misses, so zero-plugin installs add no meaningful overhead.
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const primary = await env.VIEWS.fetch(url);
    if (primary.ok) return markViewSource(primary, 'core');

    const path = new URL(url).pathname;
    for (const plugin of await getPlugins(env)) {
      if (pluginTrustLevel(plugin.manifest) !== 'trusted-ui') continue;
      const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/views${path}`);
      if (response.ok) return markViewSource(response, 'plugin');
    }
    return primary; // propagate the original 404
  };

  // The engine only uses `.fetch`; present a Fetcher-shaped object.
  return { fetch } as unknown as Fetcher;
}

function markViewSource(response: Response, source: 'core' | 'plugin'): Response {
  const marked = new Response(response.body, response);
  if (source === 'plugin') {
    marked.headers.delete('Set-Cookie');
    marked.headers.delete('Content-Security-Policy');
    marked.headers.set('Cache-Control', 'no-store');
  }
  marked.headers.set('X-CMS-View-Source', source);
  return marked;
}
