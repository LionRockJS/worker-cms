// ============================================================
// Shared TypeScript types
// ============================================================

import type { CmsAdminJobMessage } from './core/extensions';

declare global {
  /** Query surface shared by a raw D1 binding and a D1 Sessions API client. */
  type D1DatabaseClient = Pick<D1DatabaseSession, 'prepare' | 'batch'>;
}

export const USER_ROLES = ['admin', 'editor', 'moderator', 'viewer'] as const;

export type UserRole = typeof USER_ROLES[number];

// ── Capability-based authorization ────────────────────────────────────────────
// Roles are mapped to a least-privilege set of capabilities; routes require a
// specific capability rather than just "is an editor". See utils/roles.ts.
export const PERMISSIONS = [
  'content:read',     // view draft page metadata and editor-side read APIs
  'content:write',    // create / edit pages, weight, page-tag associations
  'content:publish',  // publish / unpublish
  'content:delete',   // move a page to trash (soft delete)
  'content:import',   // CSV / JSON bulk import
  'trash:restore',    // restore a page from trash
  'trash:purge',      // permanently delete from trash (destructive)
  'tag:write',        // create / edit / delete tags (terms)
  'taxonomy:write',   // create / edit / delete taxonomies
  'media:upload',     // upload media to R2
  'plugin:access',    // reach the plugin admin proxy (with the plugin's own permission)
  'plugin:manage',    // register / enable / disable / configure plugins
  'menu:manage',      // configure admin system/menu settings
  'pagetype:write',   // create / edit / delete database-defined page types
  'blocktype:write',  // create / edit / delete database-defined block types
  'users:manage',     // view users and assign their roles
  'roles:manage',     // create / edit / delete roles and their permissions
  'credits:share',    // transfer a shared wallet balance to a user
] as const;

export type Permission = typeof PERMISSIONS[number];

/** Human-readable descriptions for the Roles admin permission picker. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'content:read': 'View draft content metadata',
  'content:write': 'Create and edit pages',
  'content:publish': 'Publish and unpublish pages',
  'content:delete': 'Move pages to trash',
  'content:import': 'Bulk import (CSV / JSON)',
  'trash:restore': 'Restore pages from trash',
  'trash:purge': 'Permanently delete from trash',
  'tag:write': 'Create and edit tags',
  'taxonomy:write': 'Manage taxonomies',
  'media:upload': 'Upload media',
  'plugin:access': 'Reach plugin admin pages (with that plugin\'s own permission)',
  'plugin:manage': 'Register and configure plugins',
  'menu:manage': 'Manage system settings',
  'pagetype:write': 'Manage page types',
  'blocktype:write': 'Manage block types',
  'users:manage': 'Manage users and their roles',
  'roles:manage': 'Manage roles and permissions',
  'credits:share': 'Transfer a shared wallet balance to a user',
};

export interface User {
  id: number;
  oauth_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: string;
}

// Access token – short-lived (15 min)
// Refresh token – long-lived (7 days), also stored in DB for revocation
export interface JWTPayload {
  sub: string;         // user id
  email: string;
  name: string;
  role: string;
  type: 'access' | 'refresh' | 'oauth_state'; // 'oauth_state' = short-lived PKCE state cookie, never an auth token
  jti?: string;        // unique token id (refresh tokens only)
  iss?: string;        // always set by signJWT; verified on every token
  aud?: string;        // always set by signJWT; verified on every token
  exp: number;
  iat: number;
}

export interface Page {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  /** IANA timezone name (e.g. 'Asia/Hong_Kong') for the start/end window. */
  timezone: string | null;
  page_type: string | null;
  /**
   * The working copy, and the source of truth for a draft. `page_versions`
   * holds append-only snapshots; its newest row mirrors this value.
   */
  lect: string | null;
  page_id: number | null;
  /** Original draft parent id retained while a child page sits in trash. */
  source_page_id?: number | null;
  creator: number | null;
  editors: string | null;
}

export interface PageVersion {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  page_id: number;
  lect: string | null;
  action: string | null;
}

export interface PageTag {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  page_id: number | null;
  tag_id: number;
  weight: number;
}

export interface Tag {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
  weight: number;
  taxonomy_slug: string | null;
  parent_tag: number | null;
  lect: string | null;
}

export interface Taxonomy {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  name: string;
  slug: string;
}

/** A runtime-editable page type stored in the `page_types` table. */
export interface PageType {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  /** The page-type key (e.g. 'event'); becomes the blueprint map key. */
  slug: string;
  name: string;
  /** JSON array of BlueprintEntry. */
  blueprint: string;
  /** Optional JSON arrays of names (block-type slugs / taxonomy slugs). */
  block_lists: string | null;
  taxonomy_lists: string | null;
  weight: number;
}

/** A runtime-editable block definition stored in the `block_types` table. */
export interface BlockType {
  id: number;
  uuid: string;
  created_at: string;
  updated_at: string;
  /** The block-type key (e.g. 'logos'); becomes the blocks map key. */
  slug: string;
  name: string;
  /** JSON array of BlueprintEntry for this block's fields. */
  blueprint: string;
  weight: number;
}

// ============================================================
// Cloudflare Worker environment bindings
// ============================================================
export interface Env {
  DB: D1DatabaseClient;
  PUBLISHED_DB: D1DatabaseClient;
  VIEWS: Fetcher;
  /** Cloudflare Worker version metadata; changes on every deploy. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Optional manual fallback for local/dev environments without version metadata. */
  VIEW_REVISION?: string;
  MEDIA_BUCKET?: R2Bucket;
  /** Cloudflare Images binding used for media thumbnails; falls back to the original when unbound. */
  IMAGES?: ImagesBinding;
  /** Comma-separated built-in publish targets ("d1", "r2"). Defaults to "d1".
   *  Plugin publish targets are discovered from manifests, not listed here. */
  PUBLISH_TARGETS?: string;
  /** Bucket for the "r2" publish target (static JSON snapshots). */
  PUBLISH_BUCKET?: R2Bucket;
  PAGE_SYNC: DurableObjectNamespace;
  /** Sharded single-use admin form-token coordinators. */
  FORM_ONCE: DurableObjectNamespace;
  /** Comma-separated list of plugin service-binding names, e.g. "PLUGIN_EVENTS,PLUGIN_SEO". */
  PLUGINS?: string;
  /** Shared secret forwarded to plugin Workers so they can trust CMS-originated calls. */
  PLUGIN_SECRET?: string;
  /** Queue for CMS-owned admin background jobs, such as long plugin actions. */
  ADMIN_JOBS_QUEUE?: Queue<CmsAdminJobMessage>;
  /** HMAC-SHA256 secret for signing JWTs – set via `wrangler secret put JWT_SECRET` */
  JWT_SECRET: string;
  /**
   * Comma-separated list of enabled OAuth providers,
   * e.g. "github,google,microsoft,apple,eventuai".
   * Only providers listed here will show as login options.
   */
  ENABLED_PROVIDERS: string;
  /** Per-provider OAuth client IDs (set in wrangler.toml [vars]) */
  GITHUB_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_TENANT?: string;
  APPLE_CLIENT_ID?: string;
  EVENTUAI_CLIENT_ID?: string;
  /** Per-provider OAuth client secrets (set via `wrangler secret put`) */
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  APPLE_CLIENT_SECRET?: string;
  EVENTUAI_CLIENT_SECRET?: string;
  /** Shared OAuth redirect URI registered with all providers */
  OAUTH_REDIRECT_URI: string;
  CANONICAL_ORIGIN?: string;
  SITE_TITLE: string;
  /** Default timezone for a page's start/end window when none is set.
   *  UTC offset (e.g. "+0800") or IANA name. Falls back to "+0800". */
  DEFAULT_TIMEZONE?: string;
  /**
   * Optional comma-separated email-domain allowlist for new sign-ups,
   * e.g. "cowise.co,eventuai.com". Unset = open registration (viewer role).
   */
  ALLOWED_EMAIL_DOMAINS?: string;
  /** Workers Rate Limiting bindings (optional – absent in local dev/tests). */
  AUTH_RATE_LIMITER?: RateLimiter;
  UPLOAD_RATE_LIMITER?: RateLimiter;
}

/** Raw bindings supplied by Cloudflare before request/job-scoped sessions are created. */
export type WorkerEnv = Omit<Env, 'DB' | 'PUBLISHED_DB'> & {
  DB: D1Database;
  PUBLISHED_DB: D1Database;
};

/** Shape of a Workers Rate Limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Hono context variables set by the auth middleware
export interface Variables {
  user: JWTPayload;
}
