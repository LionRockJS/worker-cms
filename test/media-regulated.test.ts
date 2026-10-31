// Regulated media is never served from a public URL.
//
// Classifying a media prefix used to make its deliveries audited and nothing
// more: the object stayed fetchable by anyone holding the URL, cached for a
// year. So these tests check prevention, not recording — and check the
// authorized path still works, because a control that makes regulated files
// unreachable for everyone gets switched off.

import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { putPublicMedia } from './media-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/** Keys this file owns, all under prefixes it classifies. */
const OPEN_KEY = 'upload/open/photo.png';
const CHART_KEY = 'records/charts/scan.png';
const CONTACT_KEY = 'contacts/headshot.png';

async function cookieFor(role: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: role === 'admin' ? '1' : '2',
    email: `${role}@example.com`,
    name: `${role} user`,
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}

let ipCounter = 0;

async function fetchPath(path: string, init: RequestInit = {}, role?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (role) headers.set('Cookie', await cookieFor(role));
  if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new IncomingRequest(new URL(path, 'http://localhost'), {
    redirect: 'manual',
    ...init,
    headers,
  }));
}

async function classify(key: string, dataClass: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO data_classes (container_kind, container_key, class) VALUES ('media_prefix', ?, ?)",
  ).bind(key, dataClass).run();
}

/** Runs `body` with `data_classes` unreadable. */
async function withoutClassificationTable(body: () => Promise<void>): Promise<void> {
  await env.DB.prepare('ALTER TABLE data_classes RENAME TO data_classes_away').run();
  try {
    await body();
  } finally {
    await env.DB.prepare('ALTER TABLE data_classes_away RENAME TO data_classes').run();
  }
}

async function uploadTo(directory: string, role = 'admin'): Promise<Response> {
  const body = new FormData();
  body.append('dir', directory);
  body.append('file', new File([PNG_BYTES], 'scan.png', { type: 'image/png' }));
  return fetchPath('/admin/upload', { method: 'POST', body }, role);
}

async function cleanup(): Promise<void> {
  for (const key of [OPEN_KEY, CHART_KEY, CONTACT_KEY]) {
    await env.MEDIA_BUCKET.delete(key);
  }
  const listed = await env.MEDIA_BUCKET.list({ prefix: 'records/' });
  for (const object of listed.objects) await env.MEDIA_BUCKET.delete(object.key);
  await env.DB.prepare("DELETE FROM media_files WHERE key LIKE 'upload/%' OR key LIKE 'records/%' OR key LIKE 'contacts/%'").run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM audit_events').run();
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await cleanup();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin'),
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(2, 'eventuai:editor', 'editor@example.com', 'Editor User', '', 'editor'),
  ]);
  await putPublicMedia(OPEN_KEY, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });
  await putPublicMedia(CHART_KEY, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });
  await putPublicMedia(CONTACT_KEY, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });
});

afterEach(cleanup);

describe('the public media routes', () => {
  it('serves an unclassified object, as they always did', async () => {
    const response = await fetchPath(`/media/${OPEN_KEY}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000');
  });

  it('withholds an object under a phi prefix', async () => {
    await classify('records/', 'phi');
    expect((await fetchPath(`/media/${CHART_KEY}`)).status).toBe(404);
  });

  it('withholds its thumbnail too', async () => {
    // The preview route transforms and then caches for a year, so leaving it
    // open would publish a legible copy of the same object.
    await classify('records/', 'phi');
    expect((await fetchPath(`/media-preview/${CHART_KEY}`)).status).toBe(404);
  });

  it('still serves a pii prefix — only phi is withheld', async () => {
    // Withholding pii would take every public photograph of a person with it.
    await classify('contacts/', 'pii');
    expect((await fetchPath(`/media/${CONTACT_KEY}`)).status).toBe(200);
  });

  it('applies the most specific prefix, not the first', async () => {
    await classify('records/', 'phi');
    await classify('upload/', 'pii');
    expect((await fetchPath(`/media/${CHART_KEY}`)).status).toBe(404);
    expect((await fetchPath(`/media/${OPEN_KEY}`)).status).toBe(200);
  });

  it('cannot be told apart from a missing object', async () => {
    // Confirming that something exists under a classified prefix is itself a
    // disclosure, so the refusal has to run before the existence check.
    await classify('records/', 'phi');
    const withheld = await fetchPath(`/media/${CHART_KEY}`);
    const absent = await fetchPath('/media/records/charts/no-such-file.png');
    expect(withheld.status).toBe(absent.status);
    expect(await withheld.text()).toBe(await absent.text());
  });

  it('answers 503, not 404, when the classification cannot be read', async () => {
    // 404 here would be the silent fail-open the control exists to prevent: it
    // reads as "no such file" while the reason is "we cannot tell".
    await withoutClassificationTable(async () => {
      const response = await fetchPath(`/media/${OPEN_KEY}`);
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect((await fetchPath(`/media-preview/${OPEN_KEY}`)).status).toBe(503);
    });
  });

  it('retains public-media denial when a classification row is removed', async () => {
    await classify('records/', 'phi');
    expect((await fetchPath(`/media/${CHART_KEY}`)).status).toBe(404);

    await env.DB.prepare('DELETE FROM data_classes').run();
    expect((await fetchPath(`/media/${CHART_KEY}`)).status).toBe(404);
  });
});

describe('the authenticated route for withheld objects', () => {
  it('serves the object to media:regulated, uncached', async () => {
    await classify('records/', 'phi');

    const response = await fetchPath(`/admin/media/${CHART_KEY}`, {}, 'admin');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('ETag')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('refuses an editor, who may upload media but not read regulated media', async () => {
    await classify('records/', 'phi');
    expect((await fetchPath(`/admin/media/${CHART_KEY}`, {}, 'editor')).status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    await classify('records/', 'phi');
    const response = await fetchPath(`/admin/media/${CHART_KEY}`);
    expect(response.status).not.toBe(200);
  });

  it('records the delivery against the classified prefix, with an actor', async () => {
    await classify('records/', 'phi');
    expect((await fetchPath(`/admin/media/${CHART_KEY}`, {}, 'admin')).status).toBe(200);

    await expect.poll(async () => env.DB.prepare(
      `SELECT data_class, retention_class, actor_user_id, container_key, target_id
         FROM audit_events WHERE action = 'media.read' LIMIT 1`,
    ).first(), { timeout: 2000 }).toMatchObject({
      data_class: 'phi',
      retention_class: 'phi_access',
      actor_user_id: '1',
      container_key: CHART_KEY,
      target_id: CHART_KEY,
    });
  });

  it('404s a key the CMS does not know about', async () => {
    expect((await fetchPath('/admin/media/records/charts/ghost.png', {}, 'admin')).status).toBe(404);
  });
});

describe('uploading into a classified prefix', () => {
  it('marks the object private as it lands, so the marker outlives the table', async () => {
    await classify('records/', 'phi');

    const response = await uploadTo('records');
    const payload = await response.json<{ success: boolean; files: string[] }>();
    expect(payload.success).toBe(true);

    const key = payload.files[0].replace(/^\/media\//, '');
    expect((await env.MEDIA_BUCKET.head(key))?.customMetadata?.cmsPrivate).toBe('1');

    // Withheld by classification now, and by the marker even if it is dropped.
    expect((await fetchPath(`/media/${key}`)).status).toBe(404);
    await env.DB.prepare('DELETE FROM data_classes').run();
    expect((await fetchPath(`/media/${key}`)).status).toBe(404);
  });

  it('leaves an unclassified upload public, as before', async () => {
    const payload = await (await uploadTo('upload')).json<{ files: string[] }>();
    const key = payload.files[0].replace(/^\/media\//, '');
    expect((await env.MEDIA_BUCKET.head(key))?.customMetadata?.cmsPrivate).toBeUndefined();
    expect((await fetchPath(`/media/${key}`)).status).toBe(200);
  });

  it('refuses the upload when classification cannot be read', async () => {
    // Mis-marking is durable where a refusal costs a retry, so this does not
    // guess in either direction.
    await withoutClassificationTable(async () => {
      const response = await uploadTo('records');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'classification_unavailable' });
    });
  });
});

describe('the Files browser', () => {
  it('links a withheld object to the authenticated route', async () => {
    // Otherwise every regulated row in the browser looks like a broken file.
    await classify('records/', 'phi');

    const response = await fetchPath('/admin/settings/content', {}, 'admin');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('/admin/media/records/charts/scan.png');
    expect(body).toContain('/media/upload/open/photo.png');
  });
});
