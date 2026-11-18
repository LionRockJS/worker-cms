import type { Env } from '../../types';
import type { ResolvedPlugin } from './types';
import { pluginViewRevision } from './revision';

export type PluginViewSource = 'host' | 'bucket' | 'local';

/** Only canonical static source paths can reach the filesystem or Nginx. */
export function localPluginViewPath(plugin: ResolvedPlugin, viewPath: string): string | null {
  const revision = pluginViewRevision(plugin.manifest);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(plugin.manifest.id)
      || !revision || revision === '.' || revision === '..'
      || !/^[A-Za-z0-9._:-]+$/.test(revision)) return null;
  if (!viewPath.startsWith('/') || !/\.(liquid|json)$/.test(viewPath)) return null;
  const parts = viewPath.slice(1).split('/');
  if (parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part))) return null;
  return `/${plugin.manifest.id}/${revision}${viewPath}`;
}

/** No request credentials are sent to this deployment-owned, read-only disk. */
export async function localPluginView(env: Env, plugin: ResolvedPlugin, viewPath: string, accelerate: boolean): Promise<Response | null> {
  if (plugin.viewSource !== 'local' || !env.PLUGIN_LOCAL_VIEWS) return null;
  const path = localPluginViewPath(plugin, viewPath);
  if (!path) return null;
  const nginx = accelerate && env.PLUGIN_VIEWS_NGINX === 'true';
  try {
    const response = await env.PLUGIN_LOCAL_VIEWS.fetch(`https://local-views.invalid${path}`, { method: nginx ? 'HEAD' : 'GET' });
    if (response.status !== 200) { await response.body?.cancel(); return null; }
    const headers = new Headers({
      'content-type': viewPath.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    if (nginx) {
      await response.body?.cancel();
      headers.set('X-Accel-Redirect', `/_plugin_views${path}`);
    }
    return new Response(nginx ? null : response.body, { headers });
  } catch { return null; }
}

export const localViewsEnvExample = `# Self-hosted server .env (both server.mjs and server-workerd.mjs)
PLUGIN_VIEWS_DIR=/srv/cms/plugin-views
# Enable only after installing the Nginx locations below:
PLUGIN_VIEWS_NGINX=true`;

export const localViewsNginxExample = `# Inside the existing HTTPS server block.
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header CF-Connecting-IP $remote_addr;
    proxy_ignore_headers X-Accel-Redirect;
}

# Only the authenticated view endpoint may request internal file delivery.
location ~ ^/admin/plugins/[a-z][a-z0-9-]*/views/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header CF-Connecting-IP $remote_addr;
    proxy_cache off;
}

location ^~ /_plugin_views/ {
    internal;
    alias /srv/cms/plugin-views/;
    types {
        application/json json;
        text/plain liquid;
    }
    default_type text/plain;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control "private, no-cache" always;
}`;
