// Legacy plugin tests model an operator-approved registration. Security tests
// import the production injection seam directly and grant capabilities explicitly.
import { env } from 'cloudflare:workers';
import { __injectPluginFetcher as inject } from '../src/features/plugins/registry';
import { approvePageTypeAccess } from '../src/features/plugins/page-types';
export * from '../src/features/plugins/registry';

export function __injectPluginFetcher(url: string, fetcher: Fetcher | null): void {
  if (!fetcher) return inject(url, null);
  inject(url, { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetcher.fetch(input, init);
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).pathname === '/__plugin/manifest' && response.ok) {
      const manifest = await response.clone().json<any>().catch(() => null);
      if (manifest?.id) {
        for (const type of Object.keys(manifest.contentTypes?.blueprint ?? {})) {
          await approvePageTypeAccess(env.DB, manifest.id, type, 'write', 'fixture-operator');
        }
        // Custom editor tests also explicitly approve their declared scopes.
        for (const type of [...(manifest.editViews ?? []), ...(manifest.newViews ?? [])]) {
          await approvePageTypeAccess(env.DB, manifest.id, type, 'write', 'fixture-operator');
        }
        for (const type of manifest.readViews ?? []) {
          await approvePageTypeAccess(env.DB, manifest.id, type, 'read', 'fixture-operator');
        }
        await env.DB.prepare("UPDATE plugins SET config = json_set(COALESCE(config, '{}'), '$.cmsTrustedUi', json('true')) WHERE url = ?")
          .bind(url).run();
      }
    }
    return response;
  } } as Fetcher);
}
