// A bulk publish/unpublish must not cost a round trip per page. Publishing a
// full slice used to fan out ~6 D1 round trips per page (603 for a 100-page
// slice, 60% of the Worker subrequest budget with only the d1 target); this
// pins the batched behavior so it cannot regress back to a loop.

import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBulkPageAction, BULK_ACTION_PAGE_LIMIT } from '../src/core/pages/bulk-action';
import { publishPagesToTargets } from '../src/core/publish';
import { r2Adapter } from '../src/core/publish/r2';
import { clearManifestCache } from '../src/features/plugins/registry';
import type { PublishSnapshot } from '../src/core/publish/adapter';
import type { Env, JWTPayload, Page } from '../src/types';

const USER = { sub: '1', email: 'admin@example.com', role: 'admin' } as unknown as JWTPayload;
const SLUG_PREFIX = 'bulk-rt-';

/** Counts D1 round trips: every executed statement, and every batch as one. */
interface RoundTrips { draft: number; published: number }

function countingDb(db: D1DatabaseClient, tally: RoundTrips, side: 'draft' | 'published'): D1DatabaseClient {
  const count = <T>(result: T): T => { tally[side] += 1; return result; };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
    ...statement,
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    first: (...args: unknown[]) => count((statement as never as Record<string, Function>).first(...args)),
    all: (...args: unknown[]) => count((statement as never as Record<string, Function>).all(...args)),
    run: (...args: unknown[]) => count((statement as never as Record<string, Function>).run(...args)),
    raw: (...args: unknown[]) => count((statement as never as Record<string, Function>).raw(...args)),
  } as unknown as D1PreparedStatement);

  return {
    ...db,
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => count(db.batch(statements)),
  } as unknown as D1DatabaseClient;
}

/** An env whose two databases report what a call cost. */
function countingEnv(tally: RoundTrips): Env {
  return {
    ...env,
    DB: countingDb(env.DB, tally, 'draft'),
    PUBLISHED_DB: countingDb(env.PUBLISHED_DB, tally, 'published'),
  } as unknown as Env;
}

/** Ids are assigned explicitly rather than left to the column default: that
 *  default is a per-second counter plus 16 random bits, so seeding a hundred
 *  rows inside one second collides on the UNIQUE id often enough to make this
 *  file flaky (~7% per seed). */
const ID_BASE = 990_000_000;

async function seedPages(count: number, tagId?: number): Promise<Page[]> {
  const pages: Page[] = [];
  for (let index = 0; index < count; index += 1) {
    const page = await env.DB.prepare(
      `INSERT INTO pages (id, name, slug, page_type, lect) VALUES (?, ?, ?, 'default', ?) RETURNING *`,
    )
      .bind(ID_BASE + index, `Bulk ${index}`, `${SLUG_PREFIX}${index}`, JSON.stringify({ name: { en: `Bulk ${index}` } }))
      .first<Page>();
    if (tagId !== undefined) {
      await env.DB.prepare('INSERT INTO page_tags (page_id, tag_id, weight) VALUES (?, ?, 1)')
        .bind(page!.id, tagId)
        .run();
    }
    pages.push(page!);
  }
  return pages;
}

async function cleanup(): Promise<void> {
  await env.DB.prepare(`DELETE FROM page_tags WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${SLUG_PREFIX}%')`).run();
  await env.DB.prepare(`DELETE FROM page_versions WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${SLUG_PREFIX}%')`).run();
  await env.PUBLISHED_DB.prepare(`DELETE FROM page_tags WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${SLUG_PREFIX}%')`).run();
  await env.PUBLISHED_DB.prepare(`DELETE FROM pages WHERE slug LIKE '${SLUG_PREFIX}%'`).run();
  await env.DB.prepare(`DELETE FROM pages WHERE slug LIKE '${SLUG_PREFIX}%'`).run();
  await env.DB.prepare('DELETE FROM tags WHERE id = 7401').run();
  await env.PUBLISHED_DB.prepare('DELETE FROM tags WHERE id = 7401').run();
}

beforeEach(async () => {
  clearManifestCache();
  await cleanup();
});

afterEach(cleanup);

describe('bulk publish round trips', () => {
  it('publishes a full slice in a constant number of round trips', async () => {
    const pages = await seedPages(BULK_ACTION_PAGE_LIMIT);
    const tally: RoundTrips = { draft: 0, published: 0 };

    const outcome = await applyBulkPageAction(
      countingEnv(tally),
      USER,
      'publish',
      pages.map((page) => page.id),
    );

    expect(outcome.updated).toBe(BULK_ACTION_PAGE_LIMIT);
    const total = tally.draft + tally.published;
    // Reads: the draft pages, the submission-mirror check, the tag links, the
    // live-id lookup; writes: a handful of batches. Comfortably under one per
    // page — the loop this replaced cost ~603 here.
    expect(total).toBeLessThan(25);
  });

  it('does not grow per page: 10 and 100 cost about the same', async () => {
    const costFor = async (count: number): Promise<number> => {
      await cleanup();
      const pages = await seedPages(count);
      const tally: RoundTrips = { draft: 0, published: 0 };
      await applyBulkPageAction(countingEnv(tally), USER, 'publish', pages.map((page) => page.id));
      return tally.draft + tally.published;
    };

    const small = await costFor(10);
    const large = await costFor(100);
    // Ten times the pages must not cost anywhere near ten times the trips.
    expect(large).toBeLessThan(small * 3);
  });

  it('unpublishes a full slice in a constant number of round trips', async () => {
    const pages = await seedPages(BULK_ACTION_PAGE_LIMIT);
    const ids = pages.map((page) => page.id);
    await applyBulkPageAction(env as unknown as Env, USER, 'publish', ids);

    const tally: RoundTrips = { draft: 0, published: 0 };
    const outcome = await applyBulkPageAction(countingEnv(tally), USER, 'unpublish', ids);

    expect(outcome.updated).toBe(BULK_ACTION_PAGE_LIMIT);
    expect(tally.draft + tally.published).toBeLessThan(25);
    const live = await env.PUBLISHED_DB.prepare(
      `SELECT COUNT(*) AS n FROM pages WHERE slug LIKE '${SLUG_PREFIX}%'`,
    ).first<{ n: number }>();
    expect(live?.n).toBe(0);
  });
});

describe('bulk publish results', () => {
  it('writes the same live rows and tag links a per-page publish would', async () => {
    await env.DB.prepare(
      `INSERT INTO tags (id, name, slug, weight, taxonomy_slug) VALUES (7401, 'Shared', 'bulk-shared', 2, 'category')`,
    ).run();
    const pages = await seedPages(5, 7401);

    const outcome = await publishPagesToTargets(env as unknown as Env, pages);
    expect(outcome.published).toHaveLength(5);
    expect(outcome.failures).toEqual([]);

    for (const page of pages) {
      const live = await env.PUBLISHED_DB.prepare('SELECT * FROM pages WHERE uuid = ?')
        .bind(page.uuid)
        .first<Page>();
      expect(live?.id).toBe(page.id);
      expect(live?.name).toBe(page.name);
      expect(live?.lect).toBe(page.lect);

      const links = await env.PUBLISHED_DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ?')
        .bind(page.id)
        .all<{ tag_id: number }>();
      expect(links.results.map((row) => row.tag_id)).toEqual([7401]);
    }

    // The catalogue row every one of those links points at is written once,
    // not once per page, and carries the CMS's own id.
    const catalogue = await env.PUBLISHED_DB.prepare('SELECT id, name, slug FROM tags WHERE id = 7401')
      .all<{ id: number; name: string; slug: string }>();
    expect(catalogue.results).toEqual([{ id: 7401, name: 'Shared', slug: 'bulk-shared' }]);
  });

  it('republishing a slice replaces links rather than duplicating them', async () => {
    await env.DB.prepare(
      `INSERT INTO tags (id, name, slug, weight, taxonomy_slug) VALUES (7401, 'Shared', 'bulk-shared', 2, 'category')`,
    ).run();
    const pages = await seedPages(3, 7401);

    await publishPagesToTargets(env as unknown as Env, pages);
    await publishPagesToTargets(env as unknown as Env, pages);

    const links = await env.PUBLISHED_DB.prepare(
      `SELECT COUNT(*) AS n FROM page_tags WHERE page_id IN (${pages.map(() => '?').join(',')})`,
    ).bind(...pages.map((page) => page.id)).first<{ n: number }>();
    expect(links?.n).toBe(3);
  });

  it('refuses submission mirrors without sending them to a target', async () => {
    const pages = await seedPages(3);
    await env.DB.prepare("INSERT INTO page_versions (page_id, lect, action) VALUES (?, '{}', 'ingest-submission')")
      .bind(pages[1].id)
      .run();

    const outcome = await publishPagesToTargets(env as unknown as Env, pages);

    expect(outcome.refused.map((page) => page.id)).toEqual([pages[1].id]);
    expect(outcome.published.map((page) => page.id)).toEqual([pages[0].id, pages[2].id]);
    const live = await env.PUBLISHED_DB.prepare('SELECT uuid FROM pages WHERE uuid = ?')
      .bind(pages[1].uuid)
      .first();
    expect(live).toBeNull();
  });
});

describe('r2 adapter bulk publish', () => {
  const snapshot = (uuid: string, name: string): PublishSnapshot => ({
    page: {
      id: 1, uuid, name, slug: name, weight: 5, page_type: 'default',
      lect: JSON.stringify({ name: { en: name } }),
      created_at: '', updated_at: '', start: null, end: null, timezone: null,
      page_id: null, creator: 1, editors: null,
    } as Page,
    tags: [],
    tagCatalogue: [],
    publishedAt: '2026-06-12T00:00:00.000Z',
  });

  afterEach(async () => {
    const listed = await env.MEDIA_BUCKET!.list({ prefix: 'bulk-r2/' });
    await Promise.all(listed.objects.map((object) => env.MEDIA_BUCKET!.delete(object.key)));
  });

  it('rewrites the index once for the whole slice', async () => {
    const adapter = r2Adapter(env.MEDIA_BUCKET!, 'bulk-r2/');
    const snapshots = [snapshot('r2-aaa', 'one'), snapshot('r2-bbb', 'two'), snapshot('r2-ccc', 'three')];

    await adapter.publishMany!(snapshots);

    const index = await (await env.MEDIA_BUCKET!.get('bulk-r2/index.json'))!.json<{ pages: Array<{ uuid: string }> }>();
    expect(index.pages.map((entry) => entry.uuid).sort()).toEqual(['r2-aaa', 'r2-bbb', 'r2-ccc']);
    for (const { page } of snapshots) {
      expect(await env.MEDIA_BUCKET!.get(`bulk-r2/pages/${page.uuid}.json`)).not.toBeNull();
    }

    // A second slice must replace its own entries, not append duplicates, and
    // must leave entries it did not touch alone.
    await adapter.publishMany!([snapshot('r2-aaa', 'one-again'), snapshot('r2-ddd', 'four')]);
    const after = await (await env.MEDIA_BUCKET!.get('bulk-r2/index.json'))!.json<{ pages: Array<{ uuid: string; name: string }> }>();
    expect(after.pages.map((entry) => entry.uuid).sort()).toEqual(['r2-aaa', 'r2-bbb', 'r2-ccc', 'r2-ddd']);
    expect(after.pages.find((entry) => entry.uuid === 'r2-aaa')?.name).toBe('one-again');
  });
});
