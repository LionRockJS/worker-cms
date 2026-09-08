import { createMiddleware } from 'hono/factory';
import type { Env, Variables } from '../../types';

export class BodyTooLargeError extends Error {}

/** Count actual bytes, including requests without Content-Length. */
export function limitedStream(body: ReadableStream<Uint8Array>, maxBytes: number, onExceeded?: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        size += value.byteLength;
        if (size > maxBytes) {
          onExceeded?.();
          await reader.cancel('body limit exceeded');
          controller.error(new BodyTooLargeError('Body limit exceeded'));
          return;
        }
        controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export async function limitedBytes(response: Response, maxBytes = 8 * 1024 * 1024): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  return new Response(limitedStream(response.body, maxBytes)).arrayBuffer();
}

export const limitRequestBody = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  if (!c.req.raw.body) return next();
  const path = c.req.path;
  const max = path === '/admin/upload' ? 32 * 1024 * 1024
    : path === '/__cms/files' ? 16 * 1024 * 1024
    : path.startsWith('/__cms/state/') ? 72 * 1024
    : path === '/__cms/tenant/claim' ? 4096
    : path.startsWith('/auth/') ? 64 * 1024
    : 5 * 1024 * 1024;
  const length = c.req.header('content-length');
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > max)) {
    return c.json({ error: 'body_too_large', max_bytes: max }, 413);
  }
  let exceeded = false;
  c.req.raw = new Request(c.req.raw, { body: limitedStream(c.req.raw.body, max, () => { exceeded = true; }) });
  await next();
  if (exceeded) c.res = c.json({ error: 'body_too_large', max_bytes: max }, 413);
});
