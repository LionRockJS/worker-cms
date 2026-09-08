import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestSubmissions, isSubmissionMirror } from '../src/core/db/submission-ingest';
import { publishPageToTargets, unpublishPageFromTargets } from '../src/core/publish';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';

// Submission ingest — any public Worker may write a page into the published
// DB; when its uuid has no draft counterpart, the host mirrors it as a
// submission (same uuid → idempotent) and fires submission hooks.
// The publish path must refuse the mirrored pages in both directions, and a
// CMS publish/unpublish of an ordinary page must never touch submission rows.

const PLUGIN_SECRET = 'test-plugin-secret-value';
const CURSOR_KEY = 'submissions.ingest.cursor';

const GUEST_ID = 77001;
const EVENT_ID = 77002;

interface LiveSubmissionSeed {
  id: number;
  uuid: string;
  created_at: string;
  page_type: string;
  page_id: number | null;
  lect?: Record<string, unknown>;
}

async function seedLiveSubmission(seed: LiveSubmissionSeed): Promise<void> {
  await env.PUBLISHED_DB.prepare(
    `INSERT INTO pages (id, uuid, created_at, name, slug, weight, page_type, lect, page_id)
     VALUES (?, ?, ?, ?, ?, 5, ?, ?, ?)`,
  )
    .bind(
      seed.id,
      seed.uuid,
      seed.created_at,
      `Submission ${seed.uuid.slice(0, 8)}`,
      `submission-${seed.uuid.slice(0, 8)}`,
      seed.page_type,
      JSON.stringify(seed.lect ?? { _type: seed.page_type, status: 'confirmed' }),
      seed.page_id,
    )
    .run();
}

async function seedDraftPage(id: number, pageType: string, uuid?: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pages (id, ${uuid ? 'uuid, ' : ''}name, slug, weight, page_type, lect)
     VALUES (?, ${uuid ? '?, ' : ''}?, ?, 5, ?, ?)`,
  )
    .bind(...(uuid ? [id, uuid] : [id]), `Page ${id}`, `page-${id}`, pageType, JSON.stringify({ name: { en: `Page ${id}` } }))
    .run();
}

const hookCalls: { url: string; body: { event: string; page: { uuid?: string; page_type?: string } } }[] = [];
let savedSecret: unknown;
const testEnv = env as unknown as Record<string, unknown>;

async function registerHookPlugin(): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(href).pathname;
      if (path === '/__plugin/manifest') {
        return Response.json({
          id: 'events',
          name: 'Events Suite',
          version: '1.0.0',
          hooks: ['submission'],
          contentTypes: { blueprint: { contact_request: ['status'] } },
        });
      }
      if (path.startsWith('/__plugin/hooks/')) {
        hookCalls.push({ url: href, body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response('ok');
      }
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

async function cleanup(): Promise<void> {
  __clearInjectedFetchers();
  hookCalls.length = 0;
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(CURSOR_KEY).run();
  await env.DB.prepare("DELETE FROM pages WHERE uuid LIKE 'facade01-%'").run();
  await env.DB.prepare('DELETE FROM pages WHERE id IN (?, ?)').bind(GUEST_ID, EVENT_ID).run();
  await env.PUBLISHED_DB.prepare("DELETE FROM pages WHERE uuid LIKE 'facade01-%'").run();
}

beforeEach(async () => {
  clearManifestCache();
  await cleanup();
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
});

afterEach(async () => {
  if (savedSecret === undefined) delete testEnv.PLUGIN_SECRET;
  else testEnv.PLUGIN_SECRET = savedSecret;
  await cleanup();
});

describe('ingestSubmissions', () => {
  it('pulls a live-only page of any type into draft as a submission', async () => {
    await registerHookPlugin();
    await seedDraftPage(GUEST_ID, 'guest');
    await seedLiveSubmission({
      id: -100001,
      uuid: 'facade01-0001-4001-8001-000000000001',
      created_at: '2026-07-07 10:00:00',
      page_type: 'contact_request',
      page_id: GUEST_ID,
      lect: { _type: 'contact_request', status: 'new', message: 'Hello' },
    });

    const result = await ingestSubmissions(env);
    expect(result.created).toBe(1);
    expect(result.scanned).toBe(1);

    const draft = await env.DB.prepare('SELECT * FROM pages WHERE uuid = ?')
      .bind('facade01-0001-4001-8001-000000000001')
      .first<{ id: number; page_type: string; page_id: number | null; lect: string; created_at: string }>();
    expect(draft).not.toBeNull();
    expect(draft!.id).toBeGreaterThan(0); // draft mints its own positive id
    expect(draft!.page_type).toBe('contact_request');
    expect(await isSubmissionMirror(env.DB, draft!.id)).toBe(true);
    expect(draft!.page_id).toBe(GUEST_ID);
    expect(JSON.parse(draft!.lect).message).toBe('Hello');
    expect(draft!.created_at).toBe('2026-07-07 10:00:00'); // submission time preserved

    const version = await env.DB.prepare('SELECT action FROM page_versions WHERE page_id = ? ORDER BY id DESC')
      .bind(draft!.id)
      .first<{ action: string }>();
    expect(version?.action).toBe('ingest-submission');

    // The dedicated submission hook reached the subscribed plugin.
    expect(hookCalls.length).toBe(1);
    expect(hookCalls[0].url).toContain('/hooks/submission');
    expect(hookCalls[0].body.page.uuid).toBe('facade01-0001-4001-8001-000000000001');
    expect(hookCalls[0].body.event).toBe('submission');
    expect(hookCalls[0].body.page.page_type).toBe('contact_request');
  });

  it('is idempotent: a second run past the cursor creates nothing', async () => {
    await seedLiveSubmission({
      id: -100002,
      uuid: 'facade01-0002-4002-8002-000000000002',
      created_at: '2026-07-07 10:01:00',
      page_type: 'rsvp_registration',
      page_id: null,
    });

    expect((await ingestSubmissions(env)).created).toBe(1);
    const again = await ingestSubmissions(env);
    expect(again.created).toBe(0);
    expect(again.scanned).toBe(0); // cursor moved past the row

    const drafts = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'rsvp_registration'")
      .first<{ n: number }>();
    expect(drafts?.n).toBe(1);
  });

  it('re-ingests nothing when the draft copy already exists but the cursor was reset', async () => {
    await seedLiveSubmission({
      id: -100003,
      uuid: 'facade01-0003-4003-8003-000000000003',
      created_at: '2026-07-07 10:02:00',
      page_type: 'rsvp_response',
      page_id: null,
    });
    expect((await ingestSubmissions(env)).created).toBe(1);

    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(CURSOR_KEY).run();
    const rerun = await ingestSubmissions(env);
    expect(rerun.scanned).toBe(1); // scanned again from the reset cursor
    expect(rerun.created).toBe(0); // …but the uuid already exists in draft
  });

  it('finds a live-only page on a later cursor pass', async () => {
    const uuid = 'facade01-0004-4004-8004-000000000004';
    await seedLiveSubmission({
      id: -100004,
      uuid,
      created_at: '2026-07-07 10:03:00',
      page_type: 'survey_answer',
      page_id: null,
    });
    await seedDraftPage(77004, 'survey_answer', uuid);

    expect((await ingestSubmissions(env)).created).toBe(0);
    await env.DB.prepare('DELETE FROM pages WHERE uuid = ?').bind(uuid).run();

    expect((await ingestSubmissions(env)).more).toBe(true); // completed pass resets cursor
    expect((await ingestSubmissions(env)).created).toBe(1);
    const mirrored = await env.DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind(uuid).first<{ id: number }>();
    expect(await isSubmissionMirror(env.DB, mirrored!.id)).toBe(true);
  });

  it('caps creates per run and resumes from the cursor', async () => {
    for (let index = 0; index < 10; index += 1) {
      await seedLiveSubmission({
        id: -(100100 + index),
        uuid: `facade01-1000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
        created_at: '2026-07-07 11:00:00', // identical timestamps — cursor falls back to uuid order
        page_type: 'rsvp_response',
        page_id: null,
      });
    }

    const first = await ingestSubmissions(env);
    expect(first.created).toBe(8);
    expect(first.more).toBe(true);

    const second = await ingestSubmissions(env);
    expect(second.created).toBe(2);

    const drafts = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'rsvp_response'")
      .first<{ n: number }>();
    expect(drafts?.n).toBe(10);
  });
});

describe('publish path refuses submission mirrors', () => {
  it('does not publish a submission mirror of an arbitrary page type', async () => {
    await seedLiveSubmission({
      id: -100201,
      uuid: 'facade01-0201-4201-8201-000000000201',
      created_at: '2026-07-07 12:00:00',
      page_type: 'contact_request',
      page_id: null,
      lect: { _type: 'contact_request', status: 'new' },
    });
    await ingestSubmissions(env);
    const draft = await env.DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('facade01-0201-4201-8201-000000000201')
      .first<{ id: number }>();

    const outcome = await publishPageToTargets(env, draft!.id);
    expect(outcome?.refused).toBe(true);
    expect(outcome?.targets).toEqual([]);

    // The original live row is untouched.
    const live = await env.PUBLISHED_DB.prepare('SELECT id, lect FROM pages WHERE uuid = ?')
      .bind('facade01-0201-4201-8201-000000000201')
      .first<{ id: number; lect: string }>();
    expect(live?.id).toBe(-100201);
    expect(JSON.parse(live!.lect).status).toBe('new');
  });

  it('does not unpublish the live source when the submission marker is passed', async () => {
    await seedLiveSubmission({
      id: -100202,
      uuid: 'facade01-0202-4202-8202-000000000202',
      created_at: '2026-07-07 12:01:00',
      page_type: 'rsvp_registration',
      page_id: null,
    });

    const outcome = await unpublishPageFromTargets(env, 'facade01-0202-4202-8202-000000000202', true);
    expect(outcome.refused).toBe(true);

    const live = await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('facade01-0202-4202-8202-000000000202')
      .first<{ id: number }>();
    expect(live?.id).toBe(-100202);
  });

  it('publishing and unpublishing an ordinary page leaves submission rows alone', async () => {
    await seedLiveSubmission({
      id: -100203,
      uuid: 'facade01-0203-4203-8203-000000000203',
      created_at: '2026-07-07 12:02:00',
      page_type: 'rsvp_response',
      page_id: null,
    });
    await seedDraftPage(EVENT_ID, 'event', 'facade01-aaaa-4aaa-8aaa-00000000aaaa');

    const published = await publishPageToTargets(env, EVENT_ID);
    expect(published?.refused).toBeUndefined();
    await unpublishPageFromTargets(env, 'facade01-aaaa-4aaa-8aaa-00000000aaaa', false);

    const live = await env.PUBLISHED_DB.prepare('SELECT id FROM pages WHERE uuid = ?')
      .bind('facade01-0203-4203-8203-000000000203')
      .first<{ id: number }>();
    expect(live?.id).toBe(-100203);
  });
});
