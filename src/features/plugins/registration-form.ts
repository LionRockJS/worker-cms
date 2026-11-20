// Plugin registration form parsing: URL, config and view-source checks shared
// by the Plugins screen and settings import. Kept out of routes/ so services
// can use it without importing the routers.

import type { PluginViewSource } from './local-views';
import type { PluginInput } from './store';
import { str, num } from '../../core/http/forms';

/**
 * Best-effort SSRF guard: rejects hostnames that are literally a private,
 * loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT, or
 * .internal address. The CMS issues server-side requests to plugin URLs and
 * forwards the signed-in user summary + the plugin secret, so a registered URL
 * must not be able to point those at internal infrastructure. This does not
 * defend against DNS rebinding or a public hostname that resolves to a private
 * IP — it only blocks the obvious literals.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  // WHATWG URL canonicalizes IPv4-mapped IPv6 addresses to hexadecimal, e.g.
  // [::ffff:127.0.0.1] becomes [::ffff:7f00:1]. Block the mapped loopback and
  // private IPv4 ranges as well as their dotted spelling.
  if (/^::ffff:(?:7f[0-9a-f]{2}|a[0-9a-f]{2}|a9fe|c0a8|ac1[0-9a-f]|64[4-7][0-9a-f]):[0-9a-f]{1,4}$/i.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true; // IPv6 ULA / link-local
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

/** Normalizes + validates a plugin base URL. Returns [normalized, error]. */
export function normalizeUrl(raw: string): [string, string | null] {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [trimmed, 'Enter a valid URL.'];
  }
  // localhost over http stays allowed for local development against a plugin
  // Worker on another port; every other host must be HTTPS and non-private.
  if (parsed.protocol === 'http:' && parsed.hostname === 'localhost') {
    return [trimmed, null];
  }
  if (parsed.protocol !== 'https:') {
    return [trimmed, 'URL must be HTTPS (http is allowed only for localhost).'];
  }
  if (isPrivateHost(parsed.hostname)) {
    return [trimmed, 'URL must not point to a private, loopback, or internal host.'];
  }
  return [trimmed, null];
}

/** Validates optional config JSON. Returns [stored, error]. */
function normalizeConfig(raw: string): [string | null, string | null] {
  const trimmed = raw.trim();
  if (!trimmed) return [null, null];
  try {
    JSON.parse(trimmed);
    return [trimmed, null];
  } catch {
    return [trimmed, 'Config must be valid JSON (or left blank).'];
  }
}

export function readForm(form: FormData, bucketAvailable: boolean, localAvailable: boolean): { input: PluginInput | null; error: string | null; raw: { label: string; url: string; enabled: boolean; sortOrder: number; config: string; trustedUi?: boolean; viewSource: PluginViewSource } } {
  const label = str(form.get('label'));
  const [url, urlError] = normalizeUrl(str(form.get('url')));
  const enabled = form.get('enabled') != null;
  const sortOrder = num(form.get('sort_order'), 0);
  let [config, configError] = normalizeConfig(str(form.get('config')));
  const viewSource: PluginViewSource = form.get('view_source') === 'local' ? 'local' : form.get('view_source') === 'bucket' ? 'bucket' : 'host';
  if (viewSource === 'bucket' && !bucketAvailable) configError = 'Configure the PLUGIN_VIEWS_BUCKET binding before selecting Bucket.';
  if (viewSource === 'local' && !localAvailable) configError = 'Set PLUGIN_VIEWS_DIR in the self-hosted server .env and restart before selecting Local files.';
  if (form.has('view_source') && !['host', 'bucket', 'local'].includes(str(form.get('view_source')))) configError = 'Invalid view source.';
  if (!configError) {
    const settings = { ...JSON.parse(config || '{}'), cmsTrustedUi: form.get('trusted_ui') === '1' };
    if (viewSource !== 'host') settings.cmsViewSource = viewSource;
    else delete settings.cmsViewSource;
    config = JSON.stringify(settings);
  }
  const raw = { label, url, enabled, sortOrder, viewSource, trustedUi: form.get('trusted_ui') === '1', config: str(form.get('config')) };

  const error = urlError ?? configError;
  if (error) return { input: null, error, raw };
  return { input: { label, url, enabled, config, sort_order: sortOrder }, error: null, raw };
}
