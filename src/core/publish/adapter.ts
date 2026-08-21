// ============================================================
// Publish adapter contract.
//
// Publishing fans a draft snapshot out to one or more targets
// (D1 database, static JSON in R2, plugin Workers → IPFS, …).
// Each target implements this interface; the registry in
// ./index.ts builds the snapshot once and orchestrates the rest.
// ============================================================

import type { Page } from '../../types';

/** A published tag link, denormalized so write-only targets (R2 JSON, plugins)
 *  can emit self-contained documents without a database to join against. */
export interface PublishSnapshotTag {
  uuid: string;
  tag_id: number;
  weight: number;
  slug: string | null;
  name: string | null;
}

/** A tag as the publish path hands it over: the CMS row minus its bookkeeping
 *  columns, which each target mints for itself. Targets that keep a tag
 *  catalogue (D1) store it; write-only targets get the same fields inlined on
 *  every page's tag links and can ignore this. */
export interface PublishedTag {
  id: number;
  uuid: string;
  name: string;
  slug: string;
  weight: number;
  taxonomy_slug: string | null;
  parent_tag: number | null;
  lect: string | null;
}

/** Everything a target needs to materialize one published page. */
export interface PublishSnapshot {
  page: Page;
  tags: PublishSnapshotTag[];
  /**
   * The distinct tag rows behind `tags`, so a target that stores a catalogue
   * (D1) can upsert the tags and the links in one publish and never serve a
   * link whose id resolves to nothing. Empty when the page has no tags — or
   * when the CMS's own tags table is too old to answer for them.
   */
  tagCatalogue: PublishedTag[];
  publishedAt: string;
}

/** Minimal live-page projection the admin UI uses for publish-status badges. */
export interface LivePageSnapshot {
  uuid: string;
  lect: string | null;
  weight: number;
  /** Schedule metadata is optional for third-party read adapters. */
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
}

export interface PublishAdapter {
  /** Stable identifier used in logs and partial-failure flash messages. */
  id: string;

  /** Create or replace the published copy of a page. Throw on failure. */
  publish(snapshot: PublishSnapshot): Promise<void>;

  /** Optional: create or replace many published copies in one shot. Targets that
   *  can write in bulk (D1 by folding the whole slice into batched statements,
   *  R2 by rewriting its index once instead of once per page) implement this;
   *  the registry falls back to publish() per snapshot for targets that can't
   *  (e.g. plugin targets, which POST one page at a time). Throw on failure.
   *
   *  Snapshots are applied in the order given, and the batched form is NOT
   *  atomic across the whole slice — same as calling publish() in a loop. */
  publishMany?(snapshots: PublishSnapshot[]): Promise<void>;

  /** Remove the published copy of a page. Throw on failure. */
  unpublish(uuid: string): Promise<void>;

  /** Optional: remove many published copies in one shot. Targets that can delete
   *  in bulk (D1 via a single batch, R2 via a multi-key delete) implement this;
   *  the registry falls back to unpublish() per uuid for targets that can't
   *  (e.g. plugin targets). Throw on failure. */
  unpublishMany?(uuids: string[]): Promise<void>;

  /** Optional: create or replace the published copy of one or more tags, so a
   *  rename or a re-grouping reaches readers without republishing every page
   *  that uses the tag. Called with a single tag on admin edits and with a
   *  batch by the resync action; targets that keep no catalogue omit it.
   *  Throw on failure. */
  publishTags?(tags: PublishedTag[]): Promise<void>;

  /** Optional: drop a deleted tag from published content — its links, and the
   *  catalogue row for targets that keep one. Targets that can't do this
   *  cheaply may omit it — stale tags clear on the next publish. */
  removeTag?(tagId: number): Promise<void>;

  // ── Live-state reads ─────────────────────────────────────────────────────
  // Optional; only the first adapter that implements them serves the admin UI
  // (publish badges, live-vs-draft diffing). Write-only targets omit them.

  getLiveLect?(uuid: string): Promise<string | null>;
  liveMap?(uuids: string[]): Promise<Map<string, LivePageSnapshot>>;
  listLiveByTypes?(pageTypes: string[]): Promise<LivePageSnapshot[]>;
}
