#!/usr/bin/env node

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const OPTION_NAMES = new Set([
  '--key-file',
  '--team-id',
  '--key-id',
  '--client-id',
  '--expires-in-days',
]);

function usage() {
  return `Generate an Apple Sign in with Apple client-secret JWT.

Usage:
  npm run apple:client-secret -- [options]

Options:
  --key-file PATH          Downloaded Apple .p8 private key (required)
  --team-id ID             Apple Developer Team ID (required)
  --key-id ID              Private key ID, from AuthKey_<ID>.p8 (required)
  --client-id ID           Apple Services ID (required)
  --expires-in-days N      JWT lifetime, 1-180 days (default: 180)

The JWT is written to stdout. Keep it secret and store it with:
  npx wrangler secret put APPLE_CLIENT_SECRET
`;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };

    const equals = token.indexOf('=');
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (!OPTION_NAMES.has(name)) {
      throw new Error(`Unknown option: ${token}\n\n${usage()}`);
    }

    const value = equals >= 0 ? token.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}\n\n${usage()}`);
    }
    options[name] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing required option: ${name}\n\n${usage()}`);
  return value;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const keyFile = resolve(required(options, '--key-file'));
  const teamId = required(options, '--team-id');
  const keyId = required(options, '--key-id');
  const clientId = required(options, '--client-id');
  const expiresInDays = Number(options['--expires-in-days'] ?? 180);

  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 180) {
    throw new Error('--expires-in-days must be an integer from 1 to 180');
  }

  let privateKey;
  try {
    privateKey = await readFile(keyFile, 'utf8');
  } catch {
    throw new Error(`Unable to read Apple private key: ${keyFile}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64Url(JSON.stringify({
    iss: teamId,
    iat: now,
    exp: now + expiresInDays * 24 * 60 * 60,
    aud: 'https://appleid.apple.com',
    sub: clientId,
  }));
  const signingInput = `${header}.${payload}`;

  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });

  process.stdout.write(`${signingInput}.${base64Url(signature)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
