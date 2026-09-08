import { Hono } from 'hono';
import { applyMediaResponseHeaders, mediaObjectResponse } from '../security';
import type { Env, Variables } from '../../../types';

export const mediaPublicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Square thumbnail edge, in pixels, for the admin media pickers. */
const PREVIEW_SIZE = 100;

async function isPublicMedia(env: Env, key: string): Promise<boolean> {
  if (!await env.DB.prepare('SELECT 1 FROM media_files WHERE key = ?').bind(key).first()) return false;
  const object = await env.MEDIA_BUCKET?.head(key);
  return !!object && object.customMetadata?.cmsPrivate !== '1';
}
/** Images binding input ceiling; larger objects are served untransformed. */
const MAX_TRANSFORM_BYTES = 20 * 1024 * 1024;

mediaPublicRoutes.get('/media-preview/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media-preview\//, '');
  if (!await isPublicMedia(c.env, key)) return c.notFound();

  const cache = caches.default;
  const cacheKey = new Request(c.req.url + (c.req.url.includes('?') ? '&' : '?') + '__media_policy=2');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const thumbnail = await thumbnailResponse(c.env, key);
  if (thumbnail) {
    c.executionCtx.waitUntil(cache.put(cacheKey, thumbnail.clone()));
    return thumbnail;
  }

  return await mediaObjectResponse(c.env.MEDIA_BUCKET, key) ?? c.notFound();
});

mediaPublicRoutes.get('/media/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media\//, '');
  if (!await isPublicMedia(c.env, key)) return c.notFound();
  return await mediaObjectResponse(c.env.MEDIA_BUCKET, key) ?? c.notFound();
});

/**
 * Resize an R2 object to a square thumbnail via the Images binding. Returns
 * null whenever the transform cannot or should not run - no binding, missing
 * object, non-image, oversized input, or a decode failure - leaving the caller
 * to serve the original object instead.
 */
async function thumbnailResponse(env: Env, key: string): Promise<Response | null> {
  if (!env.IMAGES || !env.MEDIA_BUCKET) return null;

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) return null;
  if (object.size > MAX_TRANSFORM_BYTES) return null;

  const contentType = object.httpMetadata?.contentType?.split(';')[0].trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) return null;

  try {
    const result = await env.IMAGES
      .input(object.body)
      .transform({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, fit: 'cover' })
      .output({ format: 'image/webp' });

    const transformed = result.response();
    const headers = new Headers(transformed.headers);
    headers.set('Cache-Control', 'public, max-age=31536000');
    // Weak validator: derived from the source object, scoped to these params.
    headers.set('ETag', `W/"${object.etag}-${PREVIEW_SIZE}"`);
    applyMediaResponseHeaders(headers, key);
    return new Response(transformed.body, { headers });
  } catch {
    // The object body is spent at this point; the fallback re-reads from R2.
    return null;
  }
}
