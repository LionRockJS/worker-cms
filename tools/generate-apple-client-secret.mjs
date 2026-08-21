#!/usr/bin/env node

import process from 'node:process';
import {
  DEFAULT_EXPIRES_IN_DAYS,
  MAX_EXPIRES_IN_DAYS,
  createAppleClientSecret,
  keyIdFromFileName,
  loadApplePrivateKey,
} from './apple-client-secret.mjs';

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
  --key-id ID              Private key ID (default: read from AuthKey_<ID>.p8)
  --client-id ID           Apple Services ID (required)
  --expires-in-days N      JWT lifetime, 1-${MAX_EXPIRES_IN_DAYS} days (default: ${DEFAULT_EXPIRES_IN_DAYS})

The JWT is written to stdout. Keep it secret and store it with:
  npx wrangler secret put APPLE_CLIENT_SECRET

npm run setup does all of this for you when apple is an enabled provider.
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

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const keyFile = required(options, '--key-file');
  const keyId = options['--key-id'] || keyIdFromFileName(keyFile);
  if (!keyId) throw new Error(`Missing required option: --key-id\n\n${usage()}`);

  const { token } = createAppleClientSecret({
    privateKey: await loadApplePrivateKey(keyFile),
    teamId: required(options, '--team-id'),
    keyId,
    clientId: required(options, '--client-id'),
    expiresInDays: Number(options['--expires-in-days'] ?? DEFAULT_EXPIRES_IN_DAYS),
  });

  process.stdout.write(`${token}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
