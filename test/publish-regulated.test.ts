// Regulated data is never published.
//
// The property under test is one-directional and absolute: no configuration,
// no missing plugin and no classification outage may let a page classified
// `phi` reach a publish target. So each case asserts both halves — the refusal
// the caller sees, AND that the published database is still empty — because a
// refusal that reports correctly while the row lands anyway is the failure this
// gate exists to prevent.
//
// Unpublishing is deliberately NOT gated: a page published before it was
// classified has to be withdrawable.

import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import {
  publishPageToTargets,
  publishPagesToTargets,
  unpublishPageFromTargets,
} from '../src/core/publish';
import { regulatedPages } from '../src/core/publish/regulated';
import type { Env, JWTPayload, Page } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;

const FIRST_ID = 7100;

function pageRow(index: number, pageType: string): Page {
  const id = FIRST_ID + index;
  return {
    id,
    uuid: `uuid-regulated-${id}`,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    name: `Page ${id}`,
    slug: `page-${id}`,
    weight: 5,
    start: null,
    end: null,
    timezone: null,
    page_type: pageType,
    lect: JSON.stringify({ name: { en: `Page ${id}` } }),
    page_id: null,
    creator: 1,
    editors: null,
  };
}

/** Inserts the draft row and returns it in the shape the bulk path takes. */
async function seedPage(index: number, pageType: string): Promise<Page> {
  const page = pageRow(index, pageType);
  await env.DB.prepare(
    `INSERT INTO pages (id, uuid, name, slug, weight, page_type, lect, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(page.id, page.uuid, page.name, page.slug, page.weight, page.page_type, page.lect, page.creator).run();
  return page;
}

async function classify(kind: string, key: string, dataClass: string): Promise<void> {
  await env.DB.prepare('INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, ?)')
    .bind(kind, key, dataClass)
    .run();
}

/** Links a page to a tag in a taxonomy, creating the tag. */
async function tagPage(page: Page, tagId: number, taxonomy: string | null): Promise<void> {
  await env.DB.prepare('INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (?, ?, ?, ?)')
    .bind(tagId, `Tag ${tagId}`, `tag-${tagId}`, taxonomy)
    .run();
  await env.DB.prepare('INSERT INTO page_tags (page_id, tag_id, weight) VALUES (?, ?, 1)')
    .bind(page.id, tagId)
    .run();
}

function testEnv(): Env {
  return { ...env } as unknown as Env;
}

/** Live rows for the pages this file seeds. The assertion every case shares. */
async function livePages(): Promise<string[]> {
  const { results } = await env.PUBLISHED_DB.prepare(
    "SELECT uuid FROM pages WHERE uuid LIKE 'uuid-regulated-%' ORDER BY uuid",
  ).all<{ uuid: string }>();
  return results.map((row) => row.uuid);
}

/** Runs `body` with `data_classes` unreadable, the outage the gate must survive. */
async function withoutClassificationTable(body: () => Promise<void>): Promise<void> {
  await env.DB.prepare('ALTER TABLE data_classes RENAME TO data_classes_away').run();
  try {
    await body();
  } finally {
    await env.DB.prepare('ALTER TABLE data_classes_away RENAME TO data_classes').run();
  }
}

async function cleanup(): Promise<void> {
  await env.DB.prepare('DELETE FROM page_tags WHERE page_id >= ?').bind(FIRST_ID).run();
  await env.DB.prepare('DELETE FROM pages WHERE id >= ?').bind(FIRST_ID).run();
  await env.DB.prepare('DELETE FROM tags WHERE id >= 900').run();
  await env.DB.prepare('DELETE FROM data_classes').run();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.PUBLISHED_DB.prepare("DELETE FROM pages WHERE uuid LIKE 'uuid-regulated-%'").run();
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await cleanup();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin')
    .run();
});

afterEach(cleanup);

describe('publishing one page', () => {
  it('publishes an unclassified page, as it always did', async () => {
    const page = await seedPage(0, 'note');

    const outcome = await publishPageToTargets(testEnv(), page.id);
    expect(outcome).toMatchObject({ failures: [] });
    expect(outcome!.refused).toBeUndefined();
    expect(await livePages()).toEqual([page.uuid]);
  });

  it('still publishes a pii page — only phi is withheld', async () => {
    // pii is logged on read, not withheld from publication; conflating the two
    // would make the classification screen unusable for ordinary contact data.
    const page = await seedPage(0, 'contact');
    await classify('page_type', 'contact', 'pii');

    expect((await publishPageToTargets(testEnv(), page.id))!.refused).toBeUndefined();
    expect(await livePages()).toEqual([page.uuid]);
  });

  it('refuses a page whose type is classified phi', async () => {
    const page = await seedPage(0, 'chart');
    await classify('page_type', 'chart', 'phi');

    expect(await publishPageToTargets(testEnv(), page.id)).toMatchObject({
      targets: [],
      failures: [],
      refused: true,
      refusedReason: 'regulated',
    });
    expect(await livePages()).toEqual([]);
  });

  it('refuses an ordinary page tagged from a classified taxonomy', async () => {
    // The association is the regulated fact: "page X is in the oncology
    // programme" discloses it even though the page type is a plain article.
    const page = await seedPage(0, 'article');
    await tagPage(page, 901, 'diagnosis');
    await classify('taxonomy', 'diagnosis', 'phi');

    expect(await publishPageToTargets(testEnv(), page.id)).toMatchObject({ refusedReason: 'regulated' });
    expect(await livePages()).toEqual([]);
  });

  it('publishes a page tagged from an unclassified taxonomy alongside a classified one', async () => {
    const clean = await seedPage(0, 'article');
    await tagPage(clean, 902, 'category');
    await classify('taxonomy', 'diagnosis', 'phi');

    expect((await publishPageToTargets(testEnv(), clean.id))!.refused).toBeUndefined();
    expect(await livePages()).toEqual([clean.uuid]);
  });

  it('refuses everything when the classification cannot be read', async () => {
    // The fail-open choice read logging makes would publish here, which is why
    // this path decides for itself rather than trusting an empty map.
    const page = await seedPage(0, 'note');

    await withoutClassificationTable(async () => {
      expect(await publishPageToTargets(testEnv(), page.id)).toMatchObject({
        refused: true,
        refusedReason: 'classification_unavailable',
      });
      expect(await livePages()).toEqual([]);
    });
  });

  it('refuses when a taxonomy is classified but the tags table cannot answer', async () => {
    const page = await seedPage(0, 'article');
    await classify('taxonomy', 'diagnosis', 'phi');

    await env.DB.prepare('ALTER TABLE tags RENAME TO tags_away').run();
    try {
      expect(await publishPageToTargets(testEnv(), page.id)).toMatchObject({
        refusedReason: 'classification_unavailable',
      });
      expect(await livePages()).toEqual([]);
    } finally {
      await env.DB.prepare('ALTER TABLE tags_away RENAME TO tags').run();
    }
  });

  it('returns null for a missing draft, before any gate runs', async () => {
    expect(await publishPageToTargets(testEnv(), 999999)).toBeNull();
  });
});

describe('publishing many pages', () => {
  it('publishes the clean pages and reports the regulated ones apart', async () => {
    const clean = await seedPage(0, 'note');
    const regulated = await seedPage(1, 'chart');
    await classify('page_type', 'chart', 'phi');

    const outcome = await publishPagesToTargets(testEnv(), [clean, regulated]);
    expect(outcome.published.map((page) => page.id)).toEqual([clean.id]);
    expect(outcome.refused.map((page) => page.id)).toEqual([regulated.id]);
    expect(outcome.refusedRegulated.map((page) => page.id)).toEqual([regulated.id]);
    expect(await livePages()).toEqual([clean.uuid]);
  });

  it('refuses the whole slice when the classification cannot be read', async () => {
    const first = await seedPage(0, 'note');
    const second = await seedPage(1, 'note');

    await withoutClassificationTable(async () => {
      const outcome = await publishPagesToTargets(testEnv(), [first, second]);
      expect(outcome.published).toEqual([]);
      expect(outcome.refusedRegulated.map((page) => page.id)).toEqual([first.id, second.id]);
      expect(await livePages()).toEqual([]);
    });
  });

  it('keeps publishing a slice larger than one bound-parameter chunk', async () => {
    // The taxonomy read shares its parameter budget with the page ids, so a
    // slice wider than one chunk is where an off-by-one would surface as a
    // thrown query — and a thrown query here means a refusal, not a publish.
    await classify('taxonomy', 'diagnosis', 'phi');
    const pages: Page[] = [];
    for (let index = 0; index < 95; index += 1) pages.push(await seedPage(index, 'note'));

    const outcome = await publishPagesToTargets(testEnv(), pages);
    expect(outcome.published).toHaveLength(95);
    expect(outcome.refusedRegulated).toEqual([]);
    expect(await livePages()).toHaveLength(95);
  });
});

describe('withdrawing what was already published', () => {
  it('unpublishes a regulated page that reached live before it was classified', async () => {
    const page = await seedPage(0, 'chart');
    expect((await publishPageToTargets(testEnv(), page.id))!.refused).toBeUndefined();
    expect(await livePages()).toEqual([page.uuid]);

    // Classified afterwards, which is the realistic order of events.
    await classify('page_type', 'chart', 'phi');

    const outcome = await unpublishPageFromTargets(testEnv(), page.uuid);
    expect(outcome.refused).toBeUndefined();
    expect(await livePages()).toEqual([]);
  });
});

describe('what the gate reports', () => {
  it('names no page it cannot classify, rather than guessing', async () => {
    const page = await seedPage(0, 'chart');
    await classify('page_type', 'chart', 'phi');

    await withoutClassificationTable(async () => {
      const result = await regulatedPages(testEnv(), [page]);
      expect(result.unavailable).toBe(true);
      expect([...result.ids]).toEqual([]);
    });
  });

  it('costs no tag read when no taxonomy is classified', async () => {
    const page = await seedPage(0, 'article');
    await tagPage(page, 903, 'category');
    await classify('page_type', 'chart', 'phi');

    // Proven by the absence of the tags table: reaching it would throw, and the
    // helper would have to report `unavailable`.
    await env.DB.prepare('ALTER TABLE tags RENAME TO tags_away').run();
    try {
      expect(await regulatedPages(testEnv(), [page])).toMatchObject({ unavailable: false });
    } finally {
      await env.DB.prepare('ALTER TABLE tags_away RENAME TO tags').run();
    }
  });
});

describe('the admin publish route', () => {
  it('tells the operator the page was withheld, not published', async () => {
    const page = await seedPage(0, 'chart');
    await classify('page_type', 'chart', 'phi');

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

    const response = await worker.fetch(new IncomingRequest(
      new URL(`/admin/pages/${page.id}/publish`, 'http://localhost'),
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: `access_token=${token}`,
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '10.77.0.1',
        },
      },
    ));

    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get('Location') ?? ''))
      .toContain('holds regulated data and cannot be published');
    expect(await livePages()).toEqual([]);
  });
});
