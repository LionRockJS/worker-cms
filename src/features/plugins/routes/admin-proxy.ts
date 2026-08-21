// ============================================================
// Plugin admin proxy — forwards /admin/plugins/<id>/* to the
// plugin Worker's /__plugin/admin/* handler.
//
// Mounted under the authenticated, editor-guarded admin router, so
// the signed-in user is already verified. We forward a trusted
// user summary + the shared PLUGIN_SECRET, and strip CMS cookies
// so the plugin never sees CMS session credentials.
// ============================================================

import { Hono } from 'hono';
import type { Env, Permission, Variables } from '../../../types';
import { pluginById, PLUGIN_ORIGIN, PLUGIN_PREFIX } from '../registry';
import type { AppContext } from '../../../core/http/context';
import { coreExtensions } from '../../../core/extensions';
import { effectivePermissions, resolveRolePermissions, splitRoles } from '../../../core/auth/roles';
import { appendQuery } from '../../../core/http/forms';
import { jsonError, wantsJsonResponse } from '../../../core/auth/guards';
import { adminLayout, escHtml } from '../../../core/render/layout';
import { pluginClientView } from '../../../core/render/liquid';
import { buildBaseProps } from '../../../core/render/chrome';
import { viewsFor } from '../views';
import {
  buildPluginProxyHeaders,
  pluginTenantId,
  decodePluginTitle,
  readPluginClientViewData,
  pluginDocumentResponse,
  warnSharedPluginOrigin,
  wantsCmsChrome,
} from '../proxy';
import { sanitizePluginHtmlFragment } from '../sanitize';
import { buildContentSecurityPolicy } from '../../../core/http/headers';
import { currentCspNonce } from '../../../core/http/request-context';
import { computeIntegrity, getAssetApproval, listApprovals } from '../assets';
import {
  claimFormOnceToken,
  extractFormOnceToken,
  releaseFormOnceToken,
} from '../../../core/auth/form-once';
import type { ApprovedPluginAssets } from '../../../core/render/layout';
import { pluginPermissions, pluginTrustLevel, type PluginManifest } from '../types';
import { pluginViewRevision, pluginWorkerRevision } from '../revision';

export const pluginAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// No blanket role gate here — see userCanAccessPlugin() below, applied inside
// proxyToPlugin once the plugin's manifest (and its declared permissions) is
// resolved.
// Registered before the generic catch-all so approved-asset requests don't
// fall through to the plugin admin proxy.
pluginAdminRoutes.get('/plugins/:pluginId/assets/*', (c) => servePluginAsset(c));
pluginAdminRoutes.get('/plugins/:pluginId/views/*', (c) => servePluginView(c));
pluginAdminRoutes.all('/plugins/:pluginId', (c) => proxyToPlugin(c));
pluginAdminRoutes.all('/plugins/:pluginId/*', (c) => proxyToPlugin(c));

/**
 * Plugin admin pages render in the CMS origin (see proxyToPlugin), so a hostile
 * or compromised plugin would run with the CMS's same-origin authority. Until
 * plugins are served from a dedicated origin, only 'admin' passes by default.
 *
 * A non-admin needs BOTH keys, and neither alone is enough:
 *
 *   • the CMS-side `plugin:access` permission — the host's statement that this
 *     role may reach plugin admin pages at all. Only an admin can grant it, and
 *     no manifest can name it (see below);
 *   • one of the permissions this plugin declares — the plugin's statement about
 *     which of its permission-holders its own admin routes are for. A plugin
 *     declaring none stays admin-only (fail closed).
 *
 * Requiring the CMS-side key is what keeps the opt-in from being a self-grant:
 * on its own, the manifest half means a plugin decides who may run code in the
 * CMS origin. The declared half is read through pluginPermissions(), so a
 * manifest can only name values namespaced to its own pinned id — never
 * `plugin:access`, never `content:read`, never another plugin's permission.
 */
async function canReachPluginAdmin(c: AppContext, manifest: PluginManifest): Promise<boolean> {
  const declared = pluginPermissions(manifest);
  if (declared.length === 0) return false;
  const map = await resolveRolePermissions(c.env);
  const granted = effectivePermissions(map, c.get('user').role);
  return granted.has('plugin:access') && declared.some(({ value }) => granted.has(value as Permission));
}

function adminOnlyForbidden(c: AppContext): Response {
  if (wantsJsonResponse(c.req.raw)) {
    return jsonError({ success: false, error: 'Admin role required' }, 403, 'admin-role-required');
  }
  return c.text('Forbidden: admin role required', 403);
}

/**
 * Serves a single admin-approved plugin asset (JS/CSS) at a CMS-origin URL, so
 * chrome-wrapped plugin templates can reference it as a same-origin
 * <script src>/<link href> under the strict CSP (script-src 'self'). Bytes are
 * re-fetched from the plugin and re-hashed on every request — if they no
 * longer match the pinned approval, this fails closed rather than serving
 * content an admin never reviewed. See utils/plugin-assets.ts.
 */
async function servePluginAsset(c: AppContext): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) return c.notFound();

  const isAdmin = splitRoles(c.get('user').role).includes('admin');
  const plugin = await pluginById(c.env, pluginId);
  if (!isAdmin && !(plugin && await canReachPluginAdmin(c, plugin.manifest))) {
    return adminOnlyForbidden(c);
  }
  if (!plugin) return c.notFound();

  const url = new URL(c.req.url);
  // The Hono route is `/plugins/:pluginId/assets/*` (a fixed "assets" segment
  // plus a wildcard), but manifest asset paths already start with "/assets/..."
  // themselves — so the CMS-side URL is prefix-only (no extra "/assets") and
  // the remainder reconstructs the manifest path exactly, e.g.
  // "/admin/plugins/checkin/assets/js/kiosk.js" -> "/assets/js/kiosk.js".
  const prefix = `/admin/plugins/${pluginId}`;
  const assetPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  if (!assetPath.startsWith('/') || assetPath.includes('..')) return c.notFound();

  const approval = await getAssetApproval(c.env.DB, pluginId, assetPath);
  if (!approval) return c.text('Not found: asset not approved', 404);

  const upstream = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${assetPath}`);
  if (!upstream.ok) return c.text('Asset unavailable', 502);
  const bytes = await upstream.arrayBuffer();
  const integrity = await computeIntegrity(bytes);
  if (integrity !== approval.integrity) {
    // The plugin's file changed since approval — do not serve unreviewed bytes.
    return c.text('Asset changed since approval; re-approval required', 409);
  }

  // A revisioned request (`?r=<deploy id>`, added to the <script>/<link>/wasm
  // URLs the client emits) is safe to cache immutably: a new deploy changes the
  // revision, so the URL changes and the browser refetches (and re-checks
  // integrity on that miss). Without a revision — e.g. a direct hit — stay
  // uncached so the integrity check runs every request. Scripts/links are also
  // SRI-pinned in the page, and a revoked asset is dropped from the HTML
  // entirely, so a cached copy is never referenced after revocation.
  const revisioned = url.searchParams.has('r');
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': assetPath.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : assetPath.endsWith('.wasm')
          ? 'application/wasm'
          : 'text/javascript; charset=utf-8',
      'cache-control': revisioned ? 'public, max-age=31536000, immutable' : 'no-store',
    },
  });
}

/**
 * Serves browser-fetched plugin client-view files (Liquid/JSON) from the CMS
 * origin. They are not admin-approved executable assets, but revisioned view
 * URLs are still deploy-addressed and can be cached immutably.
 */
async function servePluginView(c: AppContext): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) return c.notFound();

  const isAdmin = splitRoles(c.get('user').role).includes('admin');
  const plugin = await pluginById(c.env, pluginId);
  if (!isAdmin && !(plugin && await canReachPluginAdmin(c, plugin.manifest))) {
    return adminOnlyForbidden(c);
  }
  if (!plugin) return c.notFound();

  if (!plugin.secret) {
    console.error(`Plugin ${pluginId} has no secret configured (and no PLUGIN_SECRET fallback)`);
    return new Response('Server misconfigured', {
      status: 500,
      headers: { 'X-CMS-Error': 'plugin-secret-required' },
    });
  }

  const url = new URL(c.req.url);
  const prefix = `/admin/plugins/${pluginId}/views`;
  const viewPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  if (!viewPath.startsWith('/') || viewPath.includes('..')) return c.notFound();

  const headers = buildPluginProxyHeaders(c.req.raw.headers, c.get('user'), plugin.secret, pluginTenantId(c.env));
  const upstreamResponse = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/admin/views${viewPath}${url.search}`, {
    method: c.req.method,
    headers,
    redirect: 'manual',
  });
  const response = new Response(upstreamResponse.body, upstreamResponse);
  if (upstreamResponse.status === 200) {
    const revisioned = url.searchParams.has('r');
    response.headers.set('cache-control', revisioned ? 'public, max-age=31536000, immutable' : 'no-store');
  }
  return response;
}

/** Admin-approved assets for a plugin, restricted to paths it currently
 *  declares in its manifest (an approval for a path the plugin no longer
 *  lists is dormant, not revived, until re-declared and re-approved). */
async function approvedAssetsFor(c: AppContext, manifest: PluginManifest, declaredPaths: Set<string>): Promise<ApprovedPluginAssets> {
  if (declaredPaths.size === 0) return {};
  const pluginRevision = pluginWorkerRevision(manifest);
  const approvals = await listApprovals(c.env.DB, manifest.id);
  const entries = approvals
    .filter((approval) => declaredPaths.has(approval.path))
    .map((approval) => ({
      path: approval.path,
      integrity: approval.integrity,
      revision: pluginRevision || approval.integrity,
    }));
  return entries.length ? { [manifest.id]: entries } : {};
}

async function proxyToPlugin(c: AppContext): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) return c.notFound();

  const isAdmin = splitRoles(c.get('user').role).includes('admin');
  const plugin = await pluginById(c.env, pluginId);

  // Non-admins are rejected the same way whether the plugin is unregistered or
  // just doesn't grant them access — matching the prior route-level gate, which
  // never resolved the plugin at all for a non-admin.
  if (!isAdmin && !(plugin && await canReachPluginAdmin(c, plugin.manifest))) {
    return adminOnlyForbidden(c);
  }

  if (!plugin) return c.notFound();

  const trustLevel = pluginTrustLevel(plugin.manifest);
  if (trustLevel === 'server-only') return c.notFound();

  // Each plugin authenticates with its own secret (or the env fallback). Fail
  // closed when neither is configured rather than proxying unauthenticated.
  if (!plugin.secret) {
    console.error(`Plugin ${pluginId} has no secret configured (and no PLUGIN_SECRET fallback)`);
    return new Response('Server misconfigured', {
      status: 500,
      headers: { 'X-CMS-Error': 'plugin-secret-required' },
    });
  }

  const url = new URL(c.req.url);
  const prefix = `/admin/plugins/${pluginId}`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const insideSandbox = trustLevel === 'sandboxed-ui' && url.searchParams.get('__cms_sandbox') === '1';
  if (trustLevel === 'sandboxed-ui' && !insideSandbox) {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Sandboxed plugin mutations require a capability bridge', 405);
    return sandboxedPluginPage(c, pluginId, plugin.manifest.name);
  }
  url.searchParams.delete('__cms_sandbox');
  const pluginAdminPath = `${PLUGIN_PREFIX}/admin${rest}${url.search}`;
  const upstream = `${PLUGIN_ORIGIN}${pluginAdminPath}`;

  const headers = buildPluginProxyHeaders(c.req.raw.headers, c.get('user'), plugin.secret, pluginTenantId(c.env));

  warnSharedPluginOrigin();

  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;

  // Single-use submit token (see utils/form-once.ts): claim before any
  // downstream work so the second POST of a double submit is caught even when
  // both arrive concurrently. Missing/unverifiable tokens pass through — only
  // an exact replay of an already-claimed token is treated as a duplicate.
  let claimedOnceToken: string | null = null;
  if (c.req.method === 'POST' && body) {
    const contentType = c.req.raw.headers.get('content-type') ?? '';
    const submitted = await extractFormOnceToken(body, contentType);
    const claim = await claimFormOnceToken(c.env, c.env.JWT_SECRET, submitted);
    if (claim === 'duplicate') return duplicateSubmitResponse(c, pluginId);
    if (claim === 'claimed') claimedOnceToken = submitted;
  }

  // Long actions go to a durable runner when one is installed. It answers
  // false when it cannot take the work (no queue binding), and is absent
  // entirely without the jobs feature — either way we forward synchronously
  // below, which is the pre-queue behaviour.
  if (shouldQueuePluginAdminAction(c, pluginId, rest)) {
    let queued = false;
    try {
      queued = await coreExtensions().enqueueAdminAction?.(c, {
        contributorId: pluginId,
        method: c.req.method,
        path: pluginAdminPath,
        contentType: c.req.raw.headers.get('content-type'),
        body: body ? new TextDecoder().decode(body) : '',
      }) ?? false;
    } catch (error) {
      if (claimedOnceToken) await releaseFormOnceToken(c.env, claimedOnceToken);
      throw error;
    }
    if (queued) return c.redirect(queueRedirect(pluginId, rest));
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await plugin.fetcher.fetch(upstream, {
      method: c.req.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch (error) {
    if (claimedOnceToken) await releaseFormOnceToken(c.env, claimedOnceToken);
    throw error;
  }
  // A failed action isn't a completed submission — release the claim so the
  // user's retry of the same form isn't misread as a duplicate.
  if (claimedOnceToken && upstreamResponse.status >= 500) {
    await releaseFormOnceToken(c.env, claimedOnceToken);
  }

  if (insideSandbox) {
    const framedHeaders = new Headers(upstreamResponse.headers);
    framedHeaders.set('x-cms-frame', '1');
    return pluginDocumentResponse(new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: framedHeaders,
    }), c.req.url);
  }

  // Opt-in chrome: a plugin that returns an HTML *fragment* with `x-cms-chrome: 1`
  // gets wrapped in the standard admin layout — same sidebar, fonts, and
  // /assets/admin.css as every CMS page — so plugin admin UIs match the CMS
  // without each plugin reinventing the shell. The wrapped page runs under the
  // CMS's strict nonce CSP (no `unsafe-inline` scripts), which is stricter than
  // the relaxed full-document policy below. Plugins that return a full document
  // (no header) keep the legacy behavior.
  if (wantsCmsChrome(upstreamResponse)) {
    const clientView = await readPluginClientViewData(upstreamResponse.clone());
    const body = clientView
      ? pluginClientView(
          clientView.viewPath,
          clientView.data,
          `/admin/plugins/${pluginId}/views`,
          pluginViewRevision(plugin.manifest),
          plugin.manifest.i18n === true,
        )
      : await sanitizePluginHtmlFragment(await upstreamResponse.text());
    const title = decodePluginTitle(upstreamResponse.headers.get('x-cms-title')) || plugin.manifest.name || 'Plugin';
    const base = await buildBaseProps(c);
    const declaredAssetPaths = new Set((plugin.manifest.assets ?? []).map((asset) => asset.path));
    const approvedPluginAssets = await approvedAssetsFor(c, plugin.manifest, declaredAssetPaths);
    const wrapped = await adminLayout(viewsFor(c.env), base, { title, body, approvedPluginAssets });
    const response = c.html(wrapped, upstreamResponse.status as 200);
    // Opt-in capability relaxation: a plugin page can request the camera (e.g.
    // the check-in kiosk scanner) by returning `x-cms-permissions: camera`. We
    // then enable the camera for this page and add `'wasm-unsafe-eval'` to
    // script-src (the QR decoder is WebAssembly), setting both headers here so
    // the global middleware leaves them alone. Every other admin page keeps the
    // strict camera-off / no-wasm defaults.
    if (upstreamResponse.headers.get('x-cms-permissions') === 'camera') {
      response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
      response.headers.set('Content-Security-Policy', buildContentSecurityPolicy(currentCspNonce(), { allowWasm: true }));
    }
    // Otherwise no explicit CSP — the global security middleware applies the
    // strict nonce policy (matching the nonce adminLayout embeds).
    return response;
  }

  // Give full-document plugin pages their own CSP so (a) the CMS's strict nonce
  // CSP isn't imposed on plugin HTML (which would break legitimate plugin
  // scripts) and (b) plugin pages still get baseline hardening. This is NOT
  // origin isolation - see warnSharedPluginOrigin() - it only limits injection
  // into an otherwise-benign plugin.
  return pluginDocumentResponse(upstreamResponse, c.req.url);
}

async function sandboxedPluginPage(c: AppContext, pluginId: string, title: string): Promise<Response> {
  const frameUrl = new URL(c.req.url);
  frameUrl.searchParams.set('__cms_sandbox', '1');
  const body = `<iframe
    src="${escHtml(frameUrl.pathname + frameUrl.search)}"
    title="${escHtml(title)}"
    sandbox="allow-downloads allow-forms allow-popups allow-scripts"
    referrerpolicy="no-referrer"
    class="block h-screen w-full border-0 bg-white"
    data-plugin-sandbox="${escHtml(pluginId)}"></iframe>`;
  const base = await buildBaseProps(c);
  const html = await adminLayout(viewsFor(c.env), base, { title, body });
  return c.html(html);
}

function shouldQueuePluginAdminAction(c: AppContext, pluginId: string, rest: string): boolean {
  if (c.req.method !== 'POST') return false;
  if (pluginId !== 'events') return false;
  return /^\/events\/\d+\/(?:duplicate|delete)$/.test(rest);
}

function queueRedirect(pluginId: string, rest: string): string {
  const action = rest.endsWith('/duplicate') ? 'duplication' : 'deletion';
  return withFlash(`/admin/plugins/${pluginId}/events`, `Event ${action} queued. It may take a moment to finish.`);
}

function withFlash(path: string, message: string): string {
  return appendQuery(path, `flash=${encodeURIComponent(message)}`);
}

/** Response for a re-POST of an already-claimed _cms_once token: bounce back
 *  to the page the form lives on rather than repeating the action. */
function duplicateSubmitResponse(c: AppContext, pluginId: string): Response {
  if (wantsJsonResponse(c.req.raw)) {
    return jsonError({ success: false, error: 'This form was already submitted' }, 409, 'duplicate-submission');
  }
  return c.redirect(withFlash(duplicateReturnPath(c, pluginId), 'Already submitted — the duplicate was ignored.'));
}

function duplicateReturnPath(c: AppContext, pluginId: string): string {
  const referer = c.req.header('referer');
  if (referer) {
    try {
      const url = new URL(referer, c.req.url);
      if (url.origin === new URL(c.req.url).origin) {
        url.searchParams.delete('flash'); // withFlash() adds ours
        return url.pathname + url.search;
      }
    } catch {
      // Unparsable referer — fall back to the plugin's admin root.
    }
  }
  return `/admin/plugins/${pluginId}`;
}
