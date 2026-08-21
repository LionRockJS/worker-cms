// ============================================================
// R2 publish target — materializes published content as static
// JSON objects so a bucket (optionally fronted by a custom
// domain / CDN) can serve the site with no database at all.
//
// Layout inside the bucket (under an optional key prefix):
//   pages/<uuid>.json  full page snapshot, lect parsed to JSON
//   index.json         light listing of every live page
//
// Writes are last-publish-wins; concurrent publishes can race on
// index.json, which self-heals on the next publish/unpublish.
// ============================================================

import type { LivePageSnapshot, PublishAdapter, PublishSnapshot } from './adapter';
import { safeParseLect } from '../db/lect';

interface IndexEntry {
  uuid: string;
  name: string;
  slug: string;
  page_type: string | null;
  weight: number;
  published_at: string;
}

interface PublishIndex {
  generated_at: string;
  pages: IndexEntry[];
}

const JSON_HEADERS = { httpMetadata: { contentType: 'application/json; charset=utf-8' } };

export function r2Adapter(bucket: R2Bucket, prefix = ''): PublishAdapter {
  const pageKey = (uuid: string) => `${prefix}pages/${uuid}.json`;
  const indexKey = `${prefix}index.json`;

  async function readIndex(): Promise<PublishIndex> {
    const object = await bucket.get(indexKey);
    if (!object) return { generated_at: new Date().toISOString(), pages: [] };
    try {
      return (await object.json()) as PublishIndex;
    } catch {
      return { generated_at: new Date().toISOString(), pages: [] };
    }
  }

  async function writeIndex(pages: IndexEntry[]): Promise<void> {
    const index: PublishIndex = { generated_at: new Date().toISOString(), pages };
    await bucket.put(indexKey, JSON.stringify(index), JSON_HEADERS);
  }

  async function readPage(uuid: string): Promise<Record<string, unknown> | null> {
    const object = await bucket.get(pageKey(uuid));
    if (!object) return null;
    try {
      return (await object.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async function liveMap(uuids: string[]): Promise<Map<string, LivePageSnapshot>> {
    const entries = await Promise.all(
      uuids.map(async (uuid): Promise<[string, LivePageSnapshot] | null> => {
        const document = await readPage(uuid);
        if (!document) return null;
        return [uuid, {
          uuid,
          lect: document.lect === undefined || document.lect === null ? null : JSON.stringify(document.lect),
          weight: typeof document.weight === 'number' ? document.weight : 0,
          start: typeof document.start === 'string' ? document.start : null,
          end: typeof document.end === 'string' ? document.end : null,
          timezone: typeof document.timezone === 'string' ? document.timezone : null,
        }];
      }),
    );
    return new Map(entries.filter((entry): entry is [string, LivePageSnapshot] => entry !== null));
  }

  /** The self-contained JSON object a reader fetches for one page. */
  function pageDocument({ page, tags, publishedAt }: PublishSnapshot): Record<string, unknown> {
    return {
      uuid: page.uuid,
      name: page.name,
      slug: page.slug,
      weight: page.weight,
      start: page.start,
      end: page.end,
      timezone: page.timezone,
      page_type: page.page_type,
      lect: safeParseLect(page.lect),
      tags: tags.map((tag) => ({ uuid: tag.uuid, tag_id: tag.tag_id, weight: tag.weight, slug: tag.slug, name: tag.name })),
      published_at: publishedAt,
    };
  }

  /** That page's line in the listing every reader starts from. */
  function indexEntry({ page, publishedAt }: PublishSnapshot): IndexEntry {
    return {
      uuid: page.uuid,
      name: page.name,
      slug: page.slug,
      page_type: page.page_type,
      weight: page.weight,
      published_at: publishedAt,
    };
  }

  async function publishSlice(snapshots: PublishSnapshot[]): Promise<void> {
    if (!snapshots.length) return;
    // The page objects are the payload — one PUT each is irreducible. The index
    // is not: read-modify-writing it per page moved the entire live listing
    // across the wire twice for every page in the slice, so a bulk publish cost
    // O(slice x site). Once for the whole slice is enough.
    await Promise.all(snapshots.map((snapshot) => bucket.put(
      pageKey(snapshot.page.uuid),
      JSON.stringify(pageDocument(snapshot)),
      JSON_HEADERS,
    )));

    const entries = snapshots.map(indexEntry);
    const replacing = new Set(entries.map((entry) => entry.uuid));
    const index = await readIndex();
    await writeIndex([...index.pages.filter((existing) => !replacing.has(existing.uuid)), ...entries]);
  }

  return {
    id: 'r2',

    async publish(snapshot: PublishSnapshot): Promise<void> {
      await publishSlice([snapshot]);
    },

    publishMany: publishSlice,

    async unpublish(uuid: string): Promise<void> {
      await bucket.delete(pageKey(uuid));
      const index = await readIndex();
      await writeIndex(index.pages.filter((existing) => existing.uuid !== uuid));
    },

    async unpublishMany(uuids: string[]): Promise<void> {
      const unique = Array.from(new Set(uuids));
      if (!unique.length) return;
      // R2 delete takes up to 1000 keys per call; rewrite the index just once.
      for (let index = 0; index < unique.length; index += 1000) {
        await bucket.delete(unique.slice(index, index + 1000).map(pageKey));
      }
      const removing = new Set(unique);
      const index = await readIndex();
      await writeIndex(index.pages.filter((existing) => !removing.has(existing.uuid)));
    },

    // removeTag is intentionally omitted: rewriting every page object on tag
    // deletion is unbounded; stale tag links clear when a page republishes.

    async getLiveLect(uuid: string): Promise<string | null> {
      const document = await readPage(uuid);
      if (!document || document.lect === undefined || document.lect === null) return null;
      return JSON.stringify(document.lect);
    },

    liveMap,

    async listLiveByTypes(pageTypes: string[]): Promise<LivePageSnapshot[]> {
      const index = await readIndex();
      const uuids = index.pages
        .filter((entry) => pageTypes.includes(entry.page_type ?? ''))
        .map((entry) => entry.uuid);
      return Array.from((await liveMap(uuids)).values());
    },
  };
}
