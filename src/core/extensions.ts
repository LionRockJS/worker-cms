// Extension points core offers to droppable platform features.
//
// Core used to reach into src/plugins directly — the chrome asked it for
// sidebar entries, publish asked it for extra targets, the job runner asked it
// to deliver hooks. That made the plugin platform impossible to remove: core
// would not compile without it.
//
// Now the dependency runs the other way. Core declares what it will call if
// someone provides it; a feature registers an implementation at module load.
// Nothing registered means the extension point is simply inert, which is
// exactly what a build without that feature should do.
//
// Registration happens while modules are evaluating, before any request is
// served, so a handler is always in place by the time a route runs.

import type { Env } from '../types';
import type { JWTPayload } from '../types';
import type { AppContext } from './http/context';
import type { PublishAdapter } from './publish/adapter';
import type { PublishLectRule } from './publish/projection';
import type { BulkPageAction } from './pages/bulk-action';
import type { AdvancedSearchCriterion, AdvancedSearchOperator } from './db/search';

/** A sidebar entry contributed at runtime rather than declared in code. */
export interface ContributedNavItem {
  pluginId: string;
  label: string;
  href: string;
  roles?: string[];
  /** Any one grants this navigation item to a non-admin user. An empty list
   *  keeps the contribution admin-only. */
  permissions?: string[];
  group?: 'settings';
  i18n: boolean;
}

/** A content-type fragment contributed at runtime. */
export interface ContributedContentTypes {
  blueprint?: Record<string, unknown[]>;
  blocks?: Record<string, unknown[]>;
  blockLists?: Record<string, string[]>;
  taxonomies?: Record<string, string>;
  taxonomyLists?: Record<string, string[]>;
}

/**
 * One contributor's claim over content-type slugs, for the admin type
 * listings. Structural on purpose: core must not know what a plugin is.
 */
export interface ContentTypeContributorInfo {
  /** Display name shown in the listing's source column. */
  name: string;
  /** The slug maps this contributor declares. */
  contentTypes?: ContributedContentTypes;
}

/** A page the editor is about to create, for the create-limit check. */
export interface PageCreateCandidate {
  pageType: string;
  parentId: number | null;
  /** The submitted translation, used by per-lect limits. */
  lect?: unknown;
}

/** Data a plugin-owned editor view is rendered from. */
export interface EditViewContext {
  /** 'new' for the create form, 'edit' for an existing page. */
  mode: 'new' | 'edit';
  /** Form POST target — the CMS's existing create/update handler. */
  action: string;
  /** Where the editor's back / cancel control should return to. */
  backHref: string;
  /** Active editing language. */
  language: string;
  /** Signed-in user's CMS interface locale (added by the dispatcher). */
  uiLocale?: string;
  /** Text direction for uiLocale. */
  uiDirection?: 'ltr' | 'rtl';
  /** The page type being edited or created. */
  pageType: string;
  page: {
    /** Numeric id when editing; '' when creating. */
    id: number | string;
    name: string;
    slug: string;
    pageType: string;
    weight: number;
    start: string | null;
    end: string | null;
    timezone: string | null;
    editors: string | null;
    /** Stringified lect JSON for the current/selected version. */
    lect: string;
  };
  /** Saved versions (most-recent first), for an optional version picker. */
  versions: Array<{ id: number; created_at: string; action: string | null }>;
  /** Flash message to surface, if any. */
  flash?: string;
  /** Validation errors to surface when re-rendering after a failed save. */
  errors?: string[];
}

/** Read-only twin of EditViewContext — no form to POST, plus an edit link. */
export interface ReadViewContext {
  /** Link to the CMS editor for this page (for an optional "Edit" control). */
  editHref: string;
  /** Where the view's back / cancel control should return to. */
  backHref: string;
  /** Active display language. */
  language: string;
  /** Signed-in user's CMS interface locale (added by the dispatcher). */
  uiLocale?: string;
  /** Text direction for uiLocale. */
  uiDirection?: 'ltr' | 'rtl';
  /** The page type being viewed. */
  pageType: string;
  page: EditViewContext['page'];
  /** Saved versions (most-recent first), for an optional version picker. */
  versions: EditViewContext['versions'];
}

/** Deep links into whoever owns CSV import/export. Empty strings hide the control. */
export interface ImportExportHrefs {
  importHref: string;
  exportHref: string;
  /** Export of the current advanced-search result set. */
  searchExportHref: string;
}

/** A permission declared outside the built-in set, for the role editor. */
export interface ContributedPermission {
  value: string;
  label: string;
}

/** A quota a contributor declares, resolved to its effective value. For the
 *  cross-contributor summary; whoever owns the quotas enforces them. */
export interface ContributedLimitSummary {
  contributorId: string;
  contributorLabel: string;
  key: string;
  label: string;
  description: string;
  scope: 'total' | 'per_parent' | 'per_pointer' | 'per_second';
  /** Set when scope is 'per_pointer'. */
  pointerKey?: string;
  /** null means unlimited. */
  value: number | null;
  /** Where an admin configures this quota. */
  manageHref: string;
}

/**
 * The queue message body a durable background job is announced with. Core
 * declares the wire shape because the Worker's `queue()` handler and the
 * ADMIN_JOBS_QUEUE binding type are part of the entrypoint, which cannot be
 * contributed by a feature — only the handling of the message can.
 */
export interface CmsAdminJobMessage {
  kind: 'cms_admin_job';
  jobId: string;
}

/** A recorded admin request to replay in the background. */
export interface QueuedAdminAction {
  contributorId: string;
  method: string;
  path: string;
  contentType: string | null;
  body: string;
}

/** A bulk page action to run in the background. */
export interface QueuedBulkAction {
  action: BulkPageAction;
  /** 'all' resolves the target ids from the criteria when the job first runs. */
  scope: 'selected' | 'all';
  ids: number[];
  pageTypes: string[];
  criteria: AdvancedSearchCriterion[];
  operator: AdvancedSearchOperator;
  status?: 'draft' | 'scheduled' | 'live' | 'ended';
  /** Tag ids to add or remove when `action` is a tag action. */
  targetTagIds?: number[];
  /** Literal, case-sensitive draft-content replacement values. */
  searchText?: string;
  replacementText?: string;
  /** Where the finished job sends the browser back to. */
  returnTo: string;
}

/** An authenticated inbound API caller (today, a plugin Worker). */
export interface ApiCallerIdentity {
  /** The contributor id this request is authenticated as. */
  callerId: string;
}

/** Page lifecycle events core announces to whoever is listening. */
export type PageEvent = 'create' | 'submission' | 'update' | 'publish' | 'unpublish' | 'delete';

/** The subset of a page that a listener is given. */
export interface PageEventPage {
  id: number;
  uuid?: string;
  page_type?: string | null;
  name?: string;
  slug?: string;
}

export interface CoreExtensions {
  /**
   * Publish targets beyond the built-in d1/r2 adapters. The plugin platform
   * contributes one per plugin whose manifest declares `publishTarget`.
   */
  publishAdapters?(env: Env): Promise<PublishAdapter[]>;
  /** Sidebar entries to append to the ones core declares. */
  sidebarNav?(env: Env): Promise<ContributedNavItem[]>;
  /**
   * UI-string catalogs merged *under* the core ones, so a contributed string
   * never overrides a CMS string or a database override.
   */
  localeCatalog?(env: Env, localeCode: string): Promise<Record<string, string>>;
  /**
   * Content-type fragments merged between the compiled base config and the
   * database layer, so a database page type still overrides a contributed one.
   */
  contentTypes?(env: Env): Promise<ContributedContentTypes[]>;
  /** Per-page-type rules for what survives publication. */
  lectRules?(env: Env): Promise<Record<string, PublishLectRule>>;
  /** Announce a page lifecycle event. Must never throw or block the response. */
  notifyPageEvent?(env: Env, user: JWTPayload | undefined, event: PageEvent, pages: PageEventPage[]): Promise<void>;
  /**
   * Perform a queued `plugin_admin_action` job: forward the recorded request
   * to the plugin that owns it. Resolves with the response status and any
   * Location header; throws to fail the job.
   */
  runPluginAction?(env: Env, job: PluginActionJob): Promise<{ status: number; location: string | null }>;
  /**
   * A view source that resolves feature-owned Liquid templates after the CMS's
   * own assets. Core falls back to env.VIEWS, so an install without a
   * contributor reads templates straight from the bundle.
   */
  viewSource?(env: Env): Fetcher;
  /** Who else declares content types, for the admin type listings. */
  contentTypeContributors?(env: Env): Promise<ContentTypeContributorInfo[]>;
  /**
   * True when this page type is republished automatically after a save. Core
   * only ever republishes a page that is already live.
   */
  autoPublishesPageType?(env: Env, pageType: string): Promise<boolean>;
  /**
   * Per-type create limits. Resolves to a ready-to-show message when a
   * candidate is refused, or null when every candidate may be created.
   */
  checkCreateLimits?(env: Env, candidates: readonly PageCreateCandidate[]): Promise<string | null>;
  /**
   * Where the dashboard's Import/Export buttons and the advanced-search CSV
   * export point. Empty hrefs hide the controls, which is what an install
   * without the owning feature gets.
   */
  importExportHrefs?(env: Env, pageType?: string): Promise<ImportExportHrefs>;
  /**
   * Render the create/edit form through whoever owns this page type. Null
   * means core should render its own editor.
   */
  pageEditView?(c: AppContext, context: EditViewContext): Promise<Response | null>;
  /** As pageEditView, for the read-only view. */
  pageReadView?(c: AppContext, context: ReadViewContext): Promise<Response | null>;
  /** Permissions declared outside the built-in set, for the role editor. */
  contributedPermissions?(env: Env): Promise<ContributedPermission[]>;
  /** Declared quotas with their effective values, for the summary screen. */
  limitSummaries?(env: Env): Promise<ContributedLimitSummary[]>;
  /**
   * Authenticate an inbound contributor API request. Returns the caller, or a
   * Response to send back verbatim when authentication fails. Unregistered
   * means the endpoint has no way to identify callers and must 404.
   */
  authenticateApiCaller?(c: AppContext): Promise<ApiCallerIdentity | Response>;
  /** The user a contributor is acting on behalf of, from the request headers. */
  actingUserId?(c: AppContext): number | null;
  /**
   * Handle one queue message. Returns true when it was recognised and run,
   * false when it belongs to something else. Unregistered means this Worker
   * has no durable job runner, so a stray message is simply acknowledged.
   */
  handleQueueMessage?(env: Env, body: unknown): Promise<boolean>;
  /**
   * Record and queue an admin request to replay in the background, returning
   * true when it was accepted. False (or unregistered) means the caller must
   * do the work inline — no durable runner, or no queue binding.
   */
  enqueueAdminAction?(c: AppContext, input: QueuedAdminAction): Promise<boolean>;
  /**
   * Record and queue a bulk page action, returning true when it was accepted.
   * False (or unregistered) means the caller must run it inline.
   */
  enqueueBulkAction?(c: AppContext, input: QueuedBulkAction): Promise<boolean>;
}

/** The recorded request a `plugin_admin_action` job replays. */
export interface PluginActionJob {
  pluginId: string;
  method: string;
  path: string;
  contentType: string | null;
  body: string | null;
  user: { sub: string | number; email: string; name: string; role: string };
}

let registered: CoreExtensions = {};

/**
 * Called once at module load by whichever feature provides these. Merging
 * rather than replacing lets more than one feature contribute.
 */
export function registerCoreExtensions(extensions: CoreExtensions): void {
  registered = { ...registered, ...extensions };
}

/** The currently registered extensions; empty when no feature provides them. */
export function coreExtensions(): Readonly<CoreExtensions> {
  return registered;
}

/** Test seam: drops every registration. */
export function resetCoreExtensions(): void {
  registered = {};
}
