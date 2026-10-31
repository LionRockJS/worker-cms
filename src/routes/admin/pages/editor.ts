import { recordTagReads, recordTaxonomyReads } from '../../../core/http/access-log';
import { recordRead } from '../../../core/http/access-log';
// Shared editor rendering: the props the structured editor needs, plugin
// edit/new/read view delegation, and page-version helpers.

import { resolveCmsConfig } from '../../../core/db/content-config';
import { coreExtensions } from '../../../core/extensions';
import type { EditViewContext, ReadViewContext } from '../../../core/extensions';
import { stringifyLect } from '../../../core/db/lect';
import type { Lect } from '../../../core/db/lect';
import type { Page, PageVersion } from '../../../types';
import { editorsFromForm, nullableStr, num } from '../../../core/http/forms';
import { blockNamesFor, blockPropsByName, blueprintPropsFor, lectsMatch } from '../../../core/db/page-logic';
import { editorTaxonomy, parentPageOption } from '../../../core/db/admin-queries';
import { getLiveLect } from '../../../core/publish';
import { draftLectProjector } from '../../../core/publish/projection';
import type { AppContext } from '../../../core/http/context';


// survives validation re-renders and the post-save reload.
export function preferNativeEditor(c: AppContext): boolean {
  const native = (c.req.query('native') ?? '').toLowerCase();
  const editor = (c.req.query('editor') ?? '').toLowerCase();
  return native === '1' || native === 'true' || editor === 'cms' || editor === 'native';
}

/** Appends the native-editor flag to a URL when it's active (keeps `?`/`&` correct). */
export function withNativeFlag(c: AppContext, url: string): string {
  if (!preferNativeEditor(c)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}native=1`;
}

// ── Shared editor rendering ───────────────────────────────────────────────────

export type ResolvedConfig = Awaited<ReturnType<typeof resolveCmsConfig>>;

export function defaultTimezone(c: AppContext): string {
  return c.env.DEFAULT_TIMEZONE ?? '+0800';
}

/** The `structured` prop block shared by every built-in editor render. */
export function structuredEditorProps(
  config: ResolvedConfig,
  language: string,
  lect: Lect,
  pageType: string,
  versions: PageVersion[] = [],
) {
  return {
    config,
    language,
    lect,
    blueprintProps: blueprintPropsFor(config, pageType),
    blockProps: blockPropsByName(config),
    blockNames: blockNamesFor(config, pageType),
    versions,
  };
}

/** EditViewContext.page built from a submitted editor form (validation re-renders). */
export function pluginPageFromForm(
  form: FormData,
  base: { id: number | string; name: string; slug: string; pageType: string },
  lect: Lect,
  fallbackTimezone: string | null,
): EditViewContext['page'] {
  return {
    ...base,
    weight: num(form.get('weight')),
    start: nullableStr(form.get('start')),
    end: nullableStr(form.get('end')),
    timezone: nullableStr(form.get('timezone')) ?? fallbackTimezone,
    editors: editorsFromForm(form),
    lect: stringifyLect(lect),
  };
}

/** Version rows trimmed to what an external view is allowed to see. */
function viewVersions(versions: PageVersion[] = []): EditViewContext['versions'] {
  return versions.map((v) => ({ id: v.id, created_at: v.created_at, action: v.action }));
}

/**
 * Renders the edit or create form through whoever owns this page type (today,
 * the plugin platform), unless the native-editor escape hatch is active.
 * Returns null when the caller should render the built-in editor instead —
 * which is also what an install with no owner registered gets.
 */
export async function maybePluginEditView(
  c: AppContext,
  context: Omit<EditViewContext, 'versions'> & { versions?: PageVersion[] },
): Promise<Response | null> {
  if (preferNativeEditor(c)) return null;
  return coreExtensions().pageEditView?.(c, { ...context, versions: viewVersions(context.versions) }) ?? null;
}

/**
 * Renders through the owning read view, unless the native escape hatch
 * (`?native=1`) is active. Returns null when the caller should render the
 * built-in read view instead.
 */
export async function maybePluginReadView(
  c: AppContext,
  context: Omit<ReadViewContext, 'versions'> & { versions?: PageVersion[] },
): Promise<Response | null> {
  if (preferNativeEditor(c)) return null;
  return coreExtensions().pageReadView?.(c, { ...context, versions: viewVersions(context.versions) }) ?? null;
}

/**
 * Loads everything the built-in editor needs alongside a draft page row:
 * parent options, taxonomy, the requested version (preview only), recent
 * version history, which version is live, and the selected tag ids.
 *
 * `version` is non-null only when `?version=N` names a real version of this
 * page. Without it there is nothing to preview: the page's own `lect` is the
 * working copy, so callers render that rather than a snapshot. `currentVersion`
 * is the head of the history — the snapshot that mirrors `lect` — and exists
 * only so the version list can mark which entry that is.
 */
export async function editorPageData(
  c: AppContext,
  page: Page,
  parentId: string | number | null | undefined,
  requestedVersionId = NaN,
) {
  const [parentPages, taxonomy, version, versions, liveLect, pageTags, projectDraft] = await Promise.all([
    parentPageOption(c.env.DB, parentId),
    editorTaxonomy(c.env.DB),
    Number.isFinite(requestedVersionId)
      ? c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
          .bind(page.id, requestedVersionId)
          .first<PageVersion>()
      : Promise.resolve(null),
    // `rowid`, not `id`, breaks the tie: created_at is second-granularity
    // (cmsTimestamp), so a create and an update in the same second collide,
    // and `id` embeds a 16-bit random that would order them arbitrarily.
    // rowid is insert order, which is what "newest" has to mean here — the
    // head of this list is the snapshot that mirrors the page's own lect.
    c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20')
      .bind(page.id)
      .all<PageVersion>(),
    getLiveLect(c.env, page.uuid),
    c.env.DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ?')
      .bind(page.id)
      .all<{ tag_id: number }>(),
    draftLectProjector(c.env),
  ]);

  recordTagReads('tag.editor-options', taxonomy.tags);
  recordTaxonomyReads('taxonomy.editor-options', taxonomy.taxonomies);
  if (versions.results.length) recordRead({
    action: 'page.history', kind: 'page_type', key: page.page_type ?? 'default', targetType: 'page_version',
    ids: [...new Set([...versions.results.map(row => String(row.id)), ...(version ? [String(version.id)] : [])])],
    count: new Set([...versions.results.map(row => row.id), ...(version ? [version.id] : [])]).size,
    uuidById: Object.fromEntries([...versions.results, ...(version ? [version] : [])].map(row => [String(row.id), page.uuid])),
  });

  return {
    parentPages,
    taxonomy,
    version,
    // Head of the history: the same query already loaded it, newest first.
    currentVersion: versions.results[0] ?? null,
    versions: versions.results,
    // The live copy is projected at publish time, so each candidate version
    // must be projected the same way before comparing (page-logic lectsMatch
    // semantics keep byte-equality for non-projected types).
    liveVersionId: versions.results.find(
      (candidate) => lectsMatch(projectDraft({ page_type: page.page_type, lect: candidate.lect }), liveLect),
    )?.id,
    isPublished: liveLect !== null,
    isLiveSynced: liveLect !== null
      && lectsMatch(projectDraft({ page_type: page.page_type, lect: page.lect }), liveLect),
    selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
  };
}

/**
 * Removes one snapshot from a page's history. The page's own `lect` is
 * untouched — deleting a version, including the newest one, never changes
 * what is being edited or what would be published.
 */
export async function deletePageVersion(db: D1DatabaseClient, page: Page, versionId: number): Promise<boolean> {
  const version = await db.prepare('SELECT id FROM page_versions WHERE page_id = ? AND id = ?')
    .bind(page.id, versionId)
    .first<{ id: number }>();
  if (!version) return false;

  await db.prepare('DELETE FROM page_versions WHERE page_id = ? AND id = ?')
    .bind(page.id, versionId)
    .run();

  return true;
}
