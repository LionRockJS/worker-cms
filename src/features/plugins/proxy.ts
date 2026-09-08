import { timingSafeEqualStr } from '../../core/http/crypto';
export { timingSafeEqualStr };
import type { JWTPayload } from '../../types';
import { sanitizePluginHtmlResponse } from './sanitize';

const FORWARD_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'user-agent',
  'x-requested-with',
];

/**
 * This CMS's tenant id toward multi-tenant plugin Workers: the canonical
 * origin, normalized. Sent as `x-cms-tenant` with every secret-authenticated
 * plugin call so one plugin deployment can serve several CMS hosts and pick
 * the right pairwise secret. Empty (header omitted) when CANONICAL_ORIGIN is
 * unset — single-tenant plugins accept that while exactly one tenant exists.
 */
export function pluginTenantId(env: { CANONICAL_ORIGIN?: string }): string {
  const configured = (env.CANONICAL_ORIGIN ?? '').trim();
  if (!configured) return '';
  try {
    return new URL(configured).origin;
  } catch {
    return configured.replace(/\/+$/, '');
  }
}

/** Sets the plugin auth pair (secret + tenant id) on an outbound header set. */
export function setPluginAuthHeaders(headers: Headers, pluginSecret: string, tenantId: string): void {
  headers.set('x-plugin-secret', pluginSecret);
  if (tenantId) headers.set('x-cms-tenant', tenantId);
}

/** Constant-time string equality for secret comparison. */
export function buildPluginProxyHeaders(source: Headers, user: JWTPayload, pluginSecret: string, tenantId = ''): Headers {
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(
    'x-cms-user',
    JSON.stringify({ id: user.sub, email: user.email, name: user.name, role: user.role }),
  );
  setPluginAuthHeaders(headers, pluginSecret, tenantId);
  return headers;
}

export function wantsCmsChrome(response: Response): boolean {
  if (response.headers.get('x-cms-chrome') !== '1') return false;
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/html') || isPluginClientViewResponse(response);
}

export function isPluginClientViewResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') ?? '';
  return response.headers.get('x-cms-client-view') === '1'
    && contentType.includes('application/json')
    && isSafePluginViewPath(response.headers.get('x-cms-view-path') ?? '');
}

export async function readPluginClientViewData(response: Response): Promise<{
  viewPath: string;
  data: Record<string, unknown>;
} | null> {
  if (!isPluginClientViewResponse(response)) return null;
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return {
    viewPath: response.headers.get('x-cms-view-path') ?? '',
    data: data as Record<string, unknown>,
  };
}

/** Decodes the percent-encoded x-cms-title header (plugins encode it for header safety). */
export function decodePluginTitle(raw: string | null): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function pluginDocumentResponse(upstreamResponse: Response, documentUrl = ''): Response {
  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  const response = contentType.includes('text/html')
    ? sanitizePluginHtmlResponse(upstreamResponse)
    : new Response(upstreamResponse.body, upstreamResponse);
  const allowFraming = upstreamResponse.headers.get('x-cms-frame') === '1';

  response.headers.delete('x-cms-frame');
  if (allowFraming) response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.delete('Set-Cookie');
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Content-Security-Policy', buildPluginDocumentCsp(allowFraming, documentUrl));
  return response;
}

function buildPluginDocumentCsp(allowFraming: boolean, documentUrl: string): string {
  const imageSources = ["'self'", 'data:', 'https:'];
  try {
    const hostname = new URL(documentUrl).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      imageSources.push('http://localhost:*', 'http://127.0.0.1:*');
    }
  } catch {
    // Callers without a document URL keep the production-safe default.
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    allowFraming ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
  ].join('; ');
}

function isSafePluginViewPath(path: string): boolean {
  return path.startsWith('/')
    && !path.includes('..')
    && (path.startsWith('/templates/') || path.startsWith('/sections/'))
    && (path.endsWith('.json') || path.endsWith('.liquid'));
}

let sharedOriginWarned = false;
export function warnSharedPluginOrigin(): void {
  if (sharedOriginWarned) return;
  sharedOriginWarned = true;
  console.warn(
    'Plugin admin pages are served on the CMS origin; a compromised plugin would '
    + 'gain same-origin authority. Serve plugins from a dedicated origin to isolate them.',
  );
}
