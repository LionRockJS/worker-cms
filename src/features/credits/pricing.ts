// Credit prices: the costs features declare, the prices an admin configures
// (settings `plugin.credits.<id>`), and what one page create costs. Pricing
// semantics are described in ./service.ts.

import type { Env } from '../../types';
import type { ContributedCreditDef, CreditBillingMode, CreditChargeKind, CreditContributor } from './contracts';
import { getSetting, saveSetting } from '../../core/db/settings';
import { DEFAULT_CREDIT_CURRENCY, isCreditCurrency, emptyCurrencyTotals, type CreditCurrency } from './currencies';

/**
 * Cap on manifest-declared credit costs honored per plugin — remote input, so
 * it is bounded. Costs past the cap are dropped silently, which is why the
 * limit sits well above what a large plugin declares: the events suite alone
 * declares 26 across two currencies, and a dropped cost is an action that
 * quietly stops being charged.
 */
export const MAX_DECLARED_CREDITS = 40;

const CREDIT_KEY_RE = /^[a-z0-9_]{1,64}$/;
const CHARGES = new Set<CreditChargeKind>(['page_create', 'metered', 'recurring']);
const BILLINGS = new Set<CreditBillingMode>(['advance', 'arrears']);
/** Cap on a recurring cost's billing block size. */
const MAX_RECURRING_PER = 1_000_000_000;

export function creditsSettingKey(pluginId: string): string {
  return `plugin.credits.${pluginId}`;
}

/** A manifest credit cost that survived validation, defaults normalized. */
export interface NormalizedCreditDef {
  key: string;
  label: string;
  description: string;
  charge: CreditChargeKind;
  /** Wallet this cost is paid from. */
  currency: CreditCurrency;
  /** Set exactly when charge is 'page_create'. */
  pageType: string | null;
  /** Display unit for metered/recurring costs. */
  unit: string;
  /** Manifest default price; 0 = free until configured. */
  defaultValue: number;
  /** Recurring only: usage block size the price applies to (≥ 1). */
  per: number;
  /** Set exactly when charge is 'recurring'. */
  billing: CreditBillingMode | null;
  /** Paid only from the declaring plugin's wallet, never the member's
   *  balance or the shared pool. */
  pluginOnly: boolean;
}

/** Configured prices keyed by credit key (always ≥ 0; 0 = explicitly free). */
export type PluginCreditValues = Record<string, number>;

/** A declared cost resolved to its effective (configured or default) price. */
export interface EffectiveCredit {
  pluginId: string;
  def: NormalizedCreditDef;
  value: number;
  configured: boolean;
}

function coercePrice(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const n = Math.trunc(value);
  return n > 0 ? n : 0;
}

/**
 * Validates and normalizes a manifest's declared credit costs. Malformed
 * entries, duplicate keys, and page_create costs on page types outside
 * `allowedTypes` are dropped — a plugin must not be able to attach prices to
 * another plugin's content.
 */
export function declaredCredits(contributor: CreditContributor): NormalizedCreditDef[] {
  const allowedTypes = contributor.pricablePageTypes;
  const out: NormalizedCreditDef[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(contributor.credits) ? contributor.credits : []) {
    if (out.length >= MAX_DECLARED_CREDITS) break;
    if (!raw || typeof raw !== 'object') continue;
    const def = raw as ContributedCreditDef;
    if (typeof def.key !== 'string' || !CREDIT_KEY_RE.test(def.key) || seen.has(def.key)) continue;
    if (!CHARGES.has(def.charge as CreditChargeKind)) continue;
    const pageType = typeof def.page_type === 'string' ? def.page_type : '';
    if (def.charge === 'page_create' && (!pageType || !allowedTypes.has(pageType))) continue;
    // Recurring costs bill monthly; an unknown period must not silently bill
    // at the wrong cadence, so anything but 'month' (or omitted) is dropped.
    if (def.charge === 'recurring' && def.period !== undefined && def.period !== 'month') continue;
    if (def.charge === 'recurring' && def.billing !== undefined && !BILLINGS.has(def.billing as CreditBillingMode)) continue;
    // An unrecognised currency drops the cost rather than defaulting: a typo
    // must never silently bill the wrong wallet.
    if (def.currency !== undefined && !isCreditCurrency(def.currency)) continue;
    const per = typeof def.per === 'number' && Number.isFinite(def.per)
      ? Math.min(Math.max(Math.trunc(def.per), 1), MAX_RECURRING_PER)
      : 1;

    seen.add(def.key);
    out.push({
      key: def.key,
      label: typeof def.label === 'string' && def.label.trim() ? def.label.trim().slice(0, 120) : def.key,
      description: typeof def.description === 'string' ? def.description.trim().slice(0, 500) : '',
      charge: def.charge,
      currency: def.currency ?? DEFAULT_CREDIT_CURRENCY,
      pageType: def.charge === 'page_create' ? pageType : null,
      unit: typeof def.unit === 'string' && def.unit.trim() ? def.unit.trim().slice(0, 40) : 'action',
      defaultValue: coercePrice(def.default),
      per: def.charge === 'recurring' ? per : 1,
      billing: def.charge === 'recurring' ? (def.billing as CreditBillingMode | undefined) ?? 'advance' : null,
      pluginOnly: def.plugin_only === true,
    });
  }
  return out;
}

/** Display unit for a cost: recurring block sizes read "5000 record". */
export function creditUnitLabel(def: NormalizedCreditDef): string {
  return def.per > 1 ? `${def.per} ${def.unit}` : def.unit;
}

export async function loadCreditValues(env: Env, pluginId: string): Promise<PluginCreditValues> {
  const raw = await getSetting(env, creditsSettingKey(pluginId));
  if (!raw) return {};
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const values: PluginCreditValues = {};
    for (const [key, value] of Object.entries(saved)) {
      if (!CREDIT_KEY_RE.test(key)) continue;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) values[key] = Math.trunc(value);
    }
    return values;
  } catch {
    return {};
  }
}

export async function saveCreditValues(env: Env, pluginId: string, values: PluginCreditValues): Promise<void> {
  await saveSetting(env, creditsSettingKey(pluginId), JSON.stringify(values));
}

/** All of one contributor's declared costs resolved to effective prices. */
export async function effectiveCreditsFor(env: Env, contributor: CreditContributor): Promise<EffectiveCredit[]> {
  const defs = declaredCredits(contributor);
  if (!defs.length) return [];
  const values = await loadCreditValues(env, contributor.id);
  return defs.map((def) => {
    const configured = def.key in values;
    return { pluginId: contributor.id, def, value: configured ? values[def.key] : def.defaultValue, configured };
  });
}

/** As effectiveCreditsFor, by id — empty when nobody by that id contributes. */
export async function effectiveCreditsForId(env: Env, contributorId: string): Promise<EffectiveCredit[]> {
  const contributor = await creditContributor(env, contributorId);
  return contributor ? effectiveCreditsFor(env, contributor) : [];
}

/** One contributor supplied through the generated feature-service registry. */
export async function creditContributor(env: Env, contributorId: string): Promise<CreditContributor | null> {
  const { callFeatureService } = await import('../services');
  return await callFeatureService<CreditContributor | null>(
    'plugins',
    'credit-contributor',
    env,
    { id: contributorId },
  ) ?? null;
}

/** Everyone declaring priced actions; empty when no feature contributes. */
export async function creditContributors(env: Env): Promise<CreditContributor[]> {
  const { callFeatureService } = await import('../services');
  return await callFeatureService<CreditContributor[]>(
    'plugins',
    'credit-contributors',
    env,
    {},
  ) ?? [];
}

export interface PageCreateCost {
  /** Sum of every contributor's effective price for creating one page of the
   *  type, per currency. Two plugins may price the same type in different
   *  wallets, so this is a map and not one number. */
  totals: Record<CreditCurrency, number>;
  /** Sum across every currency — enough to tell "priced" from "free". */
  total: number;
  /** The priced parts (value > 0 only). */
  parts: Array<{ pluginId: string; key: string; label: string; currency: CreditCurrency; value: number; pluginOnly?: boolean }>;
}

/** The effective cost of creating one page of `pageType`, across all plugins. */
export async function pageCreateCostForType(env: Env, pageType: string): Promise<PageCreateCost> {
  const parts: PageCreateCost['parts'] = [];
  for (const contributor of await creditContributors(env)) {
    // Cheap pre-filter before touching D1.
    const mentions = (contributor.credits ?? [])
      .some((def) => def?.charge === 'page_create' && def?.page_type === pageType);
    if (!mentions) continue;
    for (const credit of await effectiveCreditsFor(env, contributor)) {
      if (credit.def.charge === 'page_create' && credit.def.pageType === pageType && credit.value > 0) {
        parts.push({
          pluginId: credit.pluginId,
          key: credit.def.key,
          label: credit.def.label,
          currency: credit.def.currency,
          value: credit.value,
          ...(credit.def.pluginOnly ? { pluginOnly: true } : {}),
        });
      }
    }
  }
  const totals = emptyCurrencyTotals();
  for (const part of parts) totals[part.currency] += part.value;
  return { totals, total: parts.reduce((sum, part) => sum + part.value, 0), parts };
}

/** Ledger action for a page-create charge: the declaring plugin's key when
 *  there is exactly one priced part, else a generic page_create action. */
export function pageCreateAction(pageType: string, cost: PageCreateCost): string {
  return cost.parts.length === 1
    ? `${cost.parts[0].pluginId}:${cost.parts[0].key}`
    : `page_create:${pageType}`;
}
