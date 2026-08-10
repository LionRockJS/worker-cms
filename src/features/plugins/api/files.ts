// Authenticated file storage for plugins that opt into declared prefixes.
//
// The host owns MEDIA_BUCKET, so a multi-tenant plugin must not bind that
// bucket directly. The plugin authenticates with its own /__cms credential and
// this Worker writes to the bucket belonging to the CMS that received the
// request. A plugin can only address prefixes declared in its manifest and
// explicitly approved by a CMS administrator; the API has no theme-specific
// behavior.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../types';
import { authenticatePlugin } from './auth';
import { listFilePrefixApprovals } from '../file-prefixes';

export const filesApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

type FilesContext = Context<{ Bindings: Env; Variables: Variables }>;

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const MAX_LIST_LIMIT = 1000;
const NO_STORE = { 'cache-control': 'no-store' } as const;

function unavailable(c: FilesContext): Response {
  return c.json({ error: 'file_storage_unavailable' }, 501, NO_STORE);
}

function denied(c: FilesContext): Response {
  return c.json({ error: 'file_storage_not_enabled' }, 403, NO_STORE);
}

function notApproved(c: FilesContext): Response {
  return c.json({ error: 'file_storage_not_approved' }, 403, NO_STORE);
}

function normalizePath(raw: string, allowTrailingSlash = false): string | null {
  const path = raw.trim().replace(/^\/+/, '');
  if (!path || path.includes('\\') || path.includes('//') || (!allowTrailingSlash && path.endsWith('/'))) return null;
  const segments = path.split('/');
  if (segments.some((segment, index) => (
    segment === '.'
    || segment === '..'
    || (!segment && !(allowTrailingSlash && index === segments.length - 1))
  ))) return null;
  if (new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) return null;
  return path;
}

function isAllowedPath(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function validateKey(raw: string, prefixes: string[]): string | null {
  const key = normalizePath(raw);
  return key && isAllowedPath(key, prefixes) ? key : null;
}

function validatePrefix(raw: string, prefixes: string[]): string | null {
  const prefix = normalizePath(raw, true);
  return prefix && isAllowedPath(prefix, prefixes) ? prefix : null;
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('cache-control', 'no-store');
  headers.set('etag', object.httpEtag);
  return headers;
}

function contentLength(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

async function authenticateFiles(c: FilesContext) {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;
  const declaredPrefixes = auth.plugin.manifest.filePrefixes ?? [];
  if (declaredPrefixes.length === 0) return denied(c);
  const approvals = await listFilePrefixApprovals(c.env.DB, auth.plugin.manifest.id);
  const approvedPrefixes = new Set(approvals.map((approval) => approval.prefix));
  const prefixes = declaredPrefixes.filter((prefix) => approvedPrefixes.has(prefix));
  if (prefixes.length === 0) return notApproved(c);
  if (!c.env.MEDIA_BUCKET) return unavailable(c);
  return { auth, prefixes, bucket: c.env.MEDIA_BUCKET };
}

function listOptions(
  c: FilesContext,
  prefixes: string[],
): { prefix: string; delimiter?: string; limit: number; cursor?: string } | Response {
  const prefix = validatePrefix(c.req.query('prefix') || prefixes[0], prefixes);
  if (!prefix) return c.json({ error: 'invalid_prefix' }, 400, NO_STORE);

  const delimiter = c.req.query('delimiter');
  if (delimiter && delimiter !== '/') return c.json({ error: 'invalid_delimiter' }, 400, NO_STORE);

  const rawLimit = c.req.query('limit');
  const parsedLimit = rawLimit ? Number(rawLimit) : MAX_LIST_LIMIT;
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIST_LIMIT) {
    return c.json({ error: 'invalid_limit' }, 400, NO_STORE);
  }

  const cursor = c.req.query('cursor') || undefined;
  return {
    prefix,
    ...(delimiter ? { delimiter } : {}),
    limit: parsedLimit,
    ...(cursor ? { cursor } : {}),
  };
}

filesApiRoutes.get('/files', async (c) => {
  const access = await authenticateFiles(c);
  if (access instanceof Response) return access;

  const keyParam = c.req.query('key');
  if (keyParam !== undefined) {
    if (c.req.query('prefix') || c.req.query('delimiter') || c.req.query('cursor') || c.req.query('limit')) {
      return c.json({ error: 'conflicting_query' }, 400, NO_STORE);
    }
    const key = validateKey(keyParam, access.prefixes);
    if (!key) return c.json({ error: 'invalid_key' }, 400, NO_STORE);
    const object = await access.bucket.get(key);
    if (!object) return c.notFound();
    return new Response(object.body, { headers: objectHeaders(object) });
  }

  const options = listOptions(c, access.prefixes);
  if (options instanceof Response) return options;
  const listed = await access.bucket.list(options);
  return c.json({
    objects: listed.objects.map((object) => ({
      key: object.key,
      size: object.size,
      etag: object.etag,
      http_etag: object.httpEtag,
      uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : String(object.uploaded),
      content_type: object.httpMetadata?.contentType ?? 'application/octet-stream',
    })),
    delimited_prefixes: listed.delimitedPrefixes,
    truncated: listed.truncated,
    ...(listed.truncated ? { cursor: listed.cursor } : {}),
  }, 200, NO_STORE);
});

filesApiRoutes.on('HEAD', '/files', async (c) => {
  const access = await authenticateFiles(c);
  if (access instanceof Response) return access;

  const key = validateKey(c.req.query('key') || '', access.prefixes);
  if (!key) return c.json({ error: 'invalid_key' }, 400, NO_STORE);
  const object = await access.bucket.head(key);
  if (!object) return c.notFound();
  return new Response(null, { headers: objectHeaders(object) });
});

filesApiRoutes.put('/files', async (c) => {
  const access = await authenticateFiles(c);
  if (access instanceof Response) return access;

  const key = validateKey(c.req.query('key') || '', access.prefixes);
  if (!key) return c.json({ error: 'invalid_key' }, 400, NO_STORE);
  const declared = contentLength(c.req.raw);
  if (declared === -1 || (declared !== null && declared > MAX_FILE_BYTES)) {
    return c.json({ error: 'file_too_large', max_bytes: MAX_FILE_BYTES }, 413, NO_STORE);
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return c.json({ error: 'file_too_large', max_bytes: MAX_FILE_BYTES }, 413, NO_STORE);
  }

  await access.bucket.put(key, bytes, {
    httpMetadata: {
      contentType: c.req.header('content-type') || 'application/octet-stream',
    },
  });
  return c.json({ ok: true, key, size: bytes.byteLength }, 200, NO_STORE);
});
