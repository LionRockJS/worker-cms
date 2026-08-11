// Shared shapes for the /__cms plugin API modules. Types only: no runtime
// code, so every module can import from here without creating a cycle.

import type { ResolvedPlugin } from '../types';
import type { Lect } from '../../../core/db/lect';

export interface ApiPage {
  id: number;
  uuid: string;
  page_type: string | null;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Lect;
  /** Present when the caller requests live status on a full page list. */
  isPublished?: boolean;
  /** Present when the caller requests include_tags on a list/search. */
  tags?: ApiPageTag[];
}

export interface ApiPageTag {
  id: number;
  name: string;
  taxonomy: string;
  taxonomy_slug: string;
}

export interface ApiPageResourceTag {
  id: number;
  slug: string;
  name: string;
  weight: number;
  taxonomy_slug: string;
  parent_tag: number | null;
  created_at: string;
  updated_at: string;
  lect: Lect;
}

export interface ApiPageResourceGroup {
  tag: ApiPageResourceTag | null;
  pages: ApiPage[];
}

export interface ApiPageResourceCollection {
  pages: ApiPage[];
  groups: ApiPageResourceGroup[];
}

export interface PluginAuth {
  plugin: ResolvedPlugin;
  pluginId: string;
  /** Page types this plugin may write through its manifest-declared scope; `*` means any concrete page type. */
  allowedTypes: Set<string>;
  /** Writable types plus any declared `readTypes`; `*` means any concrete page type. */
  readableTypes: Set<string>;
}

/** Body accepted by create/update. All fields optional on update; `page_type` required on create. */

export interface PageInput {
  id?: unknown;
  page_type?: unknown;
  name?: unknown;
  slug?: unknown;
  lect?: unknown;
  weight?: unknown;
  start?: unknown;
  end?: unknown;
  timezone?: unknown;
  page_id?: unknown;
  tags?: unknown;
  version_action?: unknown;
  /** Optional exact stored-lect precondition for compare-and-swap updates. */
  if_lect?: unknown;
}

export interface AdvancedSearchInput {
  page_type?: unknown;
  page_types?: unknown;
  criteria?: unknown;
  operator?: unknown;
  limit?: unknown;
  page?: unknown;
  pagesize?: unknown;
  sort?: unknown;
  order?: unknown;
}

export interface PageListBatchInput {
  queries?: unknown;
}

export interface PreparedCreate {
  id: number | null;
  pageType: string;
  name: string;
  baseSlug: string;
  lect: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  parentId: number | null;
  tags: number[];
}

export interface DuplicateInput {
  /** Only pages of this type are cloned (must be in the plugin's write scope). */
  source_page_type?: unknown;
  // Source selector (exactly one): by lect pointer (preferred) or parent page id.
  /** Pointer key the source pages group by, e.g. 'mail_list'. */
  source_pointer_key?: unknown;
  /** Pointer value the source pages group by, e.g. the list id. */
  source_pointer_value?: unknown;
  /** Parent page whose children are cloned (fallback when no pointer is given). */
  source_page_id?: unknown;
  /** Parent assigned to the clones (null/omitted → top-level). */
  target_page_id?: unknown;
  /** Lect fields merged over each clone (e.g. status reset, repointed `_pointers`). */
  lect?: unknown;
  /** Top-level lect keys stripped from each clone before the override merge. */
  drop_lect?: unknown;
  /** Resume token from a prior response's `next_cursor` (last source id copied). */
  cursor?: unknown;
}
