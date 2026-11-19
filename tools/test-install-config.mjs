// Exercise the wizard's real config transformation without launching its
// interactive prompts or provisioning Cloudflare resources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { runInNewContext } from 'node:vm';
import { unstable_readConfig } from 'wrangler';

const source = readFileSync(new URL('./install.mjs',import.meta.url),'utf8');
const configFunctions = source.slice(source.indexOf('function setRootValue('), source.indexOf('function setDevVar('));
const example = readFileSync(new URL('../wrangler.example.toml',import.meta.url),'utf8');
const optionalBlock = /# \[\[r2_buckets\]\]\n# binding = "PLUGIN_VIEWS_BUCKET"\n# bucket_name = "cms-plugin-views"\n?/;

const oauthFunctions = source.slice(source.indexOf('function oauthUpgradeConfig('), source.indexOf('async function setupLocalDevelopment('));

test('OAuth upgrade uses the deployed provider list and submits vars and secret together', () => {
  const { oauthUpgradeConfig, oauthUpgradeVars, oauthSettingsForm } = runInNewContext(
    `${configFunctions}\n${oauthFunctions}\n({ oauthUpgradeConfig, oauthUpgradeVars, oauthSettingsForm })`,
    { FormData, PROVIDERS: { microsoft: { clientId: 'MICROSOFT_CLIENT_ID' } } },
  );
  const bindings = [
    { name: 'DB', type: 'd1', id: 'deployed-database' },
    { name: 'JWT_SECRET', type: 'secret_text' },
    { name: 'GITHUB_CLIENT_ID', type: 'plain_text', text: 'deployed-github' },
    { name: 'ENABLED_PROVIDERS', type: 'plain_text', text: 'eventuai,github' },
    { name: 'MICROSOFT_CLIENT_SECRET', type: 'secret_text' },
  ];
  const changes = oauthUpgradeVars(bindings, 'microsoft', 'fixture-app', 'organizations');
  const updated = oauthUpgradeConfig(example, changes);
  assert.equal(updated, example
    .replace('ENABLED_PROVIDERS = "github"', 'ENABLED_PROVIDERS = "eventuai,github,microsoft"')
    .replace('# MICROSOFT_CLIENT_ID = ""', 'MICROSOFT_CLIENT_ID = "fixture-app"')
    .replace('# MICROSOFT_TENANT = "common"', 'MICROSOFT_TENANT = "organizations"'));
  const form = oauthSettingsForm(bindings, changes, 'MICROSOFT_CLIENT_SECRET', 'fixture-secret');
  assert.deepEqual(JSON.parse(form.get('settings')).bindings, [
    { name: 'DB', type: 'd1' },
    { name: 'JWT_SECRET', type: 'secret_text' },
    { name: 'GITHUB_CLIENT_ID', type: 'plain_text' },
    { name: 'ENABLED_PROVIDERS', type: 'plain_text', text: 'eventuai,github,microsoft' },
    { name: 'MICROSOFT_CLIENT_ID', type: 'plain_text', text: 'fixture-app' },
    { name: 'MICROSOFT_TENANT', type: 'plain_text', text: 'organizations' },
    { name: 'MICROSOFT_CLIENT_SECRET', type: 'secret_text', text: 'fixture-secret' },
  ]);
  assert.equal(updated.includes('fixture-secret'), false);
  bindings[3].text += ',Microsoft';
  assert.equal(oauthUpgradeVars(bindings, 'microsoft', 'fixture-app', 'organizations').ENABLED_PROVIDERS, bindings[3].text);
});

test('OAuth upgrade sends settings to the existing Worker and keeps secrets out of API errors', async () => {
  const requests = [];
  const update = runInNewContext(`${oauthFunctions}\nworkerSettings`, {
    AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (options.method === 'GET') return Response.json({ success: true, result: { bindings: [] } });
      return Response.json({
        success: false,
        errors: [{ code: 10021, message: 'Error in fixture-secret' }],
      }, { status: 400 });
    },
  });
  const account = 'a'.repeat(32);
  const headers = { Authorization: 'Bearer fixture-token' };
  assert.deepEqual(await update(account, 'fixture-worker', headers), { bindings: [] });
  const form = new FormData();
  form.set('settings', 'fixture-secret');
  await assert.rejects(update(account, 'fixture-worker', headers, form), {
    message: 'Cloudflare could not update the settings for fixture-worker (HTTP 400, codes 10021).',
  });
  assert.deepEqual(requests.map(({ method, url, body }) => [method, url, body]), [
    ['GET', `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/fixture-worker/settings`, undefined],
    ['PATCH', `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/fixture-worker/settings`, form],
  ]);
});

async function transform(existing, pluginViewsBucketName, publishedDatabaseName = 'fixture-published', defaultTimezone) {
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
  await update({workerName:'fixture',databaseName:'fixture',publishedDatabaseName,
    bucketName:'fixture-media',queueName:'fixture-admin-jobs',pluginViewsBucketName,
    canonicalOrigin:'https://cms.example.com',providers:['github'],clientIds:{github:'fixture-client'},defaultTimezone});
  const directory = mkdtempSync(join(tmpdir(),'cms-install-config-'));
  try {
    const file = join(directory,'wrangler.toml');
    writeFileSync(file,result);
    return {text:result,config:unstable_readConfig({config:file})};
  } finally {rmSync(directory,{recursive:true,force:true});}
}

test('setup validates, writes and reuses the page schedule timezone', async () => {
  const { configuredDefaultTimezone, isDefaultTimezone } = runInNewContext(
    `${configFunctions}\n({ configuredDefaultTimezone, isDefaultTimezone })`,
  );
  for (const value of ['+0800', '-05:30', 'UTC', 'Asia/Hong_Kong']) assert.equal(isDefaultTimezone(value), true);
  for (const value of ['+2400', '+0860', 'Not/A_Timezone']) assert.equal(isDefaultTimezone(value), false);
  assert.equal(configuredDefaultTimezone(example), '+0800');

  const existing = example.replace('DEFAULT_TIMEZONE = "+0800"', '# DEFAULT_TIMEZONE = "+0800"\nDEFAULT_TIMEZONE = \'America/Toronto\' # existing');
  assert.equal(configuredDefaultTimezone(existing), 'America/Toronto');
  const first = await transform(existing, null, 'fixture-published', '+0530');
  assert.equal(first.config.vars.DEFAULT_TIMEZONE, '+0530');
  assert.equal(configuredDefaultTimezone(first.text), '+0530');
  assert.equal((await transform(first.text, null, 'fixture-published', '+0530')).text, first.text);
});

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

test('DMS setup omits both publish bindings and restores existing publish resources', async () => {
  const active = example.replace('# [[r2_buckets]]\n# binding = "PUBLISH_BUCKET"\n# bucket_name = "worker-cms-published"', '[[r2_buckets]]\nbinding = "PUBLISH_BUCKET" # snapshots\nbucket_name = "existing-publish-bucket"');
  const disabled = await transform(active, null, null);
  assert.deepEqual(disabled.config.d1_databases.map(({ binding }) => binding), ['DB']);
  assert.equal(disabled.config.r2_buckets.some(({ binding }) => binding === 'PUBLISH_BUCKET'), false);
  assert.equal((await transform(disabled.text, null, null)).text, disabled.text);

  const restored = await transform(disabled.text, null);
  assert.equal(restored.config.d1_databases.find(({ binding }) => binding === 'PUBLISHED_DB').database_name, 'fixture-published');
  assert.equal(restored.config.r2_buckets.find(({ binding }) => binding === 'PUBLISH_BUCKET').bucket_name, 'existing-publish-bucket');

  const freshDms = await transform(null, null, null);
  const enabled = await transform(freshDms.text, null);
  assert.equal(enabled.config.r2_buckets.some(({ binding }) => binding === 'PUBLISH_BUCKET'), false);
});

async function configureLocalSecrets(existing, confirmAdmin, providerUserId, providers = ['eventuai']) {
  const secretsFunctions = source.slice(source.indexOf('function setDevVar('), source.indexOf('async function featureEnabled('));
  let result;
  const writeSecrets = runInNewContext(`${secretsFunctions}\nwriteLocalSecrets`, {
    DEV_VARS_PATH: 'secrets',
    PROVIDERS: { eventuai: { secret: 'EVENTUAI_CLIENT_SECRET' } },
    console: { log() {} },
    readFile: async () => {
      if (existing !== null) return existing;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeFile: async (_path, value, { mode }) => {
      assert.equal(mode, 0o600);
      result = value;
    },
    parseEnv,
    randomBytes,
    confirm: confirmAdmin,
    ask: async (label) => label.includes('account subject') ? providerUserId : '',
  });
  await writeSecrets({ canonicalOrigin: 'http://localhost:8787', providers });
  return result;
}

test('Wrangler development creates local settings without asking for OAuth', async () => {
  const noPrompt = async () => assert.fail('Prompted for OAuth configuration');
  const first = await configureLocalSecrets(null, noPrompt, undefined, []);
  const vars = parseEnv(first);
  assert.match(vars.JWT_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(vars.CANONICAL_ORIGIN, 'http://localhost:8787');
  assert.equal(vars.OAUTH_REDIRECT_URI, 'http://localhost:8787/auth/callback');
  assert.equal(await configureLocalSecrets(first, noPrompt, undefined, []), first);

  const existing = `export JWT_SECRET = "${vars.JWT_SECRET}"\nexport CANONICAL_ORIGIN = https://example.com\nGITHUB_CLIENT_SECRET=existing\n`;
  const updated = parseEnv(await configureLocalSecrets(existing, noPrompt, undefined, []));
  assert.deepEqual(updated, { ...vars, GITHUB_CLIENT_SECRET: 'existing' });

  for (const value of ['short', 'replace-with-a-random-32-byte-hex-string']) {
    const repaired = parseEnv(await configureLocalSecrets(`JWT_SECRET=${value}\n`, noPrompt, undefined, []));
    assert.match(repaired.JWT_SECRET, /^[0-9a-f]{64}$/);
  }
});

test('local setup writes a dotenv-safe first-admin grant only when enabled', async () => {
  const existing = 'JWT_SECRET=test\n# INITIAL_USER_ROLES=\n';
  const providerUserId = 'identity\'#"\\$USER';
  const enabled = await configureLocalSecrets(existing, async () => true, providerUserId);
  assert.deepEqual(JSON.parse(parseEnv(enabled).INITIAL_USER_ROLES), [
    { provider: 'eventuai', providerUserId, roles: ['admin'] },
  ]);
  const declined = await configureLocalSecrets(existing, async () => false, providerUserId);
  assert.equal(parseEnv(declined).INITIAL_USER_ROLES, undefined);
});

test('local setup preserves an existing initial role allowlist', async () => {
  const existingGrant = '[\n  {"provider":"github","providerUserId":"123","roles":["editor"]}\n]';
  const existing = `JWT_SECRET=test\nexport INITIAL_USER_ROLES = '${existingGrant}'\n`;
  const result = await configureLocalSecrets(existing, async () => assert.fail('Prompted to replace existing grants'));
  assert.equal(parseEnv(result).INITIAL_USER_ROLES, existingGrant);
});
