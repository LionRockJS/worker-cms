import { putPublicMedia } from './media-fixtures';
// Security tests for media upload validation and /media/* serving headers.

import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { MAX_UPLOAD_BYTES } from '../src/features/media/security';
import type { JWTPayload } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

async function authCookie(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}

async function upload(file: File): Promise<Response> {
  const body = new FormData();
  body.append('dir', 'uploads');
  body.append('file', file);
  return worker.fetch(new Request('http://localhost/admin/upload', {
    method: 'POST',
    body,
    headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'same-origin' },
  }));
}

describe('upload validation', () => {
  it('accepts a valid PNG and stores the canonical content type', async () => {
    const response = await upload(new File([PNG_BYTES], 'photo.png', { type: 'image/png' }));
    const payload = await response.json<{ success: boolean; files: string[]; errors: unknown[] }>();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.errors).toEqual([]);

    const key = payload.files[0].replace(/^\/media\//, '');
    const object = await env.MEDIA_BUCKET.get(key);
    expect(object?.httpMetadata?.contentType).toBe('image/png');
  });

  it('rejects html uploads', async () => {
    const response = await upload(new File(['<script>alert(1)</script>'], 'evil.html', { type: 'text/html' }));
    const payload = await response.json<{ success: boolean; errors: Array<{ error: string }> }>();

    expect(response.status).toBe(415);
    expect(payload.success).toBe(false);
    expect(payload.errors[0].error).toBe('file_type_not_allowed');
  });

  it('rejects svg uploads', async () => {
    const response = await upload(new File(['<svg onload="alert(1)"/>'], 'evil.svg', { type: 'image/svg+xml' }));

    expect(response.status).toBe(415);
  });

  it('rejects a png extension whose content is not a png', async () => {
    const response = await upload(new File(['<html>not a png</html>'], 'fake.png', { type: 'image/png' }));
    const payload = await response.json<{ success: boolean; errors: Array<{ error: string }> }>();

    expect(response.status).toBe(415);
    expect(payload.errors[0].error).toBe('file_content_mismatch');
  });

  it('rejects a declared MIME that does not match the extension', async () => {
    const response = await upload(new File([PNG_BYTES], 'photo.png', { type: 'text/html' }));
    const payload = await response.json<{ success: boolean; errors: Array<{ error: string }> }>();

    expect(response.status).toBe(415);
    expect(payload.errors[0].error).toBe('content_type_mismatch');
  });

  it('rejects oversize files', async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PNG_BYTES);
    const response = await upload(new File([big], 'huge.png', { type: 'image/png' }));
    const payload = await response.json<{ success: boolean; errors: Array<{ error: string }> }>();

    expect(response.status).toBe(413);
    expect(payload.errors[0].error).toBe('file_too_large');
  });
});

describe('media serving headers', () => {
  it('serves every media object with a sandboxing CSP', async () => {
    await putPublicMedia('test/safe.png', PNG_BYTES, {
      httpMetadata: { contentType: 'image/png' },
    });

    const response = await worker.fetch(new Request('http://localhost/media/test/safe.png'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it('forces download for objects that are not inline-safe media', async () => {
    // Simulate a legacy object uploaded before validation existed.
    await putPublicMedia('test/legacy.svg', '<svg onload="alert(1)"/>', {
      httpMetadata: { contentType: 'image/svg+xml' },
    });
    await putPublicMedia('test/legacy.html', '<script>alert(1)</script>', {
      httpMetadata: { contentType: 'text/html' },
    });

    const svg = await worker.fetch(new Request('http://localhost/media/test/legacy.svg'));
    const html = await worker.fetch(new Request('http://localhost/media/test/legacy.html'));

    expect(svg.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(svg.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(html.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(html.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
  });
});
