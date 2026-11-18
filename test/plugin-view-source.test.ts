import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fetchPluginView, pluginViewSource } from '../src/features/plugins/view-source';
import type { Env } from '../src/types';
import type { ResolvedPlugin } from '../src/features/plugins/types';

function fixture(status = 200, headers: Record<string, string> = {}) {
  let calls = 0;
  const plugin = {
    viewSource: 'bucket', binding: `https://${crypto.randomUUID()}.example.com`,
    manifest: { id: 'example', name: 'Example', version: '1.0' }, secret: 'test', apiSecret: 'test',
    fetcher: { fetch: async () => {
      calls++;
      return new Response(status === 200 ? '<div>View</div>' : 'Unavailable', {
        status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', ...headers },
      });
    } },
  } as ResolvedPlugin;
  return { plugin, calls: () => calls };
}
const url = 'https://plugin.local/__plugin/admin/views/sections/example.liquid';
const runtime = env as unknown as Env;

describe('plugin view bucket', () => {
  it('defaults existing, invalid and absent settings to host', () => {
    for (const config of [null, '', 'broken', '{}', 'null', '{"cmsViewSource":"other"}']) expect(pluginViewSource(config)).toBe('host');
    expect(pluginViewSource('{"cmsViewSource":"bucket"}')).toBe('bucket');
  });

  it('stores static source on first fetch and reuses it despite SDK no-store', async () => {
    const f = fixture();
    expect(await (await fetchPluginView(runtime, f.plugin, url)).text()).toBe('<div>View</div>');
    expect(await (await fetchPluginView(runtime, f.plugin, url)).text()).toBe('<div>View</div>');
    expect(f.calls()).toBe(1);
    f.plugin.manifest.version = '2.0';
    await fetchPluginView(runtime, f.plugin, url);
    expect(f.calls()).toBe(2);
  });

  it('partitions by user, credentials, public path and query', async () => {
    const f = fixture();
    for (const user of ['alice', 'bob', 'alice']) await fetchPluginView(runtime, f.plugin, url, { headers: { 'x-cms-user': user } });
    expect(f.calls()).toBe(2);
    f.plugin.secret = 'rotated';
    await fetchPluginView(runtime, f.plugin, url, { headers: { 'x-cms-user': 'alice' } });
    await fetchPluginView(runtime, f.plugin, url.replace('/admin/views/', '/views/'));
    await fetchPluginView(runtime, f.plugin, url + '?locale=zh');
    expect(f.calls()).toBe(5);
  });

  it('preserves host mode and missing bucket behavior', async () => {
    const f = fixture();
    f.plugin.viewSource = 'host';
    await fetchPluginView(runtime, f.plugin, url);
    await fetchPluginView(runtime, f.plugin, url);
    f.plugin.viewSource = 'bucket';
    await fetchPluginView({ ...runtime, PLUGIN_VIEWS_BUCKET: undefined }, f.plugin, url);
    expect(f.calls()).toBe(3);
  });

  it('does not store errors, redirects, cookies or executable assets', async () => {
    for (const [status, headers] of [[500, {}], [302, { location: '/admin/views/shared.liquid' }], [200, { 'set-cookie': 'test=1' }]] as const) {
      const f = fixture(status, headers);
      await fetchPluginView(runtime, f.plugin, url);
      await fetchPluginView(runtime, f.plugin, url);
      expect(f.calls()).toBe(2);
    }
    const f = fixture();
    await fetchPluginView(runtime, f.plugin, url.replace('.liquid', '.js'));
    await fetchPluginView(runtime, f.plugin, url.replace('.liquid', '.js'));
    expect(f.calls()).toBe(2);
  });

  it('serves oversized files without caching or blocking the response', async () => {
    const f = fixture();
    let calls = 0;
    f.plugin.fetcher = {fetch: async () => {
      calls++;
      return new Response('x'.repeat(2 * 1024 * 1024 + 1), {headers:{'content-type':'text/plain'}});
    }} as Fetcher;
    for (let i=0;i<2;i++) expect((await (await fetchPluginView(runtime, f.plugin, url)).text()).length).toBe(2 * 1024 * 1024 + 1);
    expect(calls).toBe(2);
  });

  it('falls back when storage is unavailable', async () => {
    const f = fixture();
    const broken = { ...runtime, PLUGIN_VIEWS_BUCKET: { get: async () => { throw new Error('offline'); }, put: async () => { throw new Error('offline'); } } as unknown as R2Bucket };
    expect(await (await fetchPluginView(broken, f.plugin, url)).text()).toBe('<div>View</div>');
  });
});

describe('local plugin source', () => {
  it('loads revisioned files directly without calling the plugin', async () => {
    const f = fixture();
    f.plugin.viewSource = 'local';
    const requests: Array<{path:string;method:string}> = [];
    const local = { ...runtime, PLUGIN_LOCAL_VIEWS: {fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({path:String(input),method:init?.method || 'GET'});
      return new Response('local source');
    }} as Fetcher };
    const response = await fetchPluginView(local, f.plugin, url);
    expect(await response.text()).toBe('local source');
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(requests).toEqual([{path:'https://local-views.invalid/example/1.0/sections/example.liquid',method:'GET'}]);
    expect(f.calls()).toBe(0);
    expect(pluginViewSource('{"cmsViewSource":"local"}')).toBe('local');
  });

  it('accelerates browser views only after checking local file existence', async () => {
    const f = fixture();
    f.plugin.viewSource = 'local';
    const methods:string[] = [];
    const local = { ...runtime, PLUGIN_VIEWS_NGINX:'true', PLUGIN_LOCAL_VIEWS:{fetch:async (_input:RequestInfo|URL,init?:RequestInit)=>{
      methods.push(init?.method || 'GET');
      return new Response(init?.method === 'HEAD' ? null : 'snippet source');
    }} as Fetcher };
    const browser = await fetchPluginView(local,f.plugin,url,undefined,true);
    expect(browser.headers.get('x-accel-redirect')).toBe('/_plugin_views/example/1.0/sections/example.liquid');
    expect(await browser.text()).toBe('');
    const snippet = await fetchPluginView(local,f.plugin,url.replace('/admin/views/','/views/'));
    expect(snippet.headers.has('x-accel-redirect')).toBe(false);
    expect(await snippet.text()).toBe('snippet source');
    expect(methods).toEqual(['HEAD','GET']);
    expect(f.calls()).toBe(0);
  });

  it('falls back for missing files, unavailable directories, unsafe paths and missing revisions', async () => {
    const f = fixture();
    f.plugin.viewSource = 'local';
    let localCalls = 0;
    const local = {...runtime,PLUGIN_LOCAL_VIEWS:{fetch:async()=>{localCalls++;return new Response(null,{status:404});}} as Fetcher};
    await fetchPluginView(local,f.plugin,url,undefined,true);
    await fetchPluginView({...local,PLUGIN_LOCAL_VIEWS:undefined},f.plugin,url);
    await fetchPluginView(local,f.plugin,url.replace('example.liquid','%2fsecret.liquid'));
    f.plugin.manifest.version = '';
    await fetchPluginView(local,f.plugin,url);
    expect(localCalls).toBe(1);
    expect(f.calls()).toBe(4);
  });

  it('never accepts internal redirect headers from a plugin response', async () => {
    const f = fixture(200,{'X-Accel-Redirect':'/_plugin_views/another/private.json'});
    f.plugin.viewSource = 'host';
    expect((await fetchPluginView(runtime,f.plugin,url)).headers.has('x-accel-redirect')).toBe(false);
  });
});
