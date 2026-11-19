#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
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
const UPGRADE_CONFIG_PATH = new URL('../.wrangler-upgrade.toml', import.meta.url);
const EXAMPLE_CONFIG_PATH = new URL('../wrangler.example.toml', import.meta.url);
const MANUAL_MIGRATIONS = new URL('../migrations/manual/', import.meta.url);
const FEATURES_PATH = new URL('../cms.features.json', import.meta.url);
const DEV_VARS_PATH = new URL('../.dev.vars', import.meta.url);
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const LOCAL_ORIGIN = 'http://localhost:8787';
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

const upgradeMode = process.argv.includes('--upgrade');
const operation = upgradeMode ? 'Upgrade' : 'Setup';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(upgradeMode ? `0xCMS OAuth upgrade

Usage:
  npm run upgrade

Add one OAuth provider to the Worker configured in this clone's wrangler.toml.
The wizard uses the existing callback URL and deploys through npm run deploy.
` : `0xCMS interactive setup

Usage:
  npm run setup             choose Wrangler development or full hosting setup
  npm run setup -- --local  full hosting setup on this machine, including OAuth

For Wrangler development, setup creates wrangler.toml if needed, configures
.dev.vars for localhost:8787, and applies the local D1 migrations. OAuth
credentials can be configured separately when you need to sign in.

The wizard asks for one namespace and derives every resource name from it
(<ns>, <ns>-published, <ns>-media, <ns>-admin-jobs, <ns>-audit,
<ns>-plugin-views); each can still be overridden. It creates or reuses D1, R2, and Queue resources, updates
wrangler.toml and the feature switches in cms.features.json, applies migrations,
optionally provisions the plugin view cache, and configures OAuth secrets and
the first admin. It also sets the default timezone for new page schedules.
The first bootstrap deploy bypasses the release gate. Later
releases go through "npm run deploy".

A local setup runs the CMS on this machine instead of Cloudflare Workers:
nothing is created in Cloudflare, migrations go to the local D1 state shared by
"npm run dev", server.mjs, and server-workerd.mjs. Local secrets go to .dev.vars.
An http://localhost:<port> origin is always local. A public https origin
(e.g. https://cms.example.com) can be local too, with either server behind a
tunnel or reverse proxy that forwards that domain to this machine.`);
  process.exit(0);
}

if (upgradeMode && process.argv.length !== 3) {
  console.error('Usage: npm run upgrade');
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error(`${operation} is interactive and must be run in a terminal.`);
  process.exit(1);
}

let hiddenInput = false;
const promptOutput = upgradeMode ? new Writable({
  write(chunk, encoding, done) {
    if (hiddenInput) done();
    else process.stdout.write(chunk, encoding, done);
  },
}) : process.stdout;
const rl = createInterface({
  input: process.stdin,
  output: promptOutput,
  terminal: true,
  ...(upgradeMode ? { historySize: 0 } : {}),
});

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

function runNpm(args, { stdin = 'inherit' } = {}) {
  rl.pause();
  const result = spawnSync(NPM, args, {
    cwd: new URL('..', import.meta.url),
    stdio: [stdin, 'inherit', 'inherit'],
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

async function askSecret(label) {
  while (true) {
    process.stdout.write(`${label}: `);
    hiddenInput = true;
    try {
      const value = await rl.question('');
      if (value.trim()) return value;
    } finally {
      hiddenInput = false;
      process.stdout.write('\n');
    }
  }
}

function resourceName(value) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

function isLocalOrigin(value) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
}

function origin(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalOrigin(value)))
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

const DISABLED_BINDING_NOTE = '# Disabled by setup while publishing is off.';

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

function bindingRange(lines, section, binding) {
  return sectionRanges(lines, section).find(({ start, end }) =>
    lines.slice(start, end).some((line) =>
      new RegExp(`^\\s*binding\\s*=\\s*["']${binding}["']`).test(line),
    ),
  );
}

function setBindingValues(lines, section, binding, values) {
  const range = bindingRange(lines, section, binding);
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
function uncommentBinding(lines, section, binding, disabledBySetup = false) {
  const matcher = new RegExp(`^#\\s*binding\\s*=\\s*["']${binding}["']\\s*(?:#.*)?$`);
  const bindingIndex = lines.findIndex((line, index) =>
    matcher.test(line) && (!disabledBySetup || lines[index - 2] === DISABLED_BINDING_NOTE));
  if (bindingIndex === -1) return false;

  const headerIndex = bindingIndex - 1;
  if (lines[headerIndex]?.trim() !== `# [[${section}]]`) {
    throw new Error(`Expected "# [[${section}]]" directly above the commented ${binding} binding.`);
  }
  const uncomment = (index) => { lines[index] = lines[index].replace(/^#\s?/, ''); };
  uncomment(headerIndex);
  uncomment(bindingIndex);
  for (let index = bindingIndex + 1; index < lines.length; index += 1) {
    if (!/^#(?!\s*\[)/.test(lines[index])) break;
    if (/^#\s*[a-z_]+\s*=/.test(lines[index])) uncomment(index);
  }
  if (lines[headerIndex - 1] === DISABLED_BINDING_NOTE) lines.splice(headerIndex - 1, 1);
  return true;
}

/** Support fresh templates, existing bindings, and configs predating an optional binding. */
function ensureR2Binding(lines, binding, bucketName) {
  const active = sectionRanges(lines, 'r2_buckets').some(({start, end}) =>
    lines.slice(start, end).some((line) =>
      new RegExp(`^\\s*binding\\s*=\\s*["']${binding}["']\\s*$`).test(line)));
  if (!active && !uncommentBinding(lines, 'r2_buckets', binding)) {
    lines.push('', '[[r2_buckets]]', `binding = ${JSON.stringify(binding)}`, `bucket_name = ${JSON.stringify(bucketName)}`);
  }
  setBindingValues(lines, 'r2_buckets', binding, { bucket_name: bucketName });
}

function disableBinding(lines, section, binding, remember = false) {
  const range = bindingRange(lines, section, binding);
  if (!range) return;
  lines[range.start] = `# ${lines[range.start].trimStart()}`;
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^\s*[a-z_]+\s*=/.test(lines[index])) lines[index] = `# ${lines[index]}`;
  }
  if (remember) lines.splice(range.start, 0, DISABLED_BINDING_NOTE);
}

function setFirstSectionValue(lines, section, key, value) {
  const [range] = sectionRanges(lines, section);
  if (!range) throw new Error(`Could not find [[${section}]].`);
  const index = lines.slice(range.start, range.end)
    .findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index === -1) throw new Error(`Could not find ${key} in [[${section}]].`);
  lines[range.start + index] = `${key} = ${JSON.stringify(value)}`;
}

function varsRange(lines) {
  const start = lines.findIndex((line) => line.trim() === '[vars]');
  if (start === -1) throw new Error('Could not find [vars] in wrangler.toml.');
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith('[')) end += 1;
  return { start, end };
}

function setVar(lines, key, value) {
  const { start, end } = varsRange(lines);
  const matcher = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const entries = lines.slice(start + 1, end);
  const active = entries.findIndex((line) => matcher.test(line) && !line.trimStart().startsWith('#'));
  const index = active === -1 ? entries.findIndex((line) => matcher.test(line)) : active;
  const replacement = `${key} = ${JSON.stringify(value)}`;
  if (index === -1) lines.splice(end, 0, replacement);
  else lines[start + 1 + index] = replacement;
}

function isDefaultTimezone(value) {
  if (/^[+-]/.test(value)) return /^[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?$/.test(value);
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function configuredDefaultTimezone(config) {
  const lines = config.split('\n');
  const { start, end } = varsRange(lines);
  for (const line of lines.slice(start + 1, end)) {
    const match = /^\s*DEFAULT_TIMEZONE\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    const value = (match?.[1] ?? match?.[2])?.trim();
    if (value && isDefaultTimezone(value)) return value;
  }
  return '+0800';
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
  // A local setup has no Cloudflare database IDs; it keeps whatever IDs the
  // config already holds, since wrangler keys local D1 state by them.
  setBindingValues(lines, 'd1_databases', 'DB', {
    database_name: settings.databaseName,
    ...(settings.databaseId ? { database_id: settings.databaseId } : {}),
  });
  if (settings.publishedDatabaseName) {
    if (!bindingRange(lines, 'd1_databases', 'PUBLISHED_DB')
      && !uncommentBinding(lines, 'd1_databases', 'PUBLISHED_DB')) {
      lines.push('', '[[d1_databases]]', 'binding = "PUBLISHED_DB"', 'database_name = ""',
        'database_id = "00000000-0000-0000-0000-000000000000"', 'migrations_dir = "migrations/published"');
    }
    setBindingValues(lines, 'd1_databases', 'PUBLISHED_DB', {
      database_name: settings.publishedDatabaseName,
      ...(settings.publishedDatabaseId ? { database_id: settings.publishedDatabaseId } : {}),
    });
    if (!bindingRange(lines, 'r2_buckets', 'PUBLISH_BUCKET')) {
      uncommentBinding(lines, 'r2_buckets', 'PUBLISH_BUCKET', true);
    }
  } else {
    disableBinding(lines, 'd1_databases', 'PUBLISHED_DB');
    disableBinding(lines, 'r2_buckets', 'PUBLISH_BUCKET', true);
  }
  setBindingValues(lines, 'r2_buckets', 'MEDIA_BUCKET', {
    bucket_name: settings.bucketName,
  });
  if (settings.pluginViewsBucketName) {
    ensureR2Binding(lines, 'PLUGIN_VIEWS_BUCKET', settings.pluginViewsBucketName);
  }
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
  if (settings.defaultTimezone) setVar(lines, 'DEFAULT_TIMEZONE', settings.defaultTimezone);

  for (const provider of settings.providers) {
    setVar(lines, PROVIDERS[provider].clientId, settings.clientIds[provider]);
  }
  if (settings.microsoftTenant) {
    setVar(lines, 'MICROSOFT_TENANT', settings.microsoftTenant);
  }

  await writeFile(CONFIG_PATH, lines.join('\n'));
  console.log(existing === null ? 'Created wrangler.toml from wrangler.example.toml.' : 'Updated wrangler.toml.');
}

function setDevVar(lines, key, value) {
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*(?:=|:\\s)`);
  let index = lines.findLastIndex((line) => assignment.test(line));
  if (index === -1) index = lines.findIndex((line) => new RegExp(`^#\\s*${key}=`).test(line));
  const replacement = `${key}=${value}`;
  if (index !== -1) lines[index] = replacement;
  else if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, replacement);
  else lines.push(replacement);
}

async function firstAdminGrant(providers, prompt) {
  if (!await confirm(prompt, false)) return null;

  const provider = (providers.length === 1 ? providers[0] : await ask(
    `First admin's OAuth provider (${providers.join(', ')})`,
    providers[0],
    (value) => providers.includes(value.toLowerCase()),
  )).toLowerCase();
  const providerUserId = provider === 'github'
    ? await ask('First admin\'s GitHub numeric user ID', undefined, (value) => /^[1-9]\d*$/.test(value))
    : await ask(`First admin's ${provider} account subject (sub)`);

  return JSON.stringify([{ provider, providerUserId, roles: ['admin'] }]);
}

/**
 * Local setup: secrets go to .dev.vars, which wrangler dev reads and git
 * ignores. CANONICAL_ORIGIN and OAUTH_REDIRECT_URI are written too, because
 * .dev.vars overrides [vars] and a stale value there would win over the
 * origin just entered. Existing secrets are kept unless replaced.
 */
async function writeLocalSecrets({ canonicalOrigin, providers = [], clientIds = {} }) {
  const existing = await readFile(DEV_VARS_PATH, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const vars = parseEnv(existing ?? '');
  const lines = (existing ?? '# Local development only. Gitignored; never reuse these values in a deployed Worker.\n').split('\n');

  setDevVar(lines, 'CANONICAL_ORIGIN', canonicalOrigin);
  setDevVar(lines, 'OAUTH_REDIRECT_URI', `${canonicalOrigin}/auth/callback`);
  if (vars.JWT_SECRET?.length >= 32 && vars.JWT_SECRET !== 'replace-with-a-random-32-byte-hex-string') {
    console.log('Keeping the existing JWT_SECRET in .dev.vars.');
  } else {
    setDevVar(lines, 'JWT_SECRET', randomBytes(32).toString('hex'));
    console.log('Generated JWT_SECRET.');
  }

  for (const provider of providers) {
    const key = PROVIDERS[provider].secret;
    if (vars[key] && !await confirm(`Replace the existing ${key} in .dev.vars?`, false)) continue;
    const secret = provider === 'apple'
      ? await appleClientSecret(clientIds.apple)
      : await ask(`${provider} client secret (blank to add later)`, undefined, () => true);
    if (secret) setDevVar(lines, key, secret);
    else console.log(`Add ${key} to .dev.vars before signing in with ${provider}.`);
  }

  if (lines.some((line) => /^\s*(?:export\s+)?INITIAL_USER_ROLES\s*(?:=|:\s)/.test(line))) {
    console.log('Keeping the existing INITIAL_USER_ROLES in .dev.vars.');
  } else if (providers.length) {
    const grant = await firstAdminGrant(providers, 'Configure a first admin in .dev.vars?');
    if (grant) {
      // Keep the dotenv quoting and any variable expansion out of the JSON value.
      const json = grant.replaceAll("'", '\\u0027').replaceAll('$', '\\u0024');
      setDevVar(lines, 'INITIAL_USER_ROLES', `'${json}'`);
    }
  }

  await writeFile(DEV_VARS_PATH, lines.join('\n'), { mode: 0o600 });
  console.log(existing === null ? 'Created .dev.vars.' : 'Updated .dev.vars.');
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

function oauthUpgradeConfig(original, providers, provider, clientId, microsoftTenant) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(newline);
  setVar(lines, 'ENABLED_PROVIDERS', [...providers, provider].join(','));
  setVar(lines, PROVIDERS[provider].clientId, clientId);
  if (provider === 'microsoft') setVar(lines, 'MICROSOFT_TENANT', microsoftTenant);
  return lines.join(newline);
}

async function upgrade() {
  const original = await readFile(CONFIG_PATH, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw new Error('Expected an existing deployment config at wrangler.toml.');
    throw error;
  });
  const { unstable_readConfig } = await import('wrangler');
  const config = unstable_readConfig({ config: fileURLToPath(CONFIG_PATH) });
  const { name, vars } = config;
  const callback = vars.OAUTH_REDIRECT_URI;
  if (!name || typeof callback !== 'string' || URL.parse(callback)?.protocol !== 'https:') {
    throw new Error('Set the deployed Worker name and HTTPS OAUTH_REDIRECT_URI in wrangler.toml.');
  }
  if (typeof vars.ENABLED_PROVIDERS !== 'string') {
    throw new Error('Set ENABLED_PROVIDERS in wrangler.toml to match the deployed Worker.');
  }
  const providers = vars.ENABLED_PROVIDERS.split(',').map((value) => value.trim()).filter(Boolean);
  const available = Object.keys(PROVIDERS).filter((provider) =>
    !providers.some((enabled) => enabled.toLowerCase() === provider));
  if (!available.length) {
    console.log('All supported OAuth providers are already enabled.');
    return;
  }

  console.log(`\nWorker: ${name}\nCurrent OAuth providers: ${providers.join(', ') || '(none)'}\nCallback: ${callback}\n`);
  const provider = await ask(
    `OAuth provider to add (${available.join(', ')})`, undefined,
    (value) => available.includes(value.toLowerCase()),
  ).then((value) => value.toLowerCase());
  console.log(`Register ${callback} with ${provider}.\n${PROVIDERS[provider].instructions}`);
  const clientId = await ask(`${provider} client ID`, vars[PROVIDERS[provider].clientId] || undefined);
  const microsoftTenant = provider === 'microsoft'
    ? await ask('Microsoft tenant', vars.MICROSOFT_TENANT || 'common')
    : undefined;
  if (!await confirm(`Add ${provider} and deploy to ${name}?`, false)) return;

  // Confirm that the configured Worker already exists before invoking deploy.
  run(['secret', 'list', '--config', 'wrangler.toml'], { capture: true });
  const secret = provider === 'apple'
    ? await appleClientSecret(clientId)
    : await askSecret(`${provider} client secret (input hidden)`);

  const updated = oauthUpgradeConfig(original, providers, provider, clientId, microsoftTenant);
  // Keep the candidate next to wrangler.toml so relative binding and asset paths
  // resolve the same way. An exclusive create also guards concurrent upgrades.
  await writeFile(UPGRADE_CONFIG_PATH, updated, { flag: 'wx', mode: 0o600 });
  let secretsDirectory;
  try {
    if (await readFile(CONFIG_PATH, 'utf8') !== original) {
      throw new Error('wrangler.toml changed during the upgrade. Rerun npm run upgrade.');
    }
    secretsDirectory = await mkdtemp(join(tmpdir(), 'cms-oauth-upgrade-'));
    const secretsFile = join(secretsDirectory, 'secrets.json');
    await writeFile(secretsFile, JSON.stringify({ [PROVIDERS[provider].secret]: secret }), { mode: 0o600 });
    runNpm(['run', 'deploy', '--', '--config', '.wrangler-upgrade.toml', '--keep-vars', '--secrets-file', secretsFile]);
    await rename(UPGRADE_CONFIG_PATH, CONFIG_PATH);
  } finally {
    if (secretsDirectory) await rm(secretsDirectory, { recursive: true, force: true });
    await rm(UPGRADE_CONFIG_PATH, { force: true });
  }
  console.log(`\nEnabled ${provider} on ${name} and updated wrangler.toml.`);
}

async function setupLocalDevelopment() {
  const template = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
  try {
    await writeFile(CONFIG_PATH, template, { flag: 'wx' });
    console.log('Created wrangler.toml from wrangler.example.toml.');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log('Keeping the existing wrangler.toml.');
  }

  await writeLocalSecrets({ canonicalOrigin: LOCAL_ORIGIN });
  runNpm(['run', 'db:migrate'], { stdin: 'ignore' });
  console.log(`\nLocal setup complete. Start with npm run dev and open ${LOCAL_ORIGIN}.`);
  console.log(`For sign-in, configure an OAuth client with callback ${LOCAL_ORIGIN}/auth/callback.`);
}

async function main() {
  console.log('\n0xCMS setup\n');

  const localHosting = process.argv.includes('--local');
  if (!localHosting && await confirm('Set up this clone for local development with Wrangler?')) {
    await setupLocalDevelopment();
    return;
  }

  const canonicalOrigin = (await ask(
    'Public HTTPS origin (custom domain or workers.dev URL; http://localhost:port for local dev)',
    localHosting ? LOCAL_ORIGIN : undefined,
    origin,
  )).replace(/\/$/, '');
  const callback = `${canonicalOrigin}/auth/callback`;
  // "local" means the CMS runs on this machine. A public origin can still be
  // local: server.mjs serves it behind a tunnel or reverse proxy.
  const loopback = isLocalOrigin(canonicalOrigin);
  const local = loopback
    || localHosting
    || await confirm('Run it on this machine behind a tunnel or proxy?', false);

  if (local) {
    console.log('Local setup: nothing is created in Cloudflare and secrets go to .dev.vars.');
  } else {
    const auth = command(['whoami'], { capture: true });
    if (auth.status !== 0) {
      if (!await confirm('Wrangler is not signed in. Open Cloudflare login now?')) {
        throw new Error('Cloudflare login is required.');
      }
      run(['login']);
    } else {
      console.log('Cloudflare authentication confirmed.');
    }
  }

  const config = await readFile(CONFIG_PATH, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return readFile(EXAMPLE_CONFIG_PATH, 'utf8');
    throw error;
  });
  const defaultTimezone = await ask(
    'Default timezone for new page schedules (for example +0800 or Asia/Hong_Kong)',
    configuredDefaultTimezone(config),
    isDefaultTimezone,
  );

  // Every resource name derives from one namespace. The longest suffix is
  // "-plugin-views" (13 chars), and R2/Queue names stop at 63.
  const namespace = await ask(
    'Deployment namespace (prefixes every resource name)',
    'cms',
    (value) => resourceName(value) && value.length <= 50,
  );
  const publishEnabled = await featureEnabled('publish');
  const derived = {
    workerName: namespace,
    databaseName: namespace,
    publishedDatabaseName: `${namespace}-published`,
    bucketName: `${namespace}-media`,
    pluginViewsBucketName: `${namespace}-plugin-views`,
    queueName: `${namespace}-admin-jobs`,
    auditBucketName: `${namespace}-audit`,
  };
  console.log(`
  Worker              ${derived.workerName}
  Private D1          ${derived.databaseName}
  Published D1        ${publishEnabled ? derived.publishedDatabaseName : 'disabled'}
  Media R2 bucket     ${derived.bucketName}
  Plugin views R2     ${derived.pluginViewsBucketName} (if enabled)
  Admin job Queue     ${derived.queueName}
  Audit R2 bucket     ${derived.auditBucketName} (if enabled)
`);
  const customize = !await confirm('Use these names?');
  const name = (label, value, validate = resourceName) =>
    customize ? ask(label, value, validate) : value;

  const workerName = await name('Worker name', derived.workerName);
  const databaseName = await name('Private D1 database name', derived.databaseName);
  const publishedDatabaseName = publishEnabled ? await name(
    'Published D1 database name',
    derived.publishedDatabaseName,
    (value) => resourceName(value) && value !== databaseName,
  ) : null;
  const bucketName = await name('Private R2 media bucket name', derived.bucketName);
  const queueName = await name('Admin job Queue name', derived.queueName);
  const pluginViewsBucketName = await featureEnabled('plugins')
    && await confirm('Enable the optional plugin view R2 cache?', false)
    ? await name('Private R2 plugin view bucket name', derived.pluginViewsBucketName,
      (value) => resourceName(value) && value.length <= 63 && value !== bucketName)
    : null;

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

  let providers;
  while (!providers) {
    const answer = await ask('OAuth providers (comma-separated)', 'github');
    const selected = [...new Set(answer.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
    const invalid = selected.filter((provider) => !Object.hasOwn(PROVIDERS, provider));
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

  let databaseId;
  let publishedDatabaseId;
  let databaseReused = false;
  if (local) {
    console.log('\nwrangler dev simulates D1, R2 and Queues locally under .wrangler/state.');
  } else {
    console.log('\nCreating or reusing Cloudflare resources...');
    ({ id: databaseId, reused: databaseReused } = await ensureD1(databaseName));
    if (publishedDatabaseName) ({ id: publishedDatabaseId } = await ensureD1(publishedDatabaseName));
    ensureR2(bucketName);
    if (pluginViewsBucketName) ensureR2(pluginViewsBucketName);
    if (auditBucketName) ensureR2(auditBucketName);
    ensureQueue(queueName);
  }

  await updateConfig({
    workerName,
    databaseName,
    databaseId,
    publishedDatabaseName,
    publishedDatabaseId,
    bucketName,
    pluginViewsBucketName,
    auditBucketName,
    queueName,
    canonicalOrigin,
    defaultTimezone,
    providers,
    clientIds,
    microsoftTenant,
  });
  await setFeature('audit', auditEnabled);
  runNpm(['run', 'build:features']);
  runNpm(['run', 'build:migrations']);

  if (await confirm(local ? 'Apply D1 migrations to the local databases now?' : 'Apply production D1 migrations now?')) {
    const target = local ? '--local' : '--remote';
    run(['d1', 'migrations', 'apply', databaseName, target]);
    if (publishedDatabaseName) run(['d1', 'migrations', 'apply', publishedDatabaseName, target]);
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
  const deployed = !local && await confirm('Deploy 0xCMS now?', !databaseReused);
  if (deployed) {
    const grant = await firstAdminGrant(
      providers,
      'Configure a first admin in Cloudflare (replaces any existing INITIAL_USER_ROLES secret)?',
    );
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
    if (grant) {
      run(['secret', 'put', 'INITIAL_USER_ROLES'], { input: `${grant}\n` });
      console.log('Uploaded INITIAL_USER_ROLES.');
    }
  } else if (!local) {
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

  if (local) await writeLocalSecrets({ canonicalOrigin, providers, clientIds });

  console.log(`\nSetup complete.\nCMS origin: ${canonicalOrigin}\nOAuth callback: ${callback}`);
  console.log('\nSee "Set the first user\'s role" in README.md for manual grants and promotion of existing users.');
  if (local && loopback) {
    const port = new URL(canonicalOrigin).port || '80';
    const portSetting = port === '8787' ? '' : `PORT=${port} `;
    console.log(`Start it with: npm run dev${port === '8787' ? '' : ` -- --port ${port}`}`);
    console.log(`         or: ${portSetting}node server.mjs --build`);
    console.log(`         or: ${portSetting}${port === '8788' ? 'CRON_PORT=8789 ' : ''}node server-workerd.mjs --build --serve`);
  } else if (local) {
    const host = new URL(canonicalOrigin).host;
    console.log(`
Start it with: node server.mjs --build
           or: node server-workerd.mjs --build --serve
It listens on http://127.0.0.1:8787 (set PORT/HOST to change). Route ${host}
to that address with a tunnel or reverse proxy, for example:
  Cloudflare Tunnel  cloudflared tunnel route dns <tunnel> ${host}
                     ingress: hostname ${host} -> service http://127.0.0.1:8787
  nginx              proxy_pass http://127.0.0.1:8787;
                     proxy_set_header CF-Connecting-IP $remote_addr;
The proxy terminates HTTPS. It must send the client's address as CF-Connecting-IP
(Cloudflare Tunnel already does), or every visitor shares one sign-in rate limit
and the audit log records the proxy's address. Keep port 8787 unreachable from
anywhere but the proxy.`);
  }
}

try {
  await (upgradeMode ? upgrade() : main());
} catch (error) {
  console.error(`\n${operation} stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
