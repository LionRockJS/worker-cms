import type { Env } from '../../types';
import { splitRoles } from './roles';

interface Address { value: bigint; bits: number }

/** Strict literals only: no DNS, ports, zones, integer/octal IPv4 or URL syntax. */
function address(input: string): Address | null {
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(input)) {
    const parts = input.split('.').map(Number);
    if (parts.some(n => n > 255)) return null;
    return { value: parts.reduce((n, part) => (n << 8n) | BigInt(part), 0n), bits: 32 };
  }
  if (!input.includes(':') || !/^[\da-fA-F:.]+$/.test(input)) return null;
  try {
    // The URL parser validates and canonicalizes IPv6, including embedded IPv4.
    const host = new URL(`http://[${input}]/`).hostname.slice(1, -1);
    const halves = host.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    if (parts.length !== 8) return null;
    const value = parts.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
    // Treat IPv4-mapped IPv6 as IPv4 to avoid alternate-notation bypasses.
    return value >> 32n === 0xffffn ? { value: value & 0xffffffffn, bits: 32 } : { value, bits: 128 };
  } catch { return null; }
}

function network(input: string): { ip: Address; prefix: number } | null {
  const parts = input.split('/');
  if (parts.length > 2) return null;
  const ip = address(parts[0]);
  if (!ip) return null;
  let prefix = parts.length === 1 ? ip.bits : /^(0|[1-9]\d{0,2})$/.test(parts[1]) ? Number(parts[1]) : -1;
  if (parts.length === 2 && ip.bits === 32 && parts[0].includes(':')) {
    // A mapped IPv4 CIDR uses IPv6 prefix lengths (for example /120 = /24).
    if (prefix < 96 || prefix > 128) return null;
    prefix -= 96;
  }
  if (prefix < 0 || prefix > ip.bits) return null;
  return { ip, prefix };
}

export function parseIpAllowlist(input: string): string[] {
  if (input.length > 16384) throw new Error('IP allowlist is too long');
  const entries = [...new Set(input.split(/[\s,]+/).filter(Boolean).map(value => value.toLowerCase()))];
  if (entries.length > 100 || entries.some(entry => !network(entry))) throw new Error('Enter up to 100 valid IPv4/IPv6 addresses or CIDR ranges');
  return entries;
}

export function ipMatchesAllowlist(ip: string | null, entries: readonly string[]): boolean {
  if (!entries.length) return true;
  const candidate = ip ? address(ip) : null;
  if (!candidate) return false;
  return entries.some(entry => {
    const range = network(entry);
    if (!range || range.ip.bits !== candidate.bits) return false;
    const shift = BigInt(candidate.bits - range.prefix);
    return candidate.value >> shift === range.ip.value >> shift;
  });
}

export function storedIpAllowlist(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'string')) throw new Error('Invalid stored IP policy');
  return parseIpAllowlist(parsed.join('\n'));
}

/** Cloudflare supplies the connecting IP. Never trust X-Forwarded-For. */
export function connectingIp(headers: Headers): string | null {
  return headers.get('CF-Connecting-IP');
}

export class IpAccessUnavailableError extends Error {
  constructor() { super('IP access policy unavailable'); }
}

/** Fresh policy on every protected request, including existing sessions.
 * Every restricted role must match; adding an unrestricted role cannot bypass it.
 * Missing IPs fail closed for restricted accounts; malformed policies throw.
 */
export async function accountIpAllowed(env: Env, userId: string | number, ip: string | null): Promise<boolean> {
  try { return await readAccountIpAllowed(env, userId, ip); }
  catch { throw new IpAccessUnavailableError(); }
}

async function readAccountIpAllowed(env: Env, userId: string | number, ip: string | null): Promise<boolean> {
  const user = await env.DB.prepare('SELECT role, ip_unrestricted FROM users WHERE id = ?').bind(userId)
    .first<{ role: string; ip_unrestricted: number }>();
  if (!user) return false;
  if (user.ip_unrestricted === 1) return true;
  const roles = splitRoles(user.role);
  const rows = await env.DB.prepare('SELECT ip_allowlist FROM roles WHERE name IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(roles)).all<{ ip_allowlist: string }>();
  return rows.results.every(row => ipMatchesAllowlist(ip, storedIpAllowlist(row.ip_allowlist)));
}
