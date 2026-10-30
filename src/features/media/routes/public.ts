import { Hono } from 'hono';
import { applyMediaResponseHeaders, mediaObjectResponse } from '../security';
import { recordRead } from '../../../core/http/access-log';
import { mediaDisposition } from '../regulated';
import type { Env, Variables } from '../../../types';

/**
 * Announces a delivery of one object. Recorded before the edge-cache check, so
 * a cached hit is still accounted for.
 *
 * These routes are public and unauthenticated, so a recorded row carries the
 * source IP and the key but no actor. That is a limit of the surface: a
 * regulated object is not served here at all (see withhold below), so what this
 * records is the delivery of unregulated content. Regulated objects are served
 * only by the authenticated route in routes/files.ts.
 */
function announceMediaRead(key: string): void {
  recordRead({
    action: 'media.read',
    kind: 'media_prefix',
    key,
    targetType: 'media',
    ids: [key],
    count: 1,
  });
}

export const mediaPublicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Square thumbnail edge, in pixels, for the admin media pickers. */
const PREVIEW_SIZE = 100;

async function isPublicMedia(env: Env, key: string): Promise<boolean> {
  if (!await env.DB.prepare('SELECT 1 FROM media_files WHERE key = ?').bind(key).first()) return false;
  const object = await env.MEDIA_BUCKET?.head(key);
  return !!object && object.customMetadata?.cmsPrivate !== '1';
}

/**
 * Refuses a regulated object before the route does anything else — before the
 * existence check, so a withheld key is indistinguishable from a missing one
 * (confirming that an object exists under a classified prefix is itself a
 * disclosure), and before the edge-cache read, so classifying a prefix stops
 * deliveries this Worker has already cached.
 *
 * `unknown` answers 503, not 404: it means the classification could not be
 * read, and saying "not found" to that would be the silent fail-open the whole
 * control exists to avoid. Downstream caches are a separate matter — a
 * `max-age=31536000` response already handed out is beyond this Worker's reach
 * and has to be purged.
 */
async function withhold(c: { env: Env }, key: string): Promise<Response | null> {
  switch (await mediaDisposition(c.env, key)) {
    case 'withheld':
      return new Response('Not Found', { status: 404 });
    case 'unknown':
      return new Response('Media classification unavailable', {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    default:
      return null;
  }
}
/** Images binding input ceiling; larger objects are served untransformed. */
const MAX_TRANSFORM_BYTES = 20 * 1024 * 1024;

mediaPublicRoutes.get('/media-preview/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media-preview\//, '');
  const refusal = await withhold(c, key);
  if (refusal) return refusal;
  if (!await isPublicMedia(c.env, key)) return c.notFound();
  announceMediaRead(key);

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
  const refusal = await withhold(c, key);
  if (refusal) return refusal;
  if (!await isPublicMedia(c.env, key)) return c.notFound();
  announceMediaRead(key);
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
