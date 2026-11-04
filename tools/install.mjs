#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_EXPIRES_IN_DAYS,
  MAX_EXPIRES_IN_DAYS,
  createAppleClientSecret,
  isAppleId,
  isExpiresInDays,
  keyIdFromFileName,
  loadApplePrivateKey,
} from './apple-client-secret.mjs';

const CONFIG_PATH = new URL('../wrangler.toml', import.meta.url);
const EXAMPLE_CONFIG_PATH = new URL('../wrangler.example.toml', import.meta.url);
const MANUAL_MIGRATIONS = new URL('../migrations/manual/', import.meta.url);
const FEATURES_PATH = new URL('../cms.features.json', import.meta.url);
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PROVIDERS = {
  github: {
    clientId: 'GITHUB_CLIENT_ID',
    secret: 'GITHUB_CLIENT_SECRET',
    instructions: 'https://github.com/settings/developers',
  },
  google: {
    clientId: 'GOOGLE_CLIENT_ID',
    secret: 'GOOGLE_CLIENT_SECRET',
    instructions: 'https://console.cloud.google.com/apis/credentials',
  },
  microsoft: {
    clientId: 'MICROSOFT_CLIENT_ID',
    secret: 'MICROSOFT_CLIENT_SECRET',
    instructions: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  apple: {
    clientId: 'APPLE_CLIENT_ID',
    secret: 'APPLE_CLIENT_SECRET',
    instructions: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
  },
  eventuai: {
    clientId: 'EVENTUAI_CLIENT_ID',
    secret: 'EVENTUAI_CLIENT_SECRET',
    instructions: 'Register the CMS with your Eventuai OAuth Worker using POST /admin/setup-clients.',
  },
};

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`0xCMS interactive Cloudflare setup

Usage:
  npm run setup

The wizard asks for one namespace and derives every resource name from it
(<ns>, <ns>-published, <ns>-media, <ns>-admin-jobs, <ns>-audit); each can
still be overridden. It creates or reuses D1, R2, and Queue resources, updates
wrangler.toml and the audit switch in cms.features.json, applies migrations,
configures OAuth secrets, and does a first bootstrap deploy that bypasses the
release gate. Later releases go through "npm run deploy".`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Setup is interactive and must be run in a terminal.');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

function command(args, { capture = false, input } = {}) {
  const interactive = !capture && input === undefined;
  if (interactive) rl.pause();
  const result = spawnSync(NPX, ['wrangler', ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    input,
    stdio: input !== undefined
      ? ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit']
      : capture ? 'pipe' : 'inherit',
  });
  if (interactive) rl.resume();

  if (result.error) throw result.error;
  return result;
}

function run(args, options) {
  const result = command(args, options);
  if (result.status !== 0) {
    const detail = options?.capture ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`wrangler ${args.join(' ')} failed.${detail}`);
  }
  return result;
}

function runNpm(args) {
  rl.pause();
  const result = spawnSync(NPM, args, {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
  });
  rl.resume();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed.`);
}

async function ask(label, defaultValue, validate = (value) => Boolean(value)) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${label}${suffix}: `)).trim() || defaultValue || '';
    if (validate(answer)) return answer;
    console.log('Please enter a valid value.');
  }
}

async function confirm(label, defaultValue = true) {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

function resourceName(value) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

function origin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && Boolean(parsed.hostname)
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function parseJsonOutput(output) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  return JSON.parse(output.slice(start, end + 1));
}

async function ensureD1(name) {
  const listed = run(['d1', 'list', '--json'], { capture: true });
  const databases = parseJsonOutput(listed.stdout);
  let database = databases.find((item) => item.name === name);
  const reused = Boolean(database);

  if (reused) {
    console.log(`Reusing D1 database ${name}.`);
  } else {
    console.log(`Creating D1 database ${name}...`);
    run(['d1', 'create', name]);
    const refreshed = run(['d1', 'list', '--json'], { capture: true });
    database = parseJsonOutput(refreshed.stdout).find((item) => item.name === name);
  }

  const id = database?.uuid || database?.id || database?.database_id;
  if (!id) throw new Error(`Could not find the database ID for ${name}.`);
  return { id, reused };
}

function outputContainsName(output, name) {
  return output.split('\n').some((line) => line.split(/\s+/).includes(name));
}

function ensureR2(name) {
  const listed = run(['r2', 'bucket', 'list'], { capture: true });
  if (outputContainsName(`${listed.stdout}\n${listed.stderr}`, name)) {
    console.log(`Reusing R2 bucket ${name}.`);
    return;
  }
  console.log(`Creating R2 bucket ${name}...`);
  run(['r2', 'bucket', 'create', name]);
}

function ensureQueue(name) {
  const listed = run(['queues', 'list'], { capture: true });
  if (outputContainsName(`${listed.stdout}\n${listed.stderr}`, name)) {
    console.log(`Reusing Queue ${name}.`);
    return;
  }
  console.log(`Creating Queue ${name}...`);
  run(['queues', 'create', name]);
}

function setRootValue(lines, key, value) {
  const index = lines.findIndex((line) => new RegExp(`^${key}\\s*=`).test(line));
  if (index === -1) throw new Error(`Could not find ${key} in wrangler.toml.`);
  lines[index] = `${key} = ${JSON.stringify(value)}`;
}

function sectionRanges(lines, section) {
  const ranges = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== `[[${section}]]`) continue;
    let end = start + 1;
    while (end < lines.length && !lines[end].trim().startsWith('[')) end += 1;
    ranges.push({ start, end });
  }
  return ranges;
}

function setBindingValues(lines, section, binding, values) {
  const range = sectionRanges(lines, section).find(({ start, end }) =>
    lines.slice(start, end).some((line) =>
      new RegExp(`^\\s*binding\\s*=\\s*["']${binding}["']`).test(line),
    ),
  );
  if (!range) throw new Error(`Could not find ${binding} in [[${section}]].`);

  for (const [key, value] of Object.entries(values)) {
    const index = lines.slice(range.start, range.end)
      .findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (index === -1) throw new Error(`Could not find ${key} for ${binding}.`);
    lines[range.start + index] = `${key} = ${JSON.stringify(value)}`;
  }
}

/**
 * Activates a binding that ships commented out, by stripping the leading `# `
 * from its `[[section]]` header, its `binding` line and the key=value lines
 * under it. The prose comment above the block is left alone.
 *
 * AUDIT_BUCKET ships commented out because an active binding to a bucket that
 * does not exist fails the deploy, and the audit sweep is inert without one.
 * Turning it on is therefore part of provisioning, not of the checked-in
 * config. Returns false when there is nothing commented out to activate.
 */
function uncommentBinding(lines, section, binding) {
  const bindingIndex = lines.findIndex((line) =>
    new RegExp(`^#\\s*binding\\s*=\\s*["']${binding}["']\\s*$`).test(line));
  if (bindingIndex === -1) return false;

  const headerIndex = bindingIndex - 1;
  if (lines[headerIndex]?.trim() !== `# [[${section}]]`) {
    throw new Error(`Expected "# [[${section}]]" directly above the commented ${binding} binding.`);
  }
  const uncomment = (index) => { lines[index] = lines[index].replace(/^#\s?/, ''); };
  uncomment(headerIndex);
  uncomment(bindingIndex);
  for (let index = bindingIndex + 1; index < lines.length; index += 1) {
    if (!/^#\s*[a-z_]+\s*=/.test(lines[index])) break;
    uncomment(index);
  }
  return true;
}

function setFirstSectionValue(lines, section, key, value) {
  const [range] = sectionRanges(lines, section);
  if (!range) throw new Error(`Could not find [[${section}]].`);
  const index = lines.slice(range.start, range.end)
    .findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index === -1) throw new Error(`Could not find ${key} in [[${section}]].`);
  lines[range.start + index] = `${key} = ${JSON.stringify(value)}`;
}

function setVar(lines, key, value) {
  const start = lines.findIndex((line) => line.trim() === '[vars]');
  if (start === -1) throw new Error('Could not find [vars] in wrangler.toml.');
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith('[')) end += 1;

  const matcher = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const index = lines.slice(start + 1, end).findIndex((line) => matcher.test(line));
  const replacement = `${key} = ${JSON.stringify(value)}`;
  if (index === -1) lines.splice(end, 0, replacement);
  else lines[start + 1 + index] = replacement;
}

async function updateConfig(settings) {
  // wrangler.toml is gitignored: it is this clone's own deployment config. A
  // fresh clone has none yet, so it starts from the checked-in example.
  const existing = await readFile(CONFIG_PATH, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const original = existing ?? await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
  const lines = original.split('\n');

  setRootValue(lines, 'name', settings.workerName);
  setBindingValues(lines, 'd1_databases', 'DB', {
    database_name: settings.databaseName,
    database_id: settings.databaseId,
  });
  setBindingValues(lines, 'd1_databases', 'PUBLISHED_DB', {
    database_name: settings.publishedDatabaseName,
    database_id: settings.publishedDatabaseId,
  });
  setBindingValues(lines, 'r2_buckets', 'MEDIA_BUCKET', {
    bucket_name: settings.bucketName,
  });
  if (settings.auditBucketName) {
    uncommentBinding(lines, 'r2_buckets', 'AUDIT_BUCKET');
    setBindingValues(lines, 'r2_buckets', 'AUDIT_BUCKET', {
      bucket_name: settings.auditBucketName,
    });
  }
  setBindingValues(lines, 'queues.producers', 'ADMIN_JOBS_QUEUE', {
    queue: settings.queueName,
  });
  setFirstSectionValue(lines, 'queues.consumers', 'queue', settings.queueName);
  setVar(lines, 'ENABLED_PROVIDERS', settings.providers.join(','));
  setVar(lines, 'OAUTH_REDIRECT_URI', `${settings.canonicalOrigin}/auth/callback`);
  setVar(lines, 'CANONICAL_ORIGIN', settings.canonicalOrigin);

  for (const provider of settings.providers) {
    setVar(lines, PROVIDERS[provider].clientId, settings.clientIds[provider]);
  }
  if (settings.microsoftTenant) {
    setVar(lines, 'MICROSOFT_TENANT', settings.microsoftTenant);
  }

  await writeFile(CONFIG_PATH, lines.join('\n'));
  console.log(existing === null ? 'Created wrangler.toml from wrangler.example.toml.' : 'Updated wrangler.toml.');
}

async function featureEnabled(id) {
  const { features } = JSON.parse(await readFile(FEATURES_PATH, 'utf8'));
  return features[id] === true;
}

/**
 * Flips one switch in cms.features.json in place, so the rest of the file
 * (its escaped "//" note included) is left byte-for-byte alone. Returns
 * whether anything changed.
 */
async function setFeature(id, enabled) {
  const original = await readFile(FEATURES_PATH, 'utf8');
  const pattern = new RegExp(`("${id}"\\s*:\\s*)(true|false)`);
  if (!pattern.test(original)) throw new Error(`Could not find "${id}" in cms.features.json.`);
  const updated = original.replace(pattern, `$1${enabled}`);
  if (updated === original) return false;
  await writeFile(FEATURES_PATH, updated);
  console.log(`${enabled ? 'Enabled' : 'Disabled'} the ${id} feature in cms.features.json.`);
  return true;
}

/**
 * Apple has no static client secret: the secret is an ES256 JWT signed with the
 * .p8 key downloaded from the developer portal. Collect the pieces and mint it
 * here so nobody has to run a second tool mid-setup.
 */
async function appleClientSecret(clientId) {
  console.log(`
Apple does not issue a client secret string. It expects a signed JWT built from
the .p8 key you download once from
  https://developer.apple.com/account/resources/authkeys/list`);

  let privateKey;
  let keyFile;
  while (!privateKey) {
    keyFile = await ask('Path to the Apple .p8 private key');
    try {
      privateKey = await loadApplePrivateKey(keyFile);
    } catch (error) {
      console.log(error.message);
    }
  }

  const keyId = await ask('Apple key ID', keyIdFromFileName(keyFile), isAppleId);
  const teamId = await ask('Apple team ID', undefined, isAppleId);
  const expiresInDays = await ask(
    `Client secret lifetime in days (max ${MAX_EXPIRES_IN_DAYS})`,
    String(DEFAULT_EXPIRES_IN_DAYS),
    isExpiresInDays,
  );

  const { token, expiresAt } = createAppleClientSecret({
    privateKey,
    teamId,
    keyId,
    clientId,
    expiresInDays: Number(expiresInDays),
  });
  console.log(`Signed an Apple client secret that expires ${expiresAt.toISOString()}.`);
  console.log('Re-run "npm run apple:client-secret" before then to mint a replacement.');
  return token;
}

async function main() {
  console.log('\n0xCMS Cloudflare setup\n');

  const auth = command(['whoami'], { capture: true });
  if (auth.status !== 0) {
    if (!await confirm('Wrangler is not signed in. Open Cloudflare login now?')) {
      throw new Error('Cloudflare login is required.');
    }
    run(['login']);
  } else {
    console.log('Cloudflare authentication confirmed.');
  }

  // Every resource name derives from one namespace. The longest suffix is
  // "-admin-jobs" (11 chars), and R2/Queue names stop at 63.
  const namespace = await ask(
    'Deployment namespace (prefixes every resource name)',
    'cms',
    (value) => resourceName(value) && value.length <= 52,
  );
  const derived = {
    workerName: namespace,
    databaseName: namespace,
    publishedDatabaseName: `${namespace}-published`,
    bucketName: `${namespace}-media`,
    queueName: `${namespace}-admin-jobs`,
    auditBucketName: `${namespace}-audit`,
  };
  console.log(`
  Worker              ${derived.workerName}
  Private D1          ${derived.databaseName}
  Published D1        ${derived.publishedDatabaseName}
  Media R2 bucket     ${derived.bucketName}
  Admin job Queue     ${derived.queueName}
  Audit R2 bucket     ${derived.auditBucketName} (if enabled)
`);
  const customize = !await confirm('Use these names?');
  const name = (label, value, validate = resourceName) =>
    customize ? ask(label, value, validate) : value;

  const workerName = await name('Worker name', derived.workerName);
  const databaseName = await name('Private D1 database name', derived.databaseName);
  const publishedDatabaseName = await name(
    'Published D1 database name',
    derived.publishedDatabaseName,
    (value) => resourceName(value) && value !== databaseName,
  );
  const bucketName = await name('Private R2 media bucket name', derived.bucketName);
  const queueName = await name('Admin job Queue name', derived.queueName);
  // Recording audit_events is core and always on; the feature is the review
  // screens plus the archive sweep, so the bucket only matters with it on.
  console.log(
    '\nThe audit feature adds the /admin/audit review screens and the archive sweep.\n'
    + 'Audit events are recorded either way.',
  );
  const auditEnabled = await confirm('Enable the audit feature?', await featureEnabled('audit'));
  // Default on: the sweep is what archives *and* prunes audit_events, so
  // declining leaves that table growing in D1 with nothing to trim it.
  if (auditEnabled) {
    console.log(
      '\nThe audit archive seals audit events to R2 and is what prunes them from D1.\n'
      + 'Without it the audit log is still written, but never archived or trimmed.',
    );
  }
  const auditBucketName = auditEnabled && await confirm('Enable the audit archive?')
    ? await name('Audit archive R2 bucket name', derived.auditBucketName)
    : null;
  const canonicalOrigin = (await ask(
    'Public HTTPS origin (custom domain or workers.dev URL)',
    undefined,
    origin,
  )).replace(/\/$/, '');
  const callback = `${canonicalOrigin}/auth/callback`;

  let providers;
  while (!providers) {
    const answer = await ask('OAuth providers (comma-separated)', 'github');
    const selected = [...new Set(answer.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
    const invalid = selected.filter((provider) => !PROVIDERS[provider]);
    if (selected.length && !invalid.length) providers = selected;
    else console.log(`Choose from: ${Object.keys(PROVIDERS).join(', ')}.`);
  }

  console.log(`\nRegister this callback URL with every OAuth provider:\n  ${callback}\n`);
  const clientIds = {};
  let microsoftTenant;
  for (const provider of providers) {
    console.log(`${provider}: ${PROVIDERS[provider].instructions}`);
    clientIds[provider] = await ask(`${provider} client ID`);
    if (provider === 'microsoft') {
      microsoftTenant = await ask('Microsoft tenant', 'common');
    }
  }

  console.log('\nCreating or reusing Cloudflare resources...');
  const { id: databaseId, reused: databaseReused } = await ensureD1(databaseName);
  const { id: publishedDatabaseId } = await ensureD1(publishedDatabaseName);
  ensureR2(bucketName);
  if (auditBucketName) ensureR2(auditBucketName);
  ensureQueue(queueName);

  await updateConfig({
    workerName,
    databaseName,
    databaseId,
    publishedDatabaseName,
    publishedDatabaseId,
    bucketName,
    auditBucketName,
    queueName,
    canonicalOrigin,
    providers,
    clientIds,
    microsoftTenant,
  });
  if (await setFeature('audit', auditEnabled)) {
    // Regenerate the feature registries and baseline so the migrations applied
    // below match the profile; deploy rebuilds everything again anyway.
    runNpm(['run', 'build:features']);
    runNpm(['run', 'build:migrations']);
  }

  if (await confirm('Apply production D1 migrations now?')) {
    run(['d1', 'migrations', 'apply', databaseName, '--remote']);
    run(['d1', 'migrations', 'apply', publishedDatabaseName, '--remote']);
  }

  // A fresh database gets the audit/classification tables from the baseline.
  // An existing one already applied the baseline, so it needs the hand-applied
  // upgrades that wrangler's migrations_dir does not descend into.
  if (databaseReused) {
    const manual = (await readdir(MANUAL_MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    console.log(`
${databaseName} already existed. Apply any of these upgrades it does not have yet,
in this order (read each file's header first; *_sensitivity_trash.sql needs the
trash tables), before using the deployed code:
${manual.map((file) => `  npx wrangler d1 execute ${databaseName} --remote --file migrations/manual/${file}`).join('\n')}

A "duplicate column" error means that upgrade is already applied. The deployed
code fails closed without them (sign-in included), so apply them before deploying.
`);
  }

  // Default off for a reused database: deploying before its upgrades locks
  // everyone out, and they are applied by hand outside this wizard.
  const deployed = await confirm('Deploy 0xCMS now?', !databaseReused);
  if (deployed) {
    // Create the Worker before uploading secrets. Wrangler otherwise prompts
    // to create a missing Worker, which is incompatible with piped secrets.
    // This is a bootstrap that bypasses the release gate in tools/deploy.mjs:
    // setup may have just flipped cms.features.json and regenerated files, and
    // a first install should not wait on the full test suite.
    runNpm(['run', 'build']);
    run(['deploy', '--message', 'setup bootstrap (release gate bypassed)']);
    console.log(
      'Bootstrap deploy bypassed the release gate; record it as a W14 exception.\n'
      + 'Release later changes with "npm run deploy" from a committed, pushed revision.',
    );
  } else {
    console.log('Skipping secret uploads because the Worker was not deployed.');
  }

  if (deployed && await confirm('Generate and upload a new JWT_SECRET?')) {
    const jwtSecret = randomBytes(32).toString('hex');
    run(['secret', 'put', 'JWT_SECRET'], { input: `${jwtSecret}\n` });
    console.log('Uploaded JWT_SECRET.');
  }

  for (const provider of providers) {
    if (!deployed) break;
    if (!await confirm(`Upload ${PROVIDERS[provider].secret} now?`)) continue;
    if (provider === 'apple') {
      const secret = await appleClientSecret(clientIds.apple);
      run(['secret', 'put', PROVIDERS[provider].secret], { input: `${secret}\n` });
      console.log(`Uploaded ${PROVIDERS[provider].secret}.`);
      continue;
    }
    console.log(`Enter the ${provider} client secret at Wrangler's secure prompt.`);
    run(['secret', 'put', PROVIDERS[provider].secret]);
  }

  console.log(`\nSetup complete.\nCMS origin: ${canonicalOrigin}\nOAuth callback: ${callback}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nSetup stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
