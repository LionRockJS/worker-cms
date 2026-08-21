import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

/** Apple rejects a client secret that lives longer than six months. */
export const MAX_EXPIRES_IN_DAYS = 180;
export const DEFAULT_EXPIRES_IN_DAYS = 180;

const APPLE_ID = /^[A-Z0-9]{10}$/;

/** Apple Team IDs and key IDs are both 10-character alphanumeric strings. */
export function isAppleId(value) {
  return APPLE_ID.test(String(value ?? '').trim().toUpperCase());
}

export function isExpiresInDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= MAX_EXPIRES_IN_DAYS;
}

/** Apple names the download AuthKey_<key-id>.p8, so the key ID is free. */
export function keyIdFromFileName(keyFile) {
  const match = /^AuthKey_([A-Z0-9]{10})\.p8$/i.exec(basename(keyFile));
  return match ? match[1].toUpperCase() : undefined;
}

/**
 * Read a downloaded .p8 file and confirm it holds an EC key usable for ES256.
 * Throws a message worth showing to the person running setup.
 */
export async function loadApplePrivateKey(keyFile) {
  const path = resolve(keyFile.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));

  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Unable to read Apple private key: ${path}`);
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(contents);
  } catch {
    throw new Error(`${path} is not a valid PEM private key. Download the .p8 key from Apple again.`);
  }
  if (privateKey.asymmetricKeyType !== 'ec') {
    throw new Error(`${path} is not an elliptic-curve key. Apple sign-in keys are .p8 EC keys.`);
  }
  return privateKey;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/**
 * Build the ES256 JWT Apple accepts in place of a static OAuth client secret.
 * `iss` is the Team ID, `sub` the Services ID, and `kid` the key ID.
 */
export function createAppleClientSecret({
  privateKey,
  teamId,
  keyId,
  clientId,
  expiresInDays = DEFAULT_EXPIRES_IN_DAYS,
}) {
  if (!isAppleId(teamId)) throw new Error(`Invalid Apple team ID: ${teamId}`);
  if (!isAppleId(keyId)) throw new Error(`Invalid Apple key ID: ${keyId}`);
  if (!clientId) throw new Error('Missing Apple client ID (Services ID).');
  if (!isExpiresInDays(expiresInDays)) {
    throw new Error(`Expiry must be an integer from 1 to ${MAX_EXPIRES_IN_DAYS} days.`);
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + Number(expiresInDays) * 24 * 60 * 60;
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: String(keyId).toUpperCase() }));
  const payload = base64Url(JSON.stringify({
    iss: String(teamId).toUpperCase(),
    iat: issuedAt,
    exp: expiresAt,
    aud: 'https://appleid.apple.com',
    sub: clientId,
  }));
  const signingInput = `${header}.${payload}`;

  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  // Apple requires the raw r||s signature, not the DER encoding Node defaults to.
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });

  return { token: `${signingInput}.${base64Url(signature)}`, expiresAt: new Date(expiresAt * 1000) };
}
