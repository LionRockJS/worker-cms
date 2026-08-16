import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from '../src/features/plugins/registry';
import { clearConfigCache } from '../src/core/db/content-config';
import { restoreTrashedPages } from '../src/core/db/admin-queries';
import { approvePageTypeAccess } from '../src/features/plugins/page-types';

// Plugin API — plugin write-back API (/__cms/*). Exercises the real Worker so the
// global middleware (canonical host, cross-origin exemption, auth) is in play.

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'events';
const PLUGIN_SECRET = 'test-plugin-secret-value';

// Manifest the Plugin API scope derives from: this plugin owns the event RSVP types.
const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Events Suite',
  version: '1.0.0',
  hooks: ['delete', 'submission'],
  contentTypes: {
    blueprint: {
      event: ['@start', '@end', 'name:text/title', 'location'],
      guest: ['@email:email', '@status', '@rsvp_code', 'name', 'last_name'],
      mail_list: ['*event'],
    },
    // May read `contact` pages (owned elsewhere) but not create/update them.
    readTypes: ['contact'],
  },
};

let savedSecret: unknown;

async function registerPlugin(manifest: Record<string, unknown> = MANIFEST): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Events', url, PLUGIN_SECRET).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(href).pathname;
      if (path === '/__plugin/manifest') return Response.json(manifest);
      if (path.startsWith('/__plugin/hooks/')) return new Response('ok');
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

/** Issues a Plugin API request through the real Worker with plugin auth headers. */
function cmsApi(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-plugin-secret': PLUGIN_SECRET,
      'x-plugin-id': PLUGIN_ID,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
  await env.DB.prepare("DELETE FROM pages WHERE page_type IN ('event','guest','mail_list','contact','article')").run();
  await env.DB.prepare("DELETE FROM trash_pages WHERE page_type IN ('event','guest','mail_list','contact','article')").run();
  await env.DB.prepare("DELETE FROM pages WHERE uuid = 'facade02-0001-4001-8001-000000000001'").run();
  await env.DB.prepare("DELETE FROM settings WHERE key = 'submissions.ingest.cursor'").run();
  await env.PUBLISHED_DB.prepare("DELETE FROM pages WHERE uuid = 'facade02-0001-4001-8001-000000000001'").run();
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  await registerPlugin();
});

afterEach(() => {
  if (savedSecret === undefined) delete testEnv.PLUGIN_SECRET;
  else testEnv.PLUGIN_SECRET = savedSecret;
});

describe('Plugin API auth + scoping', () => {
  it('does not accept the legacy environment secret for a plugin without its own secret', async () => {
    await env.DB.prepare('UPDATE plugins SET secret = NULL').run();
    clearManifestCache();

    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'plugin_api_unavailable' });
  });

  it('rejects a wrong shared secret', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest' }, { 'x-plugin-secret': 'wrong' });
    expect(res.status).toBe(403);
  });

  it('rejects a missing plugin id', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest' }, { 'x-plugin-id': '' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown plugin id', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest' }, { 'x-plugin-id': 'nope' });
    expect(res.status).toBe(403);
  });

  it('invalidates the old credential immediately after plugin-secret rotation', async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS total FROM pages WHERE page_type = 'guest'")
      .first<{ total: number }>();
    await env.DB.prepare('UPDATE plugins SET secret = ?').bind('rotated-plugin-secret').run();
    clearManifestCache();

    const oldSecret = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Must not exist' });
    expect(oldSecret.status).toBe(403);
    expect(oldSecret.headers.get('Cache-Control')).toBe('no-store');
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM pages WHERE page_type = 'guest'")
      .first<{ total: number }>()).toEqual(before);

    const rotatedSecret = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Allowed after rotation' }, {
      'x-plugin-secret': 'rotated-plugin-secret',
    });
    expect(rotatedSecret.status).toBe(201);
  });

  it.each([
    ['disabled', 'UPDATE plugins SET enabled = 0'],
    ['deleted', 'DELETE FROM plugins'],
  ])('denies a %s plugin before it can write', async (_state, mutation) => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS total FROM pages WHERE page_type = 'guest'")
      .first<{ total: number }>();
    await env.DB.prepare(mutation).run();
    clearManifestCache();

    const response = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Must not exist' });
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await env.DB.prepare("SELECT COUNT(*) AS total FROM pages WHERE page_type = 'guest'")
      .first<{ total: number }>()).toEqual(before);
  });

  it('rejects writes to a page type the plugin does not own', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'contact', name: 'X' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; page_type: string; message: string };
    expect(body.error).toBe('forbidden_page_type');
    // The refused type and the approval hint ride along so plugin error panels
    // can point admins at Plugins → (plugin) → Page types instead of
    // suggesting a CMS_URL/PLUGIN_SECRET problem.
    expect(body.page_type).toBe('contact');
    expect(body.message).toContain('Page types');
  });

  it('requires admin approval before honoring delegated writeTypes', async () => {
    await env.DB.prepare('DELETE FROM plugins').run();
    await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
    __clearInjectedFetchers();
    clearManifestCache();
    const url = `https://plugin-${crypto.randomUUID()}.local`;
    const manifest = {
      id: PLUGIN_ID,
      name: 'Check-in Companion',
      version: '1.0.0',
      contentTypes: {
        blueprint: {
          event: ['@start', '@end', 'name:text/title', 'location'],
        },
        writeTypes: ['guest'],
        readTypes: ['mail_list'],
      },
    };
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Check-in', url, PLUGIN_SECRET).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const blocked = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Blocked Guest' });
    expect(blocked.status).toBe(403);

    await approvePageTypeAccess(env.DB, PLUGIN_ID, 'guest', 'write', 'admin@example.com');

    const createRes = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Delegated Guest' });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json() as { page: { id: number; page_type: string } }).page;
    expect(created.page_type).toBe('guest');

    const readRes = await cmsApi('GET', `/__cms/pages/${created.id}`);
    expect(readRes.status).toBe(200);
  });

  it('allows a declared and approved writeTypes wildcard to write any concrete page type', async () => {
    await env.DB.prepare('DELETE FROM plugins').run();
    await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
    __clearInjectedFetchers();
    clearManifestCache();
    const url = `https://plugin-${crypto.randomUUID()}.local`;
    const manifest = {
      id: PLUGIN_ID,
      name: 'Universal Importer',
      version: '1.0.0',
      contentTypes: {
        blueprint: {
          event: ['@start', '@end', 'name:text/title', 'location'],
        },
        writeTypes: ['*'],
      },
    };
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Importer', url, PLUGIN_SECRET).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const blocked = await cmsApi('POST', '/__cms/pages', { page_type: 'contact', name: 'Blocked Contact' });
    expect(blocked.status).toBe(403);

    await approvePageTypeAccess(env.DB, PLUGIN_ID, '*', 'write', 'admin@example.com');

    const createRes = await cmsApi('POST', '/__cms/pages', { page_type: 'contact', name: 'Delegated Contact' });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json() as { page: { id: number; page_type: string } }).page;
    expect(created.page_type).toBe('contact');

    const updateRes = await cmsApi('PUT', `/__cms/pages/${created.id}`, { name: 'Updated Contact' });
    expect(updateRes.status).toBe(200);
  });

  it('allows a declared and approved readTypes wildcard to read any concrete page type', async () => {
    await env.DB.prepare('DELETE FROM plugins').run();
    await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
    __clearInjectedFetchers();
    clearManifestCache();
    const url = `https://plugin-${crypto.randomUUID()}.local`;
    const manifest = {
      id: PLUGIN_ID,
      name: 'Universal Reader',
      version: '1.0.0',
      contentTypes: {
        blueprint: {
          event: ['@start', '@end', 'name:text/title', 'location'],
        },
        readTypes: ['*'],
      },
    };
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Reader', url, PLUGIN_SECRET).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);
    await env.DB.prepare(
      "INSERT INTO pages (name, slug, page_type, lect) VALUES (?, ?, 'article', ?)",
    ).bind('Launch Notes', 'launch-notes', JSON.stringify({ title: { en: 'Launch Notes' } })).run();
    const article = await env.DB.prepare("SELECT id FROM pages WHERE page_type = 'article' LIMIT 1")
      .first<{ id: number }>();

    expect((await cmsApi('GET', '/__cms/pages?page_type=article')).status).toBe(403);

    await approvePageTypeAccess(env.DB, PLUGIN_ID, '*', 'read', 'admin@example.com');

    const listRes = await cmsApi('GET', '/__cms/pages?page_type=article');
    expect(listRes.status).toBe(200);
    expect((await listRes.json() as { total: number }).total).toBe(1);

    const readRes = await cmsApi('GET', `/__cms/pages/${article!.id}`);
    expect(readRes.status).toBe(200);

    const writeRes = await cmsApi('POST', '/__cms/pages', { page_type: 'article', name: 'Not allowed' });
    expect(writeRes.status).toBe(403);
  });

  it('is not blocked by the cross-origin mutation guard (no Origin header)', async () => {
    // A 201 here proves the /__cms exemption works — a browser-style guard would 403.
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'NoOrigin' });
    expect(res.status).toBe(201);
  });

  it('lets a submission-hook plugin trigger generic live-only ingest', async () => {
    const uuid = 'facade02-0001-4001-8001-000000000001';
    await env.PUBLISHED_DB.prepare(
      `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect)
       VALUES (?, ?, ?, ?, 5, ?, ?)`,
    ).bind(-720001, uuid, 'Survey answer', 'survey-answer', 'survey_answer', '{"answer":"yes"}').run();

    const res = await cmsApi('POST', '/__cms/ingest/submissions');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: 1 });
    const mirrored = await env.DB.prepare('SELECT id, page_type FROM pages WHERE uuid = ?')
      .bind(uuid).first<{ id: number; page_type: string }>();
    expect(mirrored?.page_type).toBe('survey_answer');
    expect(await env.DB.prepare(
      "SELECT action FROM page_versions WHERE page_id = ? AND action = 'ingest-submission'",
    ).bind(mirrored!.id).first()).toEqual({ action: 'ingest-submission' });
  });

  it('requires the plugin manifest to subscribe to submission ingest', async () => {
    await env.DB.prepare('DELETE FROM plugins').run();
    __clearInjectedFetchers();
    clearManifestCache();
    await registerPlugin({ ...MANIFEST, hooks: ['delete'] });

    const res = await cmsApi('POST', '/__cms/ingest/submissions');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'submission_hook_required' });
  });

  it('authenticates against the plugin\'s own secret, not the env fallback', async () => {
    // Re-register the events plugin with a dedicated row secret.
    await env.DB.prepare('DELETE FROM plugins').run();
    __clearInjectedFetchers();
    clearManifestCache();
    const url = `https://plugin-${crypto.randomUUID()}.local`;
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
      .bind('Events', url, 'per-plugin-secret').run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(MANIFEST);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    // The plugin's own secret is accepted...
    const ok = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'OwnSecret' }, { 'x-plugin-secret': 'per-plugin-secret' });
    expect(ok.status).toBe(201);

    // ...and the shared env PLUGIN_SECRET no longer is — the per-plugin secret wins.
    const rejected = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'EnvSecret' }, { 'x-plugin-secret': PLUGIN_SECRET });
    expect(rejected.status).toBe(403);
  });
});

describe('Plugin API create / read / list / update / delete', () => {
  it('creates a guest page, versioned, and reads it back', async () => {
    const createRes = await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Ada Lovelace',
      lect: { name: { en: 'Ada Lovelace' }, '@status': 'confirmed', '@rsvp_code': 'EAI-1' },
      tags: [],
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json() as { page: { id: number; slug: string; page_type: string } }).page;
    expect(created.page_type).toBe('guest');
    expect(created.slug).toBe('ada-lovelace');

    // A create version was minted as the page's newest snapshot.
    const version = await env.DB.prepare(
      'SELECT action FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).bind(created.id).first<{ action: string }>();
    expect(version?.action).toBe('create');

    const readRes = await cmsApi('GET', `/__cms/pages/${created.id}`);
    expect(readRes.status).toBe(200);
    const read = (await readRes.json() as { page: { lect: Record<string, unknown> } }).page;
    expect((read.lect.name as { en: string }).en).toBe('Ada Lovelace');
    expect(read.lect['@status']).toBe('confirmed');
  });

  it('creates and deduplicates pages whose generated slug exceeds D1\'s LIKE pattern limit', async () => {
    const name = 'Your Hong Kong Wine Arrival from Berry Bros. & Rudd – [shipment_aid]';
    const baseSlug = 'your-hong-kong-wine-arrival-from-berry-bros-rudd-shipment-aid';

    const firstRes = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name });
    expect(firstRes.status).toBe(201);
    expect((await firstRes.json() as { page: { slug: string } }).page.slug).toBe(baseSlug);

    const secondRes = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name });
    expect(secondRes.status).toBe(201);
    expect((await secondRes.json() as { page: { slug: string } }).page.slug).toBe(`${baseSlug}-2`);
  });

  it('returns a JSON conflict when an imported explicit id is already used', async () => {
    const legacyId = 710001;
    const firstRes = await cmsApi('POST', '/__cms/pages', {
      id: legacyId,
      page_type: 'guest',
      name: 'Imported Guest',
    });
    expect(firstRes.status).toBe(201);
    const first = (await firstRes.json() as { page: { id: number } }).page;
    expect(first.id).toBe(legacyId);

    const secondRes = await cmsApi('POST', '/__cms/pages', {
      id: legacyId,
      page_type: 'guest',
      name: 'Imported Guest Copy',
    });
    expect(secondRes.status).toBe(409);
    expect(await secondRes.json()).toMatchObject({ error: 'id_conflict' });
  });

  it('returns a JSON error when a create references a missing parent page', async () => {
    const res = await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Orphan Guest',
      page_id: 999999,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'parent_not_found' });
  });

  it('lists pages of an owned type with a search filter', async () => {
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Grace Hopper' });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Alan Turing' });

    const allRes = await cmsApi('GET', '/__cms/pages?page_type=guest');
    const all = await allRes.json() as { total: number; pages: unknown[] };
    expect(all.total).toBe(2);

    const filtered = await (await cmsApi('GET', '/__cms/pages?page_type=guest&q=Grace')).json() as { total: number };
    expect(filtered.total).toBe(1);
  });

  it('optionally annotates a full page list with live publish status', async () => {
    const created = await (await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'Live event' })).json() as {
      page: { id: number; uuid: string; name: string; slug: string; weight: number; page_type: string; lect: Record<string, unknown> };
    };
    try {
      await env.PUBLISHED_DB.prepare(
        'INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        created.page.id,
        created.page.uuid,
        created.page.name,
        created.page.slug,
        created.page.weight,
        created.page.page_type,
        JSON.stringify(created.page.lect),
      ).run();

      const res = await cmsApi('GET', '/__cms/pages?page_type=event&q=Live%20event&include_live_status=1');
      expect(res.status).toBe(200);
      const body = await res.json() as { pages: Array<{ name: string; isPublished?: boolean }> };
      expect(body.pages.find((page) => page.name === 'Live event')?.isPublished).toBe(true);

      const single = await cmsApi('GET', `/__cms/pages/${created.page.id}?include_live_status=1`);
      expect(single.status).toBe(200);
      expect((await single.json() as { page: { isPublished?: boolean } }).page.isPublished).toBe(true);
    } finally {
      await env.PUBLISHED_DB.prepare('DELETE FROM pages WHERE uuid = ?').bind(created.page.uuid).run();
    }
  });

  it('batch-publishes owned pages through the normal publish pipeline', async () => {
    const event = await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'event',
      name: 'Public launch',
      lect: { name: { en: 'Public launch' }, secret_draft_note: 'not in this blueprint' },
    })).json() as { page: { id: number; uuid: string } };
    const guest = await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Ada',
      lect: { email: 'ada@example.com' },
    })).json() as { page: { id: number; uuid: string } };

    try {
      const res = await cmsApi('POST', '/__cms/pages/publish', { ids: [event.page.id, guest.page.id] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        published: [event.page.id, guest.page.id],
        errors: [],
        count: 2,
      });

      const live = await env.PUBLISHED_DB.prepare(
        'SELECT id, page_type FROM pages WHERE uuid IN (?, ?) ORDER BY id',
      ).bind(event.page.uuid, guest.page.uuid).all<{ id: number; page_type: string }>();
      expect(live.results.map((page) => page.id).sort((a, b) => a - b))
        .toEqual([event.page.id, guest.page.id].sort((a, b) => a - b));
    } finally {
      await env.PUBLISHED_DB.prepare('DELETE FROM pages WHERE uuid IN (?, ?)')
        .bind(event.page.uuid, guest.page.uuid).run();
    }
  });

  it('keeps batch publish inside the caller\'s approved write scope', async () => {
    const contactId = 7_100_001;
    const contactUuid = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (?, ?, 'Private contact', 'private-contact', 'contact', '{}')",
    ).bind(contactId, contactUuid).run();

    try {
      const res = await cmsApi('POST', '/__cms/pages/publish', { ids: [contactId] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        published: [],
        errors: [{ index: 0, id: contactId, error: 'forbidden_page_type', page_type: 'contact' }],
        count: 0,
      });
      expect(await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?').bind(contactUuid).first()).toBeNull();
    } finally {
      await env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(contactId).run();
      await env.PUBLISHED_DB.prepare('DELETE FROM pages WHERE uuid = ?').bind(contactUuid).run();
    }
  });

  it('requires plugin authentication and bounds batch publish input', async () => {
    const rejected = await cmsApi('POST', '/__cms/pages/publish', { ids: [1] }, { 'x-plugin-secret': 'wrong' });
    expect(rejected.status).toBe(403);

    const invalid = await cmsApi('POST', '/__cms/pages/publish', { ids: [0, 12.5, 'nope'] });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({
      published: [],
      errors: [
        { index: 0, error: 'invalid_id' },
        { index: 1, error: 'invalid_id' },
        { index: 2, error: 'invalid_id' },
      ],
      count: 0,
    });

    const exactMax = await cmsApi('POST', '/__cms/pages/publish', {
      ids: Array.from({ length: 100 }, (_, index) => 8_000_000_000_000 + index),
    });
    expect(exactMax.status).toBe(200);
    expect((await exactMax.json() as { errors: unknown[] }).errors).toHaveLength(100);

    const tooLarge = await cmsApi('POST', '/__cms/pages/publish', {
      ids: Array.from({ length: 101 }, (_, index) => index + 1),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({ error: 'batch_too_large', max: 100 });
  });

  it('refuses to publish a mirrored public submission', async () => {
    const created = await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Mirrored response',
    })).json() as { page: { id: number; uuid: string } };
    await env.DB.prepare("UPDATE page_versions SET action = 'ingest-submission' WHERE page_id = ?")
      .bind(created.page.id).run();

    const res = await cmsApi('POST', '/__cms/pages/publish', { ids: [created.page.id] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      published: [],
      errors: [{ index: 0, id: created.page.id, error: 'submission_publish_refused' }],
      count: 0,
    });
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?').bind(created.page.uuid).first()).toBeNull();
  });

  it('uses Chinese variants and lect fields when plugins list pages with q', async () => {
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Su Sheng',
      lect: { name: { en: 'Su Sheng' }, zh_hans_name: '苏生', email: 'su@example.com' },
    });
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Chan Tai Man',
      lect: { name: { en: 'Chan Tai Man' }, zh_hant_name: '陳大文', email: 'chan@example.com' },
    });

    const traditional = await (await cmsApi('GET', '/__cms/pages?page_type=guest&q=%E8%98%87')).json() as { total: number; pages: Array<{ name: string }> };
    expect(traditional.total).toBe(1);
    expect(traditional.pages[0].name).toBe('Su Sheng');

    const simplified = await (await cmsApi('GET', '/__cms/pages?page_type=guest&q=%E8%8B%8F')).json() as { total: number; pages: Array<{ name: string }> };
    expect(simplified.total).toBe(1);
    expect(simplified.pages[0].name).toBe('Su Sheng');
  });

  it('filters search results by multiple pointer values', async () => {
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: '陳美玲', lect: { _pointers: { mail_list: '12' } } });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: '陳家豪', lect: { _pointers: { mail_list: '13' } } });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: '陳外部', lect: { _pointers: { mail_list: '99' } } });

    const res = await cmsApi('GET', '/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_values=12,13&q=%E9%99%B3');
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; pages: Array<{ name: string }> };

    expect(body.total).toBe(2);
    expect(body.pages.map((page) => page.name).sort()).toEqual(['陳家豪', '陳美玲']);
  });

  it('skips the COUNT(*) when count=0 (paginating callers fetch the total once)', async () => {
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Ada', lect: { _pointers: { mail_list: '12' } } });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Bob', lect: { _pointers: { mail_list: '12' } } });

    const counted = await (await cmsApi('GET', '/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=12')).json() as { total: number; pages: unknown[] };
    expect(counted.total).toBe(2);

    const uncounted = await (await cmsApi('GET', '/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=12&count=0&limit=1&offset=1')).json() as { total: number; pages: unknown[] };
    expect(uncounted.total).toBe(-1); // sentinel: not computed
    expect(uncounted.pages).toHaveLength(1); // rows still paged normally
  });

  it('lists several readable page types with independent limits and ordering', async () => {
    await env.DB.prepare(
      `INSERT INTO pages (uuid, page_type, name, slug, weight, lect, created_at, updated_at)
       VALUES (?, 'event', 'Heavy', 'heavy', 20, '{}', '2026-01-01', '2026-01-01'),
              (?, 'event', 'Light', 'light', 10, '{}', '2026-01-02', '2026-01-02'),
              (?, 'guest', 'Older', 'older', 0, '{}', '2026-01-01', '2026-01-01'),
              (?, 'guest', 'Newer', 'newer', 0, '{}', '2026-02-01', '2026-02-01')`,
    ).bind(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()).run();

    const response = await cmsApi('POST', '/__cms/pages/list-batch', {
      queries: [
        { key: 'event', page_type: 'event', limit: 2, sort: 'weight', order: 'asc' },
        { key: 'guest', page_type: 'guest', limit: 1, sort: 'created_at', order: 'desc' },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      pages_by_type: Record<string, { pages: Array<{ name: string }>; groups: unknown[] }>;
    };
    expect(body.pages_by_type.event.pages.map((page) => page.name)).toEqual(['Light', 'Heavy']);
    expect(body.pages_by_type.event.groups).toEqual([]);
    expect(body.pages_by_type.guest.pages.map((page) => page.name)).toEqual(['Newer']);
    expect(body.pages_by_type.guest.groups).toEqual([]);
  });

  it('groups a page resource by one tag taxonomy without extra API calls', async () => {
    const taxonomy = `resource-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare('INSERT INTO taxonomies (name, slug) VALUES (?, ?)')
      .bind('Service category', taxonomy).run();
    await env.DB.prepare(
      `INSERT INTO tags (name, slug, weight, taxonomy_slug, lect)
       VALUES ('Colour', ?, 20, ?, ?), ('Styling', ?, 10, ?, ?)`,
    ).bind(
      `${taxonomy}-colour`, taxonomy, JSON.stringify({ name: { en: 'Colour analysis' } }),
      `${taxonomy}-styling`, taxonomy, JSON.stringify({ name: { en: 'Styling' } }),
    ).run();
    const colour = await env.DB.prepare('SELECT id FROM tags WHERE slug = ?')
      .bind(`${taxonomy}-colour`).first<{ id: number }>();
    const styling = await env.DB.prepare('SELECT id FROM tags WHERE slug = ?')
      .bind(`${taxonomy}-styling`).first<{ id: number }>();

    const first = await env.DB.prepare(
      `INSERT INTO pages (uuid, page_type, name, slug, weight, lect)
       VALUES (?, 'event', 'Personal Colour', ?, 10, '{}') RETURNING id`,
    ).bind(crypto.randomUUID(), `${taxonomy}-personal-colour`).first<{ id: number }>();
    const second = await env.DB.prepare(
      `INSERT INTO pages (uuid, page_type, name, slug, weight, lect)
       VALUES (?, 'event', 'Wardrobe Styling', ?, 20, '{}') RETURNING id`,
    ).bind(crypto.randomUUID(), `${taxonomy}-wardrobe`).first<{ id: number }>();
    const untagged = await env.DB.prepare(
      `INSERT INTO pages (uuid, page_type, name, slug, weight, lect)
       VALUES (?, 'event', 'Other Service', ?, 30, '{}') RETURNING id`,
    ).bind(crypto.randomUUID(), `${taxonomy}-other`).first<{ id: number }>();
    if (!colour || !styling || !first || !second || !untagged) throw new Error('fixture insert failed');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO page_tags (page_id, tag_id, weight) VALUES (?, ?, 5)').bind(first.id, colour.id),
      env.DB.prepare('INSERT INTO page_tags (page_id, tag_id, weight) VALUES (?, ?, 10)').bind(first.id, styling.id),
      env.DB.prepare('INSERT INTO page_tags (page_id, tag_id, weight) VALUES (?, ?, 5)').bind(second.id, styling.id),
    ]);

    const response = await cmsApi('POST', '/__cms/pages/list-batch', {
      queries: [{
        key: 'event', page_type: 'event', limit: 10, sort: 'weight', order: 'asc',
        group_by: { tag_taxonomy: taxonomy, include_untagged: true },
      }],
    });
    expect(response.status).toBe(200);
    const collection = ((await response.json()) as {
      pages_by_type: Record<string, {
        pages: Array<{ name: string }>;
        groups: Array<{ tag: { name: string; lect: unknown } | null; pages: Array<{ name: string }> }>;
      }>;
    }).pages_by_type.event;
    expect(collection.pages.map((page) => page.name)).toEqual([
      'Personal Colour', 'Wardrobe Styling', 'Other Service',
    ]);
    expect(collection.groups.map((group) => group.tag?.name ?? null)).toEqual([
      'Styling', 'Colour', null,
    ]);
    expect(collection.groups.map((group) => group.pages.map((page) => page.name))).toEqual([
      ['Personal Colour', 'Wardrobe Styling'], ['Personal Colour'], ['Other Service'],
    ]);
    expect(collection.groups[1].tag?.lect).toEqual({ name: { en: 'Colour analysis' } });
  });

  it('rejects forbidden, malformed, duplicate, and oversized batched lists', async () => {
    const forbidden = await cmsApi('POST', '/__cms/pages/list-batch', {
      queries: [{ key: 'article', page_type: 'article', limit: 1, sort: 'weight', order: 'asc' }],
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: 'forbidden_page_type', page_type: 'article' });

    const malformed = await cmsApi('POST', '/__cms/pages/list-batch', {
      queries: [{ key: 'event', page_type: 'event', limit: 0, sort: 'weight', order: 'asc' }],
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_query' });

    const malformedGroup = await cmsApi('POST', '/__cms/pages/list-batch', {
      queries: [{
        key: 'event', page_type: 'event', limit: 1, sort: 'weight', order: 'asc',
        group_by: { tag_taxonomy: '../unsafe', include_untagged: true },
      }],
    });
    expect(malformedGroup.status).toBe(400);
    expect(await malformedGroup.json()).toEqual({ error: 'invalid_query' });

    const duplicate = await cmsApi('POST', '/__cms/pages/list-batch', {
      queries: [
        { key: 'event', page_type: 'event', limit: 1, sort: 'weight', order: 'asc' },
        { key: 'event', page_type: 'guest', limit: 1, sort: 'weight', order: 'asc' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'duplicate_key', key: 'event' });

    const oversized = await cmsApi('POST', '/__cms/pages/list-batch', {
      queries: [
        { key: 'event', page_type: 'event', limit: 300, sort: 'weight', order: 'asc' },
        { key: 'guest', page_type: 'guest', limit: 300, sort: 'weight', order: 'asc' },
      ],
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: 'batch_too_large', max: 500 });
  });

  it('projects only the requested columns when fields= is given', async () => {
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Ada', lect: { _pointers: { mail_list: '12' }, email: 'ada@example.com' } });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Bob', lect: { _pointers: { mail_list: '12' }, email: 'bob@example.com' } });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Eve', lect: { _pointers: { mail_list: '99' } } });

    const res = await cmsApi('GET', '/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=12&fields=id&limit=1&offset=1&count=0');
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; pages: Array<Record<string, unknown>> };
    expect(body.pages).toHaveLength(1); // criteria + limit/offset still apply
    expect(Object.keys(body.pages[0])).toEqual(['id']); // no lect, no other columns
    expect(typeof body.pages[0].id).toBe('number');

    const named = await (await cmsApi('GET', '/__cms/pages?page_type=guest&fields=id,name')).json() as { pages: Array<Record<string, unknown>> };
    expect(Object.keys(named.pages[0]).sort()).toEqual(['id', 'name']);

    const bad = await cmsApi('GET', '/__cms/pages?page_type=guest&fields=id,secret_column');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_fields' });
  });

  it('serves pointer filters from the expression index, not a full scan', async () => {
    // The route inlines the JSON path as a literal for exactly this reason —
    // a bound parameter in the indexed expression would force a table scan.
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM pages WHERE page_type = ? AND json_extract(lect, '$._pointers.mail_list') = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
    ).bind('guest', '12', 500, 0).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join('\n');
    expect(details).toContain('idx_pages_pointer_mail_list');
    expect(details).not.toContain('SCAN pages');
  });

  it('advanced-searches plugin pages by wildcard lect path criteria', async () => {
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Corporate Guest',
      lect: { affiliations: [{ company: 'Acme Labs' }] },
    });
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Community Guest',
      lect: { affiliations: [{ company: 'Open Guild' }] },
    });

    const res = await cmsApi('POST', '/__cms/pages/search', {
      page_type: 'guest',
      criteria: [{ term: 'Acme', path: 'affiliations[*].company' }],
      sort: 'name',
      order: 'ASC',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; pages: Array<{ name: string }>; page_types: string[] };
    expect(body.total).toBe(1);
    expect(body.page_types).toEqual(['guest']);
    expect(body.pages[0].name).toBe('Corporate Guest');
  });

  it('advanced-searches plugin pages by criteria that combine tags and lect paths', async () => {
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Tagged Confirmed',
      lect: { status: 'confirmed' },
      tags: [777],
    });
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Tagged Invited',
      lect: { status: 'invited' },
      tags: [777],
    });

    const res = await cmsApi('POST', '/__cms/pages/search', {
      page_type: 'guest',
      criteria: [{ term: 'confirmed', path: 'status', tags: ['777'] }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; pages: Array<{ name: string }> };
    expect(body.total).toBe(1);
    expect(body.pages[0].name).toBe('Tagged Confirmed');
  });

  it('rejects listing a type the plugin neither owns nor may read', async () => {
    const res = await cmsApi('GET', '/__cms/pages?page_type=article');
    expect(res.status).toBe(403);
  });

  it('rejects a delegated readType until an admin approves it', async () => {
    await env.DB.prepare(
      "INSERT INTO pages (name, slug, page_type, lect) VALUES (?, ?, 'contact', ?)",
    ).bind('Ada Lovelace', 'ada-lovelace', JSON.stringify({ first_name: { en: 'Ada' } })).run();

    const res = await cmsApi('GET', '/__cms/pages?page_type=contact');
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden_page_type');
  });

  it('filters a list by parent page id (guests of an event)', async () => {
    const event = (await (await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'Gala' })).json() as { page: { id: number } }).page;
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Guest A', page_id: event.id });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Guest B', page_id: event.id });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Orphan' }); // no parent

    const res = await cmsApi('GET', `/__cms/pages?page_type=guest&page_id=${event.id}`);
    const body = await res.json() as { total: number };
    expect(body.total).toBe(2);
  });

  it('allows reading a declared readType but not writing it', async () => {
    await approvePageTypeAccess(env.DB, PLUGIN_ID, 'contact', 'read', 'admin@example.com');
    // A contact page the events plugin does NOT own, inserted directly.
    await env.DB.prepare(
      "INSERT INTO pages (name, slug, page_type, lect) VALUES (?, ?, 'contact', ?)",
    ).bind('Ada Lovelace', 'ada-lovelace', JSON.stringify({ first_name: { en: 'Ada' } })).run();
    const contact = await env.DB.prepare("SELECT id FROM pages WHERE page_type = 'contact' LIMIT 1")
      .first<{ id: number }>();

    // Read is allowed (contact is a declared readType)…
    const readRes = await cmsApi('GET', `/__cms/pages/${contact!.id}`);
    expect(readRes.status).toBe(200);
    expect((await readRes.json() as { page: { name: string } }).page.name).toBe('Ada Lovelace');

    const listRes = await cmsApi('GET', '/__cms/pages?page_type=contact');
    expect(listRes.status).toBe(200);
    expect((await listRes.json() as { total: number }).total).toBe(1);

    // …but writes stay scoped to owned types.
    const createRes = await cmsApi('POST', '/__cms/pages', { page_type: 'contact', name: 'New' });
    expect(createRes.status).toBe(403);
    const updateRes = await cmsApi('PUT', `/__cms/pages/${contact!.id}`, { name: 'Hacked' });
    expect(updateRes.status).toBe(403);
  });

  it('scopes plugin advanced search to approved readable page types', async () => {
    await env.DB.prepare(
      "INSERT INTO pages (name, slug, page_type, lect) VALUES (?, ?, 'contact', ?)",
    ).bind('Ada Lovelace', 'ada-lovelace', JSON.stringify({ first_name: { en: 'Ada' } })).run();

    const blocked = await cmsApi('POST', '/__cms/pages/search', {
      page_type: 'contact',
      criteria: [{ term: 'Ada', path: 'first_name.en' }],
    });
    expect(blocked.status).toBe(403);

    await approvePageTypeAccess(env.DB, PLUGIN_ID, 'contact', 'read', 'admin@example.com');

    const allowed = await cmsApi('POST', '/__cms/pages/search', {
      page_types: ['contact'],
      criteria: [{ term: 'Ada', path: 'first_name.en' }],
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { total: number; pages: Array<{ name: string }> };
    expect(body.total).toBe(1);
    expect(body.pages[0].name).toBe('Ada Lovelace');
  });

  it('partial-updates a page and mints an update version', async () => {
    const created = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Edith', lect: { name: { en: 'Edith' }, '@status': 'invited' },
    })).json() as { page: { id: number } }).page;

    const updateRes = await cmsApi('PUT', `/__cms/pages/${created.id}`, {
      lect: { '@status': 'confirmed' },
      version_action: 'update from google sheet',
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json() as { page: { lect: Record<string, unknown> } }).page;
    // Changed field applied, untouched field preserved (partial merge).
    expect(updated.lect['@status']).toBe('confirmed');
    expect((updated.lect.name as { en: string }).en).toBe('Edith');

    // Both a create and an update version exist (order-independent: the time-based
    // version id has a random component, so same-second inserts aren't ordered).
    const versions = await env.DB.prepare('SELECT action FROM page_versions WHERE page_id = ?')
      .bind(created.id).all<{ action: string }>();
    expect(versions.results.map((v) => v.action).sort()).toEqual(['create', 'update from google sheet']);
  });

  it('compare-and-swaps a page lect and rejects a stale concurrent update', async () => {
    const created = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Concurrent guest', lect: { status: 'invited', version: 0 },
    })).json() as { page: { id: number; lect: Record<string, unknown> } }).page;

    const first = await cmsApi('PUT', `/__cms/pages/${created.id}`, {
      lect: { status: 'confirmed', version: 1 },
      if_lect: created.lect,
    });
    expect(first.status).toBe(200);

    const stale = await cmsApi('PUT', `/__cms/pages/${created.id}`, {
      lect: { status: 'declined', version: 1 },
      if_lect: created.lect,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'version_conflict' });

    const stored = await env.DB.prepare('SELECT lect FROM pages WHERE id = ?').bind(created.id).first<{ lect: string }>();
    expect(JSON.parse(stored?.lect ?? '{}')).toMatchObject({ status: 'confirmed', version: 1 });
  });

  /**
   * Forces `updated_at` into an earlier second than now.
   *
   * The `pages_updated_at` trigger fires `WHEN old.updated_at < CURRENT_TIMESTAMP`
   * and rewrites `updated_at` itself, so a backdate can be undone by the very
   * statement that applies it. When `old.updated_at` already equals the current
   * second the trigger stays quiet, so a second pass always sticks.
   */
  async function backdate(id: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await env.DB.prepare("UPDATE pages SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").bind(id).run();
      const row = await env.DB.prepare('SELECT updated_at FROM pages WHERE id = ?').bind(id).first<{ updated_at: string }>();
      if (row?.updated_at === '2020-01-01 00:00:00') return;
    }
    throw new Error('could not backdate updated_at');
  }

  // Regression: the update route asserted `meta.changes === 1`, but the row is
  // written more than once per statement — the trigger updates it again, and
  // production D1 also counts index writes. Every update to a page last touched
  // in an earlier second therefore 409'd *after* being written, which is every
  // real save; only a second update inside the same second looked healthy,
  // which is exactly what the tests above happened to do.
  it('accepts an update to a page whose updated_at is older than the current second', async () => {
    const created = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Backdated guest', lect: { status: 'invited' },
    })).json() as { page: { id: number } }).page;
    await backdate(created.id);

    const res = await cmsApi('PUT', `/__cms/pages/${created.id}`, { lect: { status: 'confirmed' } });
    expect(res.status).toBe(200);

    const stored = await env.DB.prepare('SELECT lect FROM pages WHERE id = ?').bind(created.id).first<{ lect: string }>();
    expect(JSON.parse(stored?.lect ?? '{}')).toMatchObject({ status: 'confirmed' });
  });

  it('still compare-and-swaps correctly when the trigger fires', async () => {
    const created = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Backdated CAS guest', lect: { status: 'invited' },
    })).json() as { page: { id: number; lect: Record<string, unknown> } }).page;
    await backdate(created.id);

    // A matching if_lect must still succeed on a triggered update...
    const fresh = await cmsApi('PUT', `/__cms/pages/${created.id}`, {
      lect: { status: 'confirmed' }, if_lect: created.lect,
    });
    expect(fresh.status).toBe(200);

    // ...and a stale one must still be refused, which is the whole point of
    // keeping a zero-row write a conflict.
    await backdate(created.id);
    const stale = await cmsApi('PUT', `/__cms/pages/${created.id}`, {
      lect: { status: 'declined' }, if_lect: created.lect,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'version_conflict' });
  });

  it('soft-deletes a page to trash', async () => {
    const created = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Temp Guest',
    })).json() as { page: { id: number; uuid: string } }).page;

    const delRes = await cmsApi('DELETE', `/__cms/pages/${created.id}`);
    expect(delRes.status).toBe(200);

    const draft = await env.DB.prepare('SELECT id FROM pages WHERE id = ?').bind(created.id).first();
    expect(draft).toBeNull();
    const trashed = await env.DB.prepare('SELECT id FROM trash_pages WHERE uuid = ?').bind(created.uuid).first();
    expect(trashed).not.toBeNull();
  });

  it('deletes a mail list while its event remains live', async () => {
    const event = (await (await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'Gala' })).json() as { page: { id: number } }).page;
    const list = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP', page_id: event.id,
    })).json() as { page: { id: number } }).page;

    const deleteRes = await cmsApi('DELETE', `/__cms/pages/${list.id}`);
    expect(deleteRes.status).toBe(200);

    const trashed = await env.DB.prepare('SELECT page_id, source_page_id FROM trash_pages WHERE id = ?')
      .bind(list.id)
      .first<{ page_id: number | null; source_page_id: number | null }>();
    expect(trashed).toEqual({ page_id: null, source_page_id: event.id });
    expect(await env.DB.prepare('SELECT id FROM pages WHERE id = ?').bind(event.id).first()).not.toBeNull();
  });
});

describe('Plugin API batch writes', () => {
  it('creates many pages and reports per-item errors', async () => {
    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: [
        { page_type: 'guest', name: 'G1' },
        { page_type: 'guest', name: 'G2' },
        { page_type: 'contact', name: 'Not allowed' }, // out of scope
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; errors: Array<{ index: number; error: string }> };
    expect(body.count).toBe(2);
    expect(body.errors).toEqual([{ index: 2, error: 'forbidden_page_type' }]);
  });

  it('batch-updates lect with distinct versions and reports invalid rows', async () => {
    const first = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'First', lect: { status: 'invited', marker: 'first' },
    })).json() as { page: { id: number } }).page;
    const second = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Second', lect: { status: 'invited', marker: 'second' },
    })).json() as { page: { id: number } }).page;

    const res = await cmsApi('PATCH', '/__cms/pages/batch', {
      pages: [
        { id: first.id, lect: { status: 'confirmed' }, version_action: 'archive-merge' },
        { id: second.id, lect: { status: 'declined' }, version_action: 'archive-merge' },
        { id: 999999999, lect: { status: 'missing' } },
        { id: first.id, lect: { status: 'duplicate' } },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      count: number;
      updated: Array<{ id: number; lect: Record<string, unknown> }>;
      errors: Array<{ index: number; error: string }>;
    };
    expect(body.count).toBe(2);
    expect(body.updated.map((page) => [page.id, page.lect.status, page.lect.marker])).toEqual([
      [first.id, 'confirmed', 'first'],
      [second.id, 'declined', 'second'],
    ]);
    expect(body.errors).toEqual([
      { index: 2, error: 'not_found' },
      { index: 3, error: 'duplicate_id' },
    ]);

    const rows = await env.DB.prepare(
      `SELECT p.id, p.lect AS page_lect, v.lect AS version_lect, v.action
       FROM pages p
       JOIN page_versions v ON v.id = (
         SELECT id FROM page_versions WHERE page_id = p.id ORDER BY created_at DESC, rowid DESC LIMIT 1
       )
       WHERE p.id IN (?, ?)
       ORDER BY p.id`,
    ).bind(first.id, second.id).all<{ id: number; page_lect: string; version_lect: string; action: string }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) expect(row.version_lect).toBe(row.page_lect);
    expect(rows.results.map((row) => row.action)).toEqual(['archive-merge', 'archive-merge']);
  });

  it('enforces write scope per batch-update item', async () => {
    const guest = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Writable Guest', lect: { status: 'invited' },
    })).json() as { page: { id: number } }).page;
    await env.DB.prepare(
      'INSERT INTO pages (name, slug, page_type, lect) VALUES (?, ?, ?, ?)',
    ).bind('Protected Contact', `protected-${crypto.randomUUID()}`, 'contact', '{}').run();
    const contact = await env.DB.prepare(
      'SELECT id FROM pages WHERE name = ? ORDER BY created_at DESC LIMIT 1',
    ).bind('Protected Contact').first<{ id: number }>();

    const res = await cmsApi('PATCH', '/__cms/pages/batch', {
      pages: [
        { id: guest.id, lect: { status: 'confirmed' } },
        { id: contact!.id, lect: { source: 'not-allowed' } },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; errors: Array<{ index: number; error: string }> };
    expect(body.count).toBe(1);
    expect(body.errors).toEqual([{ index: 1, error: 'forbidden_page_type' }]);
  });

  it('allocates unique slugs and versions within one batch', async () => {
    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: [
        { page_type: 'guest', name: 'Same Name', lect: { marker: 'first' } },
        { page_type: 'guest', name: 'Same Name', lect: { marker: 'last' } },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; created: Array<{ id: number; slug: string }> };
    expect(body.count).toBe(2);
    expect(body.created.map((page) => page.slug)).toEqual(['same-name', 'same-name-2']);

    const rows = await env.DB.prepare(
      'SELECT slug FROM pages WHERE id IN (?, ?) ORDER BY slug',
    ).bind(body.created[0].id, body.created[1].id).all<{ slug: string }>();
    expect(rows.results.map((row) => row.slug)).toEqual(['same-name', 'same-name-2']);

    const versions = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM page_versions WHERE page_id IN (?, ?)',
    ).bind(body.created[0].id, body.created[1].id).first<{ count: number }>();
    expect(versions?.count).toBe(2);

    const payloads = await env.DB.prepare(
      `SELECT p.lect AS page_lect, v.lect AS version_lect
       FROM pages p
       JOIN page_versions v ON v.id = (
         SELECT id FROM page_versions WHERE page_id = p.id ORDER BY created_at DESC, rowid DESC LIMIT 1
       )
       WHERE p.id IN (?, ?)
       ORDER BY p.slug`,
    ).bind(body.created[0].id, body.created[1].id).all<{ page_lect: string; version_lect: string }>();
    expect(payloads.results.map((row) => JSON.parse(row.page_lect).marker)).toEqual(['first', 'last']);
    expect(payloads.results.every((row) => row.page_lect === row.version_lect)).toBe(true);
  });

  it('reports explicit id conflicts as per-item JSON errors in batch imports', async () => {
    const legacyId = 710002;
    const existingRes = await cmsApi('POST', '/__cms/pages', {
      id: legacyId,
      page_type: 'guest',
      name: 'Existing Imported Guest',
    });
    expect(existingRes.status).toBe(201);

    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: [
        { page_type: 'guest', name: 'Valid Guest' },
        { id: legacyId, page_type: 'guest', name: 'Batch Guest A' },
        { id: legacyId, page_type: 'guest', name: 'Batch Guest B' },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; created: Array<{ id: number }>; errors: Array<{ index: number; error: string }> };
    expect(body.count).toBe(1);
    expect(body.created.map((page) => page.id)).not.toContain(legacyId);
    expect(body.errors).toEqual([
      { index: 1, error: 'id_conflict' },
      { index: 2, error: 'id_conflict' },
    ]);
  });

  it('reports missing parents as per-item JSON errors in batch imports', async () => {
    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: [
        { page_type: 'guest', name: 'Valid Guest' },
        { page_type: 'guest', name: 'Orphan Guest', page_id: 999999 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; errors: Array<{ index: number; error: string }> };
    expect(body.count).toBe(1);
    expect(body.errors).toEqual([{ index: 1, error: 'parent_not_found' }]);
  });

  it('caps batch size to keep CMS work bounded', async () => {
    const accepted = await cmsApi('POST', '/__cms/pages/batch', {
      pages: Array.from({ length: 100 }, (_, index) => ({ page_type: 'guest', name: `Accepted ${index}` })),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json() as { count: number }).count).toBe(100);

    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: Array.from({ length: 101 }, (_, index) => ({ page_type: 'guest', name: `G${index}` })),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'batch_too_large', max: 100 });
  });

  it('coerces an explicit null page_id to a null parent (not 0) so the FK holds', async () => {
    // Regression: `Number(null)` is 0, so a naive numeric coercion would bind
    // page_id=0 and violate the pages self-FK. A null/empty parent must
    // store NULL. (Exposed by the events plugin "duplicate event" of a top-level
    // event, whose source page_id is null.)
    const res = await cmsApi('POST', '/__cms/pages', {
      page_type: 'event', name: 'Top-level event', page_id: null,
    });
    expect(res.status).toBe(201);
    const created = (await res.json() as { page: { id: number; page_id: number | null } }).page;
    expect(created.page_id).toBeNull();
  });

  it('bulk-clones a collection selected by lect pointer (not parent) with a transform', async () => {
    const sourceList = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;
    const targetList = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP copy', lect: { _pointers: { event: '99' } },
    })).json() as { page: { id: number } }).page;

    // Guests reference the list ONLY by the mail_list pointer — page_id is left
    // null on purpose, so a parent-based selector would miss them entirely.
    for (const name of ['Jane', 'John', 'Jo']) {
      await cmsApi('POST', '/__cms/pages', {
        page_type: 'guest', name,
        lect: {
          email: `${name.toLowerCase()}@x.com`, status: 'confirmed',
          _pointers: { event: '7', mail_list: String(sourceList.id) },
          checkin: [{ status: 'checked-in', date: '2026-01-01' }],
        },
      });
    }

    const dup = await cmsApi('POST', '/__cms/pages/duplicate', {
      source_pointer_key: 'mail_list', source_pointer_value: String(sourceList.id),
      source_page_type: 'guest', target_page_id: targetList.id,
      lect: { status: 'to be invited', _pointers: { event: '99', mail_list: String(targetList.id) } },
      drop_lect: ['checkin'],
    });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ count: 3, next_cursor: null, done: true });

    // Clones carry the transform and group under the target list by pointer.
    const cloned = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${targetList.id}`)).json() as {
      total: number; pages: Array<{ page_id: number; lect: Record<string, any> }>;
    };
    expect(cloned.total).toBe(3);
    for (const clone of cloned.pages) {
      expect(clone.page_id).toBe(targetList.id);                   // target parent set too
      expect(clone.lect.status).toBe('to be invited');            // override applied
      expect(clone.lect._pointers.event).toBe('99');               // repointed
      expect(clone.lect._pointers.mail_list).toBe(String(targetList.id));
      expect(clone.lect.checkin).toBeUndefined();                  // dropped
      expect(String(clone.lect.email)).toContain('@x.com');        // identity carried over
    }

    // The source guests are untouched.
    const sources = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${sourceList.id}`)).json() as { total: number };
    expect(sources.total).toBe(3);
  });

  it('rejects a duplicate into a page type the plugin does not own', async () => {
    const res = await cmsApi('POST', '/__cms/pages/duplicate', {
      source_pointer_key: 'mail_list', source_pointer_value: '1', source_page_type: 'contact', target_page_id: null,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden_page_type');
  });

  it('rejects a duplicate with no source selector', async () => {
    const res = await cmsApi('POST', '/__cms/pages/duplicate', { source_page_type: 'guest' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('selector_required');
  });

  it('bulk-trashes a collection selected by lect pointer (delete-children)', async () => {
    const list = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;
    const other = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'Other', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;

    // Guests reference the list ONLY by the mail_list pointer (page_id null), so
    // a parent-based delete would miss them — the pointer selector must find them.
    for (const name of ['Jane', 'John', 'Jo']) {
      await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name, lect: { _pointers: { mail_list: String(list.id) } } });
    }
    // A guest under a different list must NOT be touched.
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Keep', lect: { _pointers: { mail_list: String(other.id) } } });

    const del = await cmsApi('DELETE', '/__cms/pages/children', {
      pointer_key: 'mail_list', pointer_value: String(list.id), page_type: 'guest',
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ trashed: 3, done: true });

    // The list's guests are gone from drafts and now in trash.
    const remaining = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${list.id}`)).json() as { total: number };
    expect(remaining.total).toBe(0);
    const trashRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_pages WHERE page_type = 'guest'")
      .first<{ n: number }>();
    expect(trashRow?.n).toBe(3);

    // The other list's guest survives.
    const kept = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${other.id}`)).json() as { total: number };
    expect(kept.total).toBe(1);
  });

  it('rejects delete-children for a page type the plugin does not own', async () => {
    const res = await cmsApi('DELETE', '/__cms/pages/children', { pointer_key: 'mail_list', pointer_value: '1', page_type: 'contact' });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden_page_type');
  });

  it('rejects delete-children with both selectors (ambiguous)', async () => {
    const res = await cmsApi('DELETE', '/__cms/pages/children', {
      parent_page_id: 1, pointer_key: 'mail_list', pointer_value: '1', page_type: 'guest',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('ambiguous_selector');
  });
});

// Bulk restore-from-trash (the /admin/trash "Restore All" / "Restore Last Hour"
// controls). Exercises the set-based restoreTrashedPages helper against D1.
describe('bulk trash restore', () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM pages WHERE page_type IN ('event','guest','mail_list')").run();
    await env.DB.prepare("DELETE FROM trash_pages WHERE page_type IN ('event','guest','mail_list')").run();
  });

  async function trashGuestCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_pages WHERE page_type = 'guest'").first<{ n: number }>();
    return row?.n ?? 0;
  }
  async function draftGuestCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'guest'").first<{ n: number }>();
    return row?.n ?? 0;
  }

  it('restores all trashed pages of a type back to draft, with version history', async () => {
    const list = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'L', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;
    const guestIds: number[] = [];
    for (const name of ['A', 'B', 'C']) {
      const g = (await (await cmsApi('POST', '/__cms/pages', {
        page_type: 'guest', name, lect: { _pointers: { mail_list: String(list.id) } },
      })).json() as { page: { id: number } }).page;
      guestIds.push(g.id);
    }
    await cmsApi('DELETE', '/__cms/pages/children', { pointer_key: 'mail_list', pointer_value: String(list.id), page_type: 'guest' });
    expect(await trashGuestCount()).toBe(3);
    expect(await draftGuestCount()).toBe(0);

    const restored = await restoreTrashedPages(env.DB, { pageType: 'guest' });
    expect(restored).toBe(3);

    // Back in drafts (same ids), gone from trash.
    expect(await draftGuestCount()).toBe(3);
    expect(await trashGuestCount()).toBe(0);
    const back = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${list.id}`)).json() as { total: number };
    expect(back.total).toBe(3);
    // The create version came back too (id preserved), so the editor can load it.
    const versions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM page_versions WHERE page_id IN (${guestIds.map(() => '?').join(',')})`)
      .bind(...guestIds).first<{ n: number }>();
    expect(versions?.n).toBeGreaterThanOrEqual(3);
  });

  it('restores only the last hour when scoped, leaving older trash', async () => {
    // Two trash rows: one just now, one trashed two hours ago.
    await env.DB.prepare("INSERT INTO trash_pages (id, name, slug, page_type, lect, created_at) VALUES (?, 'Recent', 'recent', 'guest', '{}', datetime('now'))")
      .bind(900001).run();
    await env.DB.prepare("INSERT INTO trash_pages (id, name, slug, page_type, lect, created_at) VALUES (?, 'Old', 'old', 'guest', '{}', datetime('now', '-2 hours'))")
      .bind(900002).run();

    const restored = await restoreTrashedPages(env.DB, { pageType: 'guest', withinLastHour: true });
    expect(restored).toBe(1);

    // The recent row is restored; the old one stays in trash.
    expect(await draftGuestCount()).toBe(1);
    expect(await trashGuestCount()).toBe(1);
    const oldStill = await env.DB.prepare("SELECT name FROM trash_pages WHERE id = ?").bind(900002).first<{ name: string }>();
    expect(oldStill?.name).toBe('Old');
  });

  it('restores nothing (count 0) when the trash is empty', async () => {
    expect(await restoreTrashedPages(env.DB, {})).toBe(0);
  });
});

// New surface added when CSV import/export moved to the import-export plugin:
// content metadata, tag ensure-by-name, and list lookup/tag projections.
describe('Plugin API content-meta, tag ensure, and lookup projections', () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM page_tags WHERE tag_id IN (SELECT id FROM tags WHERE taxonomy_slug = 'topic')").run();
    await env.DB.prepare("DELETE FROM tags WHERE taxonomy_slug = 'topic'").run();
    await env.DB.prepare("DELETE FROM taxonomies WHERE slug = 'topic'").run();
  });

  it('returns languages, taxonomies and blueprint path specs for readable types', async () => {
    const response = await cmsApi('GET', '/__cms/content-meta?types=guest');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      page_types: string[];
      languages: string[];
      default_language: string;
      path_specs: Record<string, Array<{ path: string; kind: string }>>;
    };
    expect(body.languages).toContain('en');
    expect(body.default_language).toBeTruthy();
    expect(body.page_types).toContain('guest');
    // Host-owned types the plugin cannot read are not offered.
    expect(body.page_types).not.toContain('default');
    const guestPaths = body.path_specs.guest.map((spec) => spec.path);
    expect(guestPaths).toContain('email');
    expect(guestPaths).toContain('name');
    expect(body.path_specs.guest.find((spec) => spec.path === 'name')?.kind).toBe('localized');
  });

  it('refuses content-meta for a type outside the plugin scope', async () => {
    const response = await cmsApi('GET', '/__cms/content-meta?types=default');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'forbidden_page_type', page_type: 'default' });
  });

  it('ensures tags by taxonomy and name, reusing existing rows', async () => {
    await env.DB.prepare("INSERT INTO taxonomies (name, slug) VALUES ('Topic', 'topic')").run();

    const first = await cmsApi('POST', '/__cms/tags/ensure', {
      tags: [
        { taxonomy: 'topic', name: 'News' },
        { taxonomy: 'nope', name: 'X' },
        { taxonomy: 'topic', name: '' },
      ],
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { tags: Array<{ taxonomy: string; name: string; id: number }>; errors: Array<{ index: number; error: string }> };
    expect(firstBody.tags).toHaveLength(1);
    expect(firstBody.tags[0]).toMatchObject({ taxonomy: 'topic', name: 'News' });
    expect(firstBody.errors).toEqual([
      { index: 1, error: 'unknown_taxonomy' },
      { index: 2, error: 'name_required' },
    ]);

    // Idempotent: the same (taxonomy, name) resolves to the same tag id.
    const second = await cmsApi('POST', '/__cms/tags/ensure', { tags: [{ taxonomy: 'topic', name: 'News' }] });
    const secondBody = await second.json() as { tags: Array<{ id: number }> };
    expect(secondBody.tags[0].id).toBe(firstBody.tags[0].id);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags WHERE taxonomy_slug = 'topic'").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('looks up pages by ids/slugs and attaches tags when include_tags=1', async () => {
    await env.DB.prepare("INSERT INTO taxonomies (name, slug) VALUES ('Topic', 'topic')").run();
    const ensure = await cmsApi('POST', '/__cms/tags/ensure', { tags: [{ taxonomy: 'topic', name: 'News' }] });
    const tagId = ((await ensure.json()) as { tags: Array<{ id: number }> }).tags[0].id;

    const one = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Lookup One', slug: 'lookup-one', tags: [tagId] });
    expect(one.status).toBe(201);
    const oneId = ((await one.json()) as { page: { id: number } }).page.id;
    const two = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Lookup Two', slug: 'lookup-two' });
    expect(two.status).toBe(201);
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Lookup Three', slug: 'lookup-three' });

    const response = await cmsApi('GET', `/__cms/pages?page_type=guest&ids=${oneId}&slugs=lookup-two&include_tags=1`);
    expect(response.status).toBe(200);
    const body = await response.json() as { pages: Array<{ slug: string; tags?: Array<{ name: string; taxonomy: string }> }>; total: number };
    expect(body.pages.map((page) => page.slug).sort()).toEqual(['lookup-one', 'lookup-two']);
    const withTag = body.pages.find((page) => page.slug === 'lookup-one');
    expect(withTag?.tags).toEqual([{ id: tagId, name: 'News', taxonomy: 'Topic', taxonomy_slug: 'topic' }]);
    expect(body.pages.find((page) => page.slug === 'lookup-two')?.tags).toEqual([]);
  });

  it('rejects malformed ids in a lookup', async () => {
    const response = await cmsApi('GET', '/__cms/pages?page_type=guest&ids=1,abc');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_ids' });
  });

  // Regression: a full 500-row page with include_tags=1 (or a >100-entry
  // ids/slugs lookup) must not blow D1's 100-bound-parameters-per-query cap —
  // the export flow of the import-export plugin fetches exactly this shape.
  it('handles include_tags and ids lookups beyond 100 rows in one call', async () => {
    const created: Array<{ id: number }> = [];
    for (let start = 0; start < 120; start += 60) {
      const batch = await cmsApi('POST', '/__cms/pages/batch', {
        pages: Array.from({ length: 60 }, (_, i) => ({
          page_type: 'guest',
          name: `Bulk Tagged ${start + i}`,
          slug: `bulk-tagged-${start + i}`,
        })),
      });
      expect(batch.status).toBe(200);
      created.push(...((await batch.json()) as { created: Array<{ id: number }> }).created);
    }
    expect(created).toHaveLength(120);

    const list = await cmsApi('GET', '/__cms/pages?page_type=guest&limit=500&include_tags=1');
    expect(list.status).toBe(200);
    const listBody = await list.json() as { pages: Array<{ tags?: unknown[] }> };
    expect(listBody.pages.length).toBeGreaterThanOrEqual(120);
    expect(listBody.pages.every((page) => Array.isArray(page.tags))).toBe(true);

    const ids = created.map((page) => page.id).join(',');
    const lookup = await cmsApi('GET', `/__cms/pages?page_type=guest&ids=${ids}&limit=500&count=0`);
    expect(lookup.status).toBe(200);
    expect(((await lookup.json()) as { pages: unknown[] }).pages).toHaveLength(120);
  });
});
