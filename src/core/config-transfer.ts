// Settings export/import between CMS deployments.
//
// Each area that owns configuration (system settings, taxonomies, content
// types, languages, roles, plugin registrations) contributes one section. A
// section exports plain values and, on import, compares a bundle against this
// CMS and hands back one apply() per change. apply() always goes through the
// area's own save path, so validation, permissions and audit evidence are the
// same as a save from that area's admin screen. Import merges: it creates and
// updates by natural key (slug, code, name, URL) and never deletes.

import type { AppContext } from './http/context';
import type { Permission } from '../types';

export const CONFIG_TRANSFER_FORMAT = '0xcms-config';
export const CONFIG_TRANSFER_VERSION = 1;
/** Upload limit for a bundle; the icon sprite alone may be 64 KB. */
export const MAX_CONFIG_BUNDLE_BYTES = 2_000_000;

export type ConfigTransferAction = 'create' | 'update' | 'unchanged' | 'skip';

export interface ConfigTransferPlanItem {
  label: string;
  action: ConfigTransferAction;
  /** Plain-text reason for a skip, or what still needs doing after import. */
  note?: string;
  /** Set for create/update: performs the change through the owning save path. */
  apply?: () => Promise<void>;
}

export interface ConfigTransferSection {
  id: string;
  /** i18n key for the section heading. */
  labelKey: string;
  /** Apply order, lowest first: plugins precede the types and roles that may name them. */
  order: number;
  permission: Permission;
  /** Values exported for this section. Never secrets. */
  exportItems(c: AppContext): Promise<unknown[]>;
  /** Compares bundle items with this CMS without writing. */
  plan(c: AppContext, items: readonly unknown[]): Promise<ConfigTransferPlanItem[]>;
  /** i18n key for a follow-up shown with the section, e.g. reconnecting plugins. */
  noteKey?: string;
}

export interface ConfigTransferBundle {
  format: typeof CONFIG_TRANSFER_FORMAT;
  version: number;
  exportedAt: string;
  source: string;
  sections: Record<string, unknown[]>;
}

/** Thrown by a section when one imported item is invalid; the message is shown. */
export class ConfigTransferItemError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseConfigBundle(text: string): ConfigTransferBundle | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isRecord(parsed) || parsed.format !== CONFIG_TRANSFER_FORMAT || parsed.version !== CONFIG_TRANSFER_VERSION
    || !isRecord(parsed.sections)) return null;
  const sections: Record<string, unknown[]> = {};
  for (const [id, items] of Object.entries(parsed.sections)) {
    if (!Array.isArray(items)) return null;
    sections[id] = items;
  }
  return {
    format: CONFIG_TRANSFER_FORMAT,
    version: CONFIG_TRANSFER_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    source: typeof parsed.source === 'string' ? parsed.source : '',
    sections,
  };
}

/** Plan rows for items whose create/update is decided by comparing to an existing value. */
export function planChange(label: string, existing: unknown, next: unknown, apply: () => Promise<void>): ConfigTransferPlanItem {
  if (existing === undefined) return { label, action: 'create', apply };
  return JSON.stringify(existing) === JSON.stringify(next) ? { label, action: 'unchanged' } : { label, action: 'update', apply };
}

export function skipItem(label: string, note: string): ConfigTransferPlanItem {
  return { label, action: 'skip', note };
}
