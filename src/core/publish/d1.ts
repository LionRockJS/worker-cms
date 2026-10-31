// ============================================================
// D1 publish target — the original publish flow, packaged as an
// adapter. Upserts into the published database's pages /
// page_tags / tags and serves the admin UI's live-state reads.
// ============================================================

import type { LivePageSnapshot, PublishAdapter, PublishSnapshot, PublishedTag } from './adapter';

/** Internal projections only: capture taxonomy provenance with the source row,
 * keeping audit-only metadata separate from the caller's returned columns. */
export async function readD1PageSource<T extends { uuid: string; page_type?: string | null }>(
  db: D1DatabaseClient, projection: 'identity' | 'live' | 'submission' | 'full', where: string, params: unknown[], order = '',
): Promise<{ rows: T[]; provenance: Pick<LivePageSnapshot, 'uuid' | 'page_type' | 'taxonomy_slugs'>[] }> {
  const columns = {
    identity: 'p.uuid, p.page_type',
    live: 'p.uuid, p.page_type, p.lect, p.weight, p.start, p.end, p.timezone',
    submission: 'p.uuid, p.created_at, p.name, p.slug, p.weight, p.start, p.end, p.timezone, p.page_type, p.lect, p.page_id',
    full: 'p.*',
  }[projection];
  const result = await db.prepare(`SELECT ${columns},
    (SELECT json_group_array(CASE WHEN t.id IS NULL THEN NULL ELSE COALESCE(t.taxonomy_slug, 'default') END)
     FROM page_tags pt LEFT JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id) AS taxonomy_json
    FROM pages p WHERE ${where} ${order}`).bind(...params).all<T & { taxonomy_json: string }>();
  const provenance: Pick<LivePageSnapshot, 'uuid' | 'page_type' | 'taxonomy_slugs'>[] = [];
  const rows = result.results.map(({ taxonomy_json, ...row }) => {
    const keys: unknown = JSON.parse(taxonomy_json);
    provenance.push({ uuid: row.uuid, page_type: row.page_type,
      taxonomy_slugs: Array.isArray(keys) && keys.every(key => typeof key === 'string' && key.length > 0) ? [...new Set(keys as string[])] : undefined });
    // The reserved query-only column has been removed; SQL owns the projection.
    return row as unknown as T;
  });
  return { rows, provenance };
}

/** Statements per batched round-trip, under D1's 100-statement cap. A tag
 *  costs two of them (the conflict sweep and the upsert). */
const BATCH_CHUNK = 90;

/** Uuids per live-id lookup, under D1's cap on bound parameters. */
const ID_LOOKUP_CHUNK = 90;

export function d1Adapter(publishedDb: D1DatabaseClient): PublishAdapter {
  async function liveRows(where: string, params: string[]): Promise<LivePageSnapshot[]> {
    const source = await readD1PageSource<LivePageSnapshot>(publishedDb, 'live', where, params);
    return source.rows.map((row, index) => ({ ...row, taxonomy_slugs: source.provenance[index].taxonomy_slugs }));
  }

  /** The pair of statements that makes one catalogue row match `DB.tags`,
   *  ids included — a published link is only resolvable if the id agrees. */
  const catalogueStatements = (tag: PublishedTag): D1PreparedStatement[] => [
    // The whole tag catalogue is CMS-owned — nothing else writes it — so a row
    // holding this tag's id or slug under a different uuid is a stale mirror,
    // not someone else's data. Clearing it first keeps the upsert from tripping
    // the id/slug unique constraints, which ON CONFLICT(uuid) cannot catch.
    publishedDb.prepare('DELETE FROM tags WHERE (id = ? OR slug = ?) AND uuid <> ?')
      .bind(tag.id, tag.slug, tag.uuid),
    publishedDb.prepare(
      `INSERT INTO tags (id, uuid, name, slug, weight, taxonomy_slug, parent_tag, lect)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         id = excluded.id,
         name = excluded.name,
         slug = excluded.slug,
         weight = excluded.weight,
         taxonomy_slug = excluded.taxonomy_slug,
         parent_tag = excluded.parent_tag,
         lect = excluded.lect`,
    ).bind(
      tag.id,
      tag.uuid,
      tag.name,
      tag.slug,
      tag.weight,
      tag.taxonomy_slug,
      tag.parent_tag,
      tag.lect,
    ),
  ];

  /** Runs statements in batches, one round-trip per chunk. */
  const runBatched = async (statements: D1PreparedStatement[]): Promise<void> => {
    for (let index = 0; index < statements.length; index += BATCH_CHUNK) {
      await publishedDb.batch(statements.slice(index, index + BATCH_CHUNK));
    }
  };

  /** Upserts the live page row, ids included, so a republish under the same
   *  uuid lands on the same row whatever its previous id was. */
  const pageStatement = (page: PublishSnapshot['page']): D1PreparedStatement => publishedDb.prepare(
    `INSERT INTO pages (id, uuid, name, slug, weight, start, end, timezone, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       id = excluded.id,
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       timezone = excluded.timezone,
       page_type = excluded.page_type,
       lect = excluded.lect,
       page_id = excluded.page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  ).bind(
    page.id,
    page.uuid,
    page.name,
    page.slug,
    page.weight,
    page.start,
    page.end,
    page.timezone,
    page.page_type,
    page.lect,
    page.page_id,
    page.creator,
    page.editors,
  );

  const linkStatement = (pageId: number, tag: PublishSnapshot['tags'][number]): D1PreparedStatement => (
    publishedDb.prepare('INSERT INTO page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)')
      .bind(tag.uuid, pageId, tag.tag_id, tag.weight)
  );

  /**
   * Runs groups of statements, packing as many whole groups into each batch as
   * the statement cap allows. A group never straddles two round trips unless it
   * is larger than the cap on its own, so a failure part way through a slice
   * leaves whole pages written or not written — never a page stripped of its
   * tag links and not given them back.
   */
  const runGrouped = async (groups: D1PreparedStatement[][]): Promise<void> => {
    let pending: D1PreparedStatement[] = [];
    for (const group of groups) {
      if (!group.length) continue;
      if (group.length > BATCH_CHUNK) {
        // One page with more links than a batch can hold: flush what we have,
        // then split this group alone (the per-page path split it too).
        await runBatched(pending);
        pending = [];
        await runBatched(group);
        continue;
      }
      if (pending.length + group.length > BATCH_CHUNK) {
        await runBatched(pending);
        pending = [];
      }
      pending.push(...group);
    }
    await runBatched(pending);
  };

  /**
   * Writes a whole slice in two phases:
   *
   *   1. the tag catalogue, deduplicated across the slice
   *   2. per page — clear its existing links, upsert the row, insert the links
   *
   * Catalogue first means a reader never sees a link whose tag id resolves to
   * nothing, which is the guarantee the per-page path gives. Grouping phase 2
   * by page means a slice that fails part way is a prefix of published pages,
   * not a page in a half-written state.
   */
  const writeSlice = async (snapshots: PublishSnapshot[]): Promise<void> => {
    if (!snapshots.length) return;

    // One read for the whole slice: a live row under this uuid may carry an id
    // other than the draft's, and its links are keyed by that older id.
    const uuids = snapshots.map((snapshot) => snapshot.page.uuid);
    const existingIds = new Map<string, number>();
    for (let index = 0; index < uuids.length; index += ID_LOOKUP_CHUNK) {
      const chunk = uuids.slice(index, index + ID_LOOKUP_CHUNK);
      const { results } = await publishedDb.prepare(
        `SELECT id, uuid FROM pages WHERE uuid IN (${chunk.map(() => '?').join(',')})`,
      ).bind(...chunk).all<{ id: number; uuid: string }>();
      for (const row of results) existingIds.set(row.uuid, row.id);
    }

    // Pages in one slice routinely share tags; the catalogue pair only has to
    // run once per tag, not once per page that links it.
    const catalogue = new Map<string, PublishedTag>();
    for (const { tagCatalogue } of snapshots) {
      for (const tag of tagCatalogue) if (!catalogue.has(tag.uuid)) catalogue.set(tag.uuid, tag);
    }
    await runGrouped([...catalogue.values()].map(catalogueStatements));

    await runGrouped(snapshots.map(({ page, tags }) => {
      const staleId = existingIds.get(page.uuid);
      return [
        ...(staleId !== undefined && staleId !== page.id
          ? [publishedDb.prepare('DELETE FROM page_tags WHERE page_id = ?').bind(staleId)]
          : []),
        publishedDb.prepare('DELETE FROM page_tags WHERE page_id = ?').bind(page.id),
        pageStatement(page),
        ...tags.map((tag) => linkStatement(page.id, tag)),
      ];
    }));
  };

  return {
    id: 'd1',

    async publish(snapshot: PublishSnapshot): Promise<void> {
      await writeSlice([snapshot]);
    },

    async publishMany(snapshots: PublishSnapshot[]): Promise<void> {
      await writeSlice(snapshots);
    },

    async unpublish(uuid: string): Promise<void> {
      const livePage = await publishedDb.prepare('SELECT id FROM pages WHERE uuid = ?')
        .bind(uuid)
        .first<{ id: number }>();
      if (livePage) {
        await publishedDb.prepare('DELETE FROM page_tags WHERE page_id = ?').bind(livePage.id).run();
      }

      await publishedDb.prepare('DELETE FROM pages WHERE uuid = ?')
        .bind(uuid)
        .run();
    },

    async unpublishMany(uuids: string[]): Promise<void> {
      // Collapse a whole slice into two statements (tags, then pages) in one
      // batch round-trip. Chunk to stay under D1's bound-parameter cap; callers
      // already pass bounded slices, this is a reuse-safe guard.
      const unique = Array.from(new Set(uuids));
      for (let index = 0; index < unique.length; index += 90) {
        const chunk = unique.slice(index, index + 90);
        const placeholders = chunk.map(() => '?').join(',');
        await publishedDb.batch([
          publishedDb.prepare(
            `DELETE FROM page_tags WHERE page_id IN (SELECT id FROM pages WHERE uuid IN (${placeholders}))`,
          ).bind(...chunk),
          publishedDb.prepare(`DELETE FROM pages WHERE uuid IN (${placeholders})`).bind(...chunk),
        ]);
      }
    },

    async publishTags(tags: PublishedTag[]): Promise<void> {
      await runBatched(tags.flatMap(catalogueStatements));
    },

    async removeTag(tagId: number): Promise<void> {
      await publishedDb.batch([
        publishedDb.prepare('DELETE FROM page_tags WHERE tag_id = ?').bind(tagId),
        publishedDb.prepare('DELETE FROM tags WHERE id = ?').bind(tagId),
        // A child left pointing at the deleted parent would resolve to nothing;
        // DB.tags clears the same column under its ON DELETE SET NULL.
        publishedDb.prepare('UPDATE tags SET parent_tag = NULL WHERE parent_tag = ?').bind(tagId),
      ]);
    },

    async getLiveLect(uuid: string): Promise<string | null> {
      const row = await publishedDb.prepare('SELECT lect FROM pages WHERE uuid = ?')
        .bind(uuid)
        .first<{ lect: string | null }>();
      return row?.lect ?? null;
    },

    async liveMap(uuids: string[]): Promise<Map<string, LivePageSnapshot>> {
      if (!uuids.length) return new Map();
      const placeholders = uuids.map(() => '?').join(',');
      const pages = await liveRows(`p.uuid IN (${placeholders})`, uuids);
      return new Map(pages.map((page) => [page.uuid, page]));
    },

    async listLiveByTypes(pageTypes: string[]): Promise<LivePageSnapshot[]> {
      if (!pageTypes.length) return [];
      const placeholders = pageTypes.map(() => '?').join(',');
      return liveRows(`p.page_type IN (${placeholders})`, pageTypes);
    },
  };
}
