// Exercise the wizard's real config transformation without launching its
// interactive prompts or provisioning Cloudflare resources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { unstable_readConfig } from 'wrangler';

const source = readFileSync(new URL('./install.mjs',import.meta.url),'utf8');
const configFunctions = source.slice(source.indexOf('function setRootValue('), source.indexOf('function devVar('));
const example = readFileSync(new URL('../wrangler.example.toml',import.meta.url),'utf8');
const optionalBlock = /# \[\[r2_buckets\]\]\n# binding = "PLUGIN_VIEWS_BUCKET"\n# bucket_name = "cms-plugin-views"\n?/;

async function transform(existing, pluginViewsBucketName) {
  let result;
  const context = {
    CONFIG_PATH:'config', EXAMPLE_CONFIG_PATH:'example',
    PROVIDERS:{github:{clientId:'GITHUB_CLIENT_ID'}},
    console:{log:()=>{}},
    readFile:async(path)=>{
      if(path==='example')return example;
      if(existing !== null)return existing;
      throw Object.assign(new Error('missing'),{code:'ENOENT'});
    },
    writeFile:async(_path,value)=>{result=value;},
  };
  const update = runInNewContext(`${configFunctions}\nupdateConfig`,context);
  await update({workerName:'fixture',databaseName:'fixture',publishedDatabaseName:'fixture-published',
    bucketName:'fixture-media',queueName:'fixture-admin-jobs',pluginViewsBucketName,
    canonicalOrigin:'https://cms.example.com',providers:['github'],clientIds:{github:'fixture-client'}});
  const directory = mkdtempSync(join(tmpdir(),'cms-install-config-'));
  try {
    const file = join(directory,'wrangler.toml');
    writeFileSync(file,result);
    return {text:result,config:unstable_readConfig({config:file})};
  } finally {rmSync(directory,{recursive:true,force:true});}
}

for(const [label,input] of [
  ['fresh configuration',null],
  ['older configuration missing the binding',example.replace(optionalBlock,'')],
  ['existing active binding',example+'\n[[r2_buckets]]\nbinding = "PLUGIN_VIEWS_BUCKET"\nbucket_name = "old-views"\n'],
]) {
  test(`setup provisions the plugin view binding in ${label}`,async()=>{
    const first = await transform(input,'fixture-plugin-views');
    const bindings = first.config.r2_buckets;
    assert.equal(bindings.filter(item=>item.binding==='PLUGIN_VIEWS_BUCKET').length,1);
    assert.equal(bindings.find(item=>item.binding==='PLUGIN_VIEWS_BUCKET').bucket_name,'fixture-plugin-views');
    assert.equal(bindings.find(item=>item.binding==='MEDIA_BUCKET').bucket_name,'fixture-media');
    assert.equal((await transform(first.text,'fixture-plugin-views')).text,first.text);
  });
}

test('declining the optional cache leaves fresh config unbound and preserves existing bindings',async()=>{
  assert.equal((await transform(null,null)).config.r2_buckets.some(item=>item.binding==='PLUGIN_VIEWS_BUCKET'),false);
  const enabled = await transform(null,'existing-private-views');
  const declined = await transform(enabled.text,null);
  assert.equal(declined.config.r2_buckets.find(item=>item.binding==='PLUGIN_VIEWS_BUCKET').bucket_name,'existing-private-views');
});
