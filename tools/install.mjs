#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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

The wizard creates or reuses D1, R2, and Queue resources, updates
wrangler.toml, applies migrations, configures OAuth secrets, and deploys.`);
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

  if (database) {
    console.log(`Reusing D1 database ${name}.`);
  } else {
    console.log(`Creating D1 database ${name}...`);
    run(['d1', 'create', name]);
    const refreshed = run(['d1', 'list', '--json'], { capture: true });
    database = parseJsonOutput(refreshed.stdout).find((item) => item.name === name);
  }

  const id = database?.uuid || database?.id || database?.database_id;
  if (!id) throw new Error(`Could not find the database ID for ${name}.`);
  return id;
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
  const original = await readFile(CONFIG_PATH, 'utf8');
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
  console.log('Updated wrangler.toml.');
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

  const workerName = await ask('Worker name', 'worker-cms', resourceName);
  const databaseName = await ask('Private D1 database name', 'cms', resourceName);
  const publishedDatabaseName = await ask(
    'Published D1 database name',
    'cms-published',
    (value) => resourceName(value) && value !== databaseName,
  );
  const bucketName = await ask('Private R2 media bucket name', 'worker-cms-media', resourceName);
  const queueName = await ask('Admin job Queue name', 'cms-admin-jobs', resourceName);
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
  const databaseId = await ensureD1(databaseName);
  const publishedDatabaseId = await ensureD1(publishedDatabaseName);
  ensureR2(bucketName);
  ensureQueue(queueName);

  await updateConfig({
    workerName,
    databaseName,
    databaseId,
    publishedDatabaseName,
    publishedDatabaseId,
    bucketName,
    queueName,
    canonicalOrigin,
    providers,
    clientIds,
    microsoftTenant,
  });

  if (await confirm('Apply production D1 migrations now?')) {
    run(['d1', 'migrations', 'apply', databaseName, '--remote']);
    run(['d1', 'migrations', 'apply', publishedDatabaseName, '--remote']);
  }

  const deployed = await confirm('Deploy 0xCMS now?');
  if (deployed) {
    // Create the Worker before uploading secrets. Wrangler otherwise prompts
    // to create a missing Worker, which is incompatible with piped secrets.
    runNpm(['run', 'deploy']);
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
