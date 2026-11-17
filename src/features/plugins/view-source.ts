import { localPluginView, type PluginViewSource } from './local-views';
import type { Env } from '../../types';
import type { ResolvedPlugin } from './types';
import { pluginViewRevision } from './revision';

export function pluginViewSource(config: string | null | undefined): PluginViewSource {
  try {
    const source = JSON.parse(config || '{}')?.cmsViewSource;
    return source === 'bucket' || source === 'local' ? source : 'host';
  }
  catch { return 'host'; }
}

async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheBody(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) {
      // This is a tee of the upstream body. Awaiting cancellation would wait
      // for the browser branch, which cannot start until this function returns.
      void reader.cancel('view exceeds cache limit').catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Cache static view source only. Callers must authorize access before invoking.
 * Separate public snippet resolution from authenticated browser view requests,
 * and partition authenticated files by the exact forwarded request context.
 */
export async function fetchPluginView(env: Env, plugin: ResolvedPlugin, url: string, init?: RequestInit, accelerateLocal = false): Promise<Response> {
  const upstream = async () => {
    const response = await plugin.fetcher.fetch(url, init);
    // An external plugin may never select an internal Nginx filesystem path.
    const safe = new Response(response.body, response);
    safe.headers.delete('X-Accel-Redirect');
    return safe;
  };
  const viewPath = new URL(url).pathname.replace(/^\/__plugin\/(?:admin\/)?views/, '');
  const local = await localPluginView(env, plugin, viewPath, accelerateLocal);
  if (local) return local;
  const bucket = env.PLUGIN_VIEWS_BUCKET;
  const revision = pluginViewRevision(plugin.manifest);
  const path = new URL(url).pathname;
  if (plugin.viewSource !== 'bucket' || !bucket || !revision || !/\.(liquid|json)$/.test(path)) return upstream();

  const context = [...new Headers(init?.headers).entries()].sort(([a], [b]) => a.localeCompare(b));
  const partition = await digest(JSON.stringify([plugin.registration?.uuid, plugin.binding, plugin.secret, context]));
  const key = `plugin-views/${plugin.manifest.id}/${partition}/${encodeURIComponent(revision)}/${await digest(url)}`;
  try {
    const object = await bucket.get(key);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }
  } catch { /* Storage failure preserves the normal plugin loading path. */ }

  const response = await upstream();
  // Bucket is an explicit host opt-in to cache static source, overriding the
  // SDK default no-store. Never persist redirects, cookies or errors.
  if (response.status !== 200 || response.headers.has('set-cookie')) return response;
  const type = response.headers.get('content-type') || '';
  if (!/^(application\/json|text\/plain|text\/html)(;|$)/i.test(type)) return response;
  try {
    const body = await cacheBody(response.clone());
    if (body) await bucket.put(key, body, { httpMetadata: { contentType: type } });
  } catch { /* A cache miss or oversized file must not break the view. */ }
  return response;
}
