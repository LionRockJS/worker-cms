import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { localPluginViewsOptions } from './local-plugin-views.mjs';

test('self-hosted plugin directory is a read-only disk binding supporting GET and HEAD', async () => {
  const directory = mkdtempSync(join(tmpdir(),'cms-plugin-views-'));
  mkdirSync(join(directory,'example','1.0','sections'),{recursive:true});
  writeFileSync(join(directory,'example','1.0','sections','list.liquid'),'<div>Local view</div>');
  const options = localPluginViewsOptions({PLUGIN_VIEWS_DIR:directory,PLUGIN_VIEWS_NGINX:'true'});
  const runtime = new Miniflare(convertV4MiniflareOptions({
    workers:[{
      name:'local-view-test', compatibilityDate:'2026-10-01',
      modules:[{type:'ESModule',path:'index.js',contents:`export default { fetch(request,env) {return env.PLUGIN_LOCAL_VIEWS.fetch(request);} };`}],
      ...options,
    }],port:0,cf:false,
  }));
  try {
    const worker = await runtime.getWorker();
    const url = 'https://views.invalid/example/1.0/sections/list.liquid';
    const file = await worker.fetch(url);
    assert.equal(file.status,200);
    assert.equal(await file.text(),'<div>Local view</div>');
    const head = await worker.fetch(url,{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal(await head.text(),'');
    assert.equal((await worker.fetch('https://views.invalid/missing.liquid')).status,404);
    const write = await worker.fetch(url,{method:'PUT',body:'overwrite'});
    assert.ok(write.status>=400);
    assert.equal(await (await worker.fetch(url)).text(),'<div>Local view</div>');
  } finally {
    await runtime.dispose();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('self-hosted directory configuration is opt-in and rejects invalid setup',()=>{
  assert.deepEqual(localPluginViewsOptions({}),{});
  assert.throws(()=>localPluginViewsOptions({PLUGIN_VIEWS_NGINX:'true'}),/requires PLUGIN_VIEWS_DIR/);
  assert.throws(()=>localPluginViewsOptions({PLUGIN_VIEWS_DIR:import.meta.filename}),/must be a directory/);
});
