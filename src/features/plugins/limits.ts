// ============================================================
// Plugin limits — manifest-declared and admin-configured. Page quotas are
// host-enforced; plugins consume operational limits such as per_second.
//
// A plugin's manifest only *declares* which limits exist (PluginManifest.
// limits): a key, the page type it bounds, and how existing pages are counted
// (total / per_parent / per_pointer). The CMS stores the configured values in
// the `settings` table (key `plugin.limits.<pluginId>`) and enforces them on
// every page-create path — the /__cms write-back API AND the built-in admin
// editor — so a quota can't be sidestepped by choosing the other door.
//
// Semantics:
//   - configured number  → that's the limit
//   - configured null    → explicitly unlimited (admin override of a default)
//   - not configured     → the manifest `default`, or unlimited if none
//   - a limit binds its page type globally, regardless of which plugin or
//     admin user creates the page
//
// The check is count-then-insert (no locking), so concurrent creates can
// overshoot by a few rows: these are business quotas, not hard invariants.
// Trash restore is likewise not gated.
// ============================================================

import type { Env } from '../../types';
import type { PluginLimitDef, PluginLimitScope, PluginManifest, ResolvedPlugin } from './types';
import { getPlugins } from './registry';
import { listPageTypeApprovals } from './page-types';
import { getSetting, saveSetting } from '../../core/db/settings';
import { safeParseLect } from '../../core/db/lect';
import { countPageMetadata } from '../../core/db/count-metadata';

/** Cap on manifest-declared limits honored per plugin. */
export const MAX_DECLARED_LIMITS = 20;

const LIMIT_KEY_RE = /^[a-z0-9_]{1,64}$/;
const POINTER_KEY_RE = /^[a-z0-9_-]{1,64}$/i;
const SCOPES = new Set<PluginLimitScope>(['total', 'per_parent', 'per_pointer', 'per_second']);

export function limitsSettingKey(pluginId: string): string {
  return `plugin.limits.${pluginId}`;
}

/** A manifest limit that survived validation, with defaults normalized. */
export interface NormalizedLimitDef {
  key: string;
  label: string;
  description: string;
  pageType: string | null;
  scope: PluginLimitScope;
  /** Set exactly when scope is 'per_pointer'. */
  pointerKey: string | null;
  /** Manifest default, or null for "unlimited until configured". */
  defaultValue: number | null;
}

/** Configured values keyed by limit key. null = explicitly unlimited. */
export type PluginLimitValues = Record<string, number | null>;

/** A declared limit resolved to its effective (configured or default) value. */
export interface EffectiveLimit {
  pluginId: string;
  def: NormalizedLimitDef;
  /** null = unlimited (never enforced). */
  value: number | null;
  /** True when an admin has configured this key (vs. manifest default). */
  configured: boolean;
}

export interface LimitViolation {
  pluginId: string;
  key: string;
  label: string;
  pageType: string;
  scope: PluginLimitScope;
  limit: number;
  current: number;
  attempted: number;
}

/** One page about to be created, reduced to what limit scoping needs. */
export interface CreateCandidate {
  pageType: string;
  parentId: number | null;
  /** `_pointers` of the candidate's lect (string values only). */
  pointers: Record<string, string>;
}

function coerceLimitNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n >= 0 ? n : null;
}

/**
 * Page types a plugin's limits may bind: its own blueprint types plus any
 * admin-approved delegated writeTypes. Without this gate a plugin could
 * declare a defaulted limit on a type it has no business with and block
 * another plugin's (or the editor's) page creation.
 */
export async function limitScopeTypes(db: D1DatabaseClient, manifest: PluginManifest): Promise<Set<string>> {
  const types = new Set(Object.keys(manifest.contentTypes?.blueprint ?? {}));
  const declaredWrites = manifest.contentTypes?.writeTypes ?? [];
  if (declaredWrites.length) {
    const approvals = await listPageTypeApprovals(db, manifest.id);
    const approvedWrites = new Set(
      approvals.filter((approval) => approval.access === 'write').map((approval) => approval.page_type),
    );
    for (const type of declaredWrites) {
      if (approvedWrites.has(type)) types.add(type);
    }
  }
  return types;
}

/**
 * Validates and normalizes a manifest's declared limits. Malformed entries,
 * duplicate keys, and limits on page types outside `allowedTypes` are dropped
 * (a manifest is remote input — never let a bad entry break resolution).
 */
export function declaredLimits(manifest: PluginManifest, allowedTypes: Set<string>): NormalizedLimitDef[] {
  const out: NormalizedLimitDef[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(manifest.limits) ? manifest.limits : []) {
    if (out.length >= MAX_DECLARED_LIMITS) break;
    if (!raw || typeof raw !== 'object') continue;
    const def = raw as PluginLimitDef;
    if (typeof def.key !== 'string' || !LIMIT_KEY_RE.test(def.key) || seen.has(def.key)) continue;
    if (!SCOPES.has(def.scope as PluginLimitScope)) continue;
    if (def.scope !== 'per_second' && (typeof def.page_type !== 'string' || !allowedTypes.has(def.page_type))) continue;
    const pointerKey = typeof def.pointer_key === 'string' && POINTER_KEY_RE.test(def.pointer_key)
      ? def.pointer_key
      : null;
    if (def.scope === 'per_pointer' && !pointerKey) continue;

    seen.add(def.key);
    out.push({
      key: def.key,
      label: typeof def.label === 'string' && def.label.trim() ? def.label.trim().slice(0, 120) : def.key,
      description: typeof def.description === 'string' ? def.description.trim().slice(0, 500) : '',
      pageType: def.scope === 'per_second' ? null : def.page_type!,
      scope: def.scope,
      pointerKey: def.scope === 'per_pointer' ? pointerKey : null,
      defaultValue: coerceLimitNumber(def.default),
    });
  }
  return out;
}

export async function loadLimitValues(env: Env, pluginId: string): Promise<PluginLimitValues> {
  const raw = await getSetting(env, limitsSettingKey(pluginId));
  if (!raw) return {};
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const values: PluginLimitValues = {};
    for (const [key, value] of Object.entries(saved)) {
      if (!LIMIT_KEY_RE.test(key)) continue;
      if (value === null) values[key] = null;
      else {
        const n = coerceLimitNumber(value);
        if (n !== null) values[key] = n;
      }
    }
    return values;
  } catch {
    return {};
  }
}

export async function saveLimitValues(env: Env, pluginId: string, values: PluginLimitValues): Promise<void> {
  await saveSetting(env, limitsSettingKey(pluginId), JSON.stringify(values));
}

function effectiveValue(def: NormalizedLimitDef, values: PluginLimitValues): { value: number | null; configured: boolean } {
  if (def.key in values) return { value: values[def.key], configured: true };
  return { value: def.defaultValue, configured: false };
}

/** All of one plugin's declared limits resolved to effective values. */
export async function effectiveLimitsForPlugin(env: Env, plugin: ResolvedPlugin): Promise<EffectiveLimit[]> {
  const allowed = await limitScopeTypes(env.DB, plugin.manifest);
  const defs = declaredLimits(plugin.manifest, allowed);
  if (!defs.length) return [];
  const values = await loadLimitValues(env, plugin.manifest.id);
  return defs.map((def) => ({ pluginId: plugin.manifest.id, def, ...effectiveValue(def, values) }));
}

/**
 * Every active plugin's effective limits that bind `pageType`. This is the
 * enforcement source for both /__cms and the admin editor.
 */
export async function limitsForPageType(env: Env, pageType: string): Promise<EffectiveLimit[]> {
  const plugins = await getPlugins(env);
  const out: EffectiveLimit[] = [];
  for (const plugin of plugins) {
    // Cheap pre-filter before touching D1: does the manifest even mention the type?
    const mentions = (plugin.manifest.limits ?? []).some((def) => def?.scope !== 'per_second' && def?.page_type === pageType);
    if (!mentions) continue;
    for (const limit of await effectiveLimitsForPlugin(env, plugin)) {
      if (limit.def.pageType === pageType) out.push(limit);
    }
  }
  return out;
}

/** Counts existing pages the limit's scope group already holds. */
export async function countLimitUsage(
  db: D1DatabaseClient,
  def: NormalizedLimitDef,
  scopeValue: string | number | null,
): Promise<number> {
  let sql = 'p.page_type = ?';
  const params: unknown[] = [def.pageType];
  if (def.scope === 'per_parent') {
    sql += ' AND p.page_id = ?';
    params.push(scopeValue);
  } else if (def.scope === 'per_pointer') {
    sql += ' AND json_extract(p.lect, ?) = ?';
    params.push(`$._pointers.${def.pointerKey}`, String(scopeValue ?? ''));
  }
  return countPageMetadata(db, sql, params, { types: def.pageType ? [def.pageType] : undefined, action: 'page.limit-usage' });
}

/** Groups candidates by the scope value a limit counts over. Candidates a
 *  scoped limit can't see (no parent / no pointer) are exempt from it. */
function scopeGroups(def: NormalizedLimitDef, candidates: CreateCandidate[]): Map<string | number | null, number> {
  const groups = new Map<string | number | null, number>();
  for (const candidate of candidates) {
    let scopeValue: string | number | null = null;
    if (def.scope === 'per_parent') {
      if (candidate.parentId === null) continue;
      scopeValue = candidate.parentId;
    } else if (def.scope === 'per_pointer') {
      const pointer = candidate.pointers[def.pointerKey ?? ''];
      if (!pointer) continue;
      scopeValue = pointer;
    }
    groups.set(scopeValue, (groups.get(scopeValue) ?? 0) + 1);
  }
  return groups;
}

/**
 * Checks a set of about-to-be-created pages against every applicable limit.
 * Returns the first violation, or null when all creates fit. Callers reject
 * the whole request on a violation so a bulk import never half-applies
 * against a quota.
 */
export async function checkCreateLimits(env: Env, candidates: CreateCandidate[]): Promise<LimitViolation | null> {
  if (!candidates.length) return null;

  const byType = new Map<string, CreateCandidate[]>();
  for (const candidate of candidates) {
    const list = byType.get(candidate.pageType) ?? [];
    list.push(candidate);
    byType.set(candidate.pageType, list);
  }

  for (const [pageType, typeCandidates] of byType) {
    const limits = await limitsForPageType(env, pageType);
    for (const limit of limits) {
      if (limit.value === null) continue;
      for (const [scopeValue, attempted] of scopeGroups(limit.def, typeCandidates)) {
        const current = await countLimitUsage(env.DB, limit.def, scopeValue);
        if (current + attempted > limit.value) {
          return {
            pluginId: limit.pluginId,
            key: limit.def.key,
            label: limit.def.label,
            pageType,
            scope: limit.def.scope,
            limit: limit.value,
            current,
            attempted,
          };
        }
      }
    }
  }
  return null;
}

/** Builds a CreateCandidate from a page's type, parent, and lect. */
export function createCandidate(pageType: string, parentId: number | null, lect: unknown): CreateCandidate {
  const parsed = typeof lect === 'string' ? safeParseLect(lect) : (lect ?? {});
  const rawPointers = (parsed as Record<string, unknown>)._pointers;
  const pointers: Record<string, string> = {};
  if (rawPointers && typeof rawPointers === 'object' && !Array.isArray(rawPointers)) {
    for (const [key, value] of Object.entries(rawPointers)) {
      if (typeof value === 'string' || typeof value === 'number') pointers[key] = String(value);
    }
  }
  return { pageType, parentId, pointers };
}

/** Human-readable message for admin-facing error surfaces. */
export function limitViolationMessage(violation: LimitViolation): string {
  const scopeNote = violation.scope === 'total' ? '' : violation.scope === 'per_parent' ? ' in this parent' : ' in this collection';
  return `Limit reached: ${violation.label} (${violation.current}/${violation.limit}${scopeNote}). Remove existing ${violation.pageType.replace(/[_-]/g, ' ')} pages or raise the limit in Plugins → Limits.`;
}
