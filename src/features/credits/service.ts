// ============================================================
// Credit system — manifest-declared costs, admin-configured prices,
// host-charged, ledger-logged.
//
// A plugin's manifest declares which chargeable actions exist
// (PluginManifest.credits): 'page_create' costs are charged automatically by
// the host at every page-create path (the /__cms write-back API and the
// built-in admin editor); 'metered' costs are reported by the plugin via
// POST /__cms/credits/charge for actions the host can't observe. The CMS
// stores configured prices in the `settings` table (`plugin.credits.<id>`),
// keeps each user's balances in credit_wallets, and appends every change to
// credit_ledger.
//
// Pricing semantics:
//   - configured number  → that's the price (0 = explicitly free)
//   - not configured     → the manifest `default`, or 0 (free) if none
//   - if several plugins price the same page type (via delegated writeTypes),
//     the effective cost is the SUM of all effective prices
//
// Charging is atomic and overdraft-proof: the ledger INSERT and the balance
// UPDATE share a `credits >= amount` guard and run in one DB.batch (a D1
// transaction), so concurrent spends can never take a balance below zero and
// the ledger can never disagree with the balance.
//
// Shared pool: besides per-user balances there is one site-wide pool per
// currency (`shared_credits`, one row each) with its own append-only ledger
// (`shared_credit_ledger`). spendCredits() tries the user's balance first and
// falls back to the pool for the FULL amount when the user can't cover it
// (all-or-nothing per pool — never split). Pool movements are recorded only in
// the shared ledger, with user_id as the beneficiary. Users holding the
// 'credits:share' permission may move pool credits to a user's balance
// (transferSharedCredits); admins top the pool up via adjustSharedCredits.
//
// Currencies: every function here takes a CreditCurrency, defaulting to
// 'credit'. A currency is a wallet of its own — its own credit_wallets row,
// shared pool row and ledger lines — and nothing converts between
// them: a diamond cost is refused when the diamond balance is short, however
// many credits the user holds. 'diamond' is the premium wallet for costs an
// operator pays real money for (SMS and WhatsApp delivery). Supported
// currencies live only in ./currencies.ts; storage is row-based and needs no
// schema change when one is added.
// ============================================================

import type { Env } from '../../types';
import type {
  ContributedCreditDef,
  CreditBillingMode,
  CreditChargeKind,
  CreditContributor,
} from './contracts';
import { getSetting, saveSetting } from '../../core/db/settings';
import {
  CREDIT_CURRENCIES,
  DEFAULT_CREDIT_CURRENCY,
  creditCurrencyDefinition,
  isCreditCurrency,
  type CreditCurrency,
} from './currencies';

/** The currency named by `value`, or 'credit' when it names none. Use for
 *  form fields and manifest input where the default is the sane fallback;
 *  declaredCredits() drops an unknown currency instead. */
export function asCreditCurrency(value: unknown): CreditCurrency {
  return isCreditCurrency(value) ? value : DEFAULT_CREDIT_CURRENCY;
}

/** Translation key for a currency's name as a heading: "Credits" / "Diamonds". */
export function currencyLabelKey(currency: CreditCurrency): string {
  return `credits.currency.${currency}`;
}

/** Translation key for a currency after a number: "25 credits" / "25 diamonds". */
export function currencyUnitKey(currency: CreditCurrency): string {
  return `credits.unit.${currency}`;
}

/** English fallback name, for log lines and non-translated surfaces. */
export function currencyLabel(currency: CreditCurrency): string {
  return creditCurrencyDefinition(currency).fallbackLabel;
}

/** A zero-filled per-currency map, so callers can total without presence checks. */
export function emptyCurrencyTotals(): Record<CreditCurrency, number> {
  return Object.fromEntries(CREDIT_CURRENCIES.map((currency) => [currency, 0])) as Record<CreditCurrency, number>;
}

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

export interface CreditChargeInput {
  userId: number;
  /** Credits to deduct; must be > 0 (0 is a caller-side no-op). */
  amount: number;
  /** Wallet to deduct from. Omitted → 'credit'. */
  currency?: CreditCurrency;
  /** Ledger action, e.g. 'events:create_guest_list' or 'admin:adjust'. */
  action: string;
  entityType?: string;
  entityId?: string;
  pluginId?: string;
  /**
   * The plugin whose declared cost this is. Its plugin wallet pays first
   * (spendCredits only). Distinct from `pluginId`, which records who CALLED —
   * a plugin creating another plugin's page type must not spend that
   * plugin's wallet, nor its own on a cost it doesn't own.
   */
  scopePluginId?: string;
  /** With scopePluginId: the plugin wallet is the ONLY payer — when it is
   *  short the spend is refused rather than falling back to the member or
   *  the shared pool. */
  pluginOnly?: boolean;
  note?: string;
  /** Who triggered it: a user id, or 'plugin:<id>' for server-to-server. */
  createdBy: string;
}

export type CreditChargeResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; error: 'unknown_user' | 'insufficient_credits'; balance: number; required: number };

export interface CreditLedgerRow {
  id: number;
  user_id: number;
  currency: CreditCurrency;
  delta: number;
  balance_after: number;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  plugin_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
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

export async function getCreditBalance(
  env: Env,
  userId: number,
  currency: CreditCurrency = DEFAULT_CREDIT_CURRENCY,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(wallet.balance, 0) AS balance
       FROM users
       LEFT JOIN credit_wallets AS wallet
         ON wallet.user_id = users.id AND wallet.currency = ?
      WHERE users.id = ?`,
  ).bind(currency, userId).first<{ balance: number }>();
  return row?.balance ?? null;
}

/** Every wallet's balance for one user, or null when there is no such user. */
export async function getCreditBalances(
  env: Env,
  userId: number,
): Promise<Record<CreditCurrency, number> | null> {
  const rows = await env.DB.prepare(
    `SELECT users.id AS user_id, wallet.currency, wallet.balance
       FROM users
       LEFT JOIN credit_wallets AS wallet ON wallet.user_id = users.id
      WHERE users.id = ?`,
  ).bind(userId).all<{ user_id: number; currency: string | null; balance: number | null }>();
  if (!rows.results.length) return null;
  const balances = emptyCurrencyTotals();
  for (const row of rows.results) {
    if (isCreditCurrency(row.currency)) balances[row.currency] = row.balance ?? 0;
  }
  return balances;
}

/**
 * Atomically deducts `amount` credits and appends the ledger row. Both
 * statements share the `balance >= amount` guard and run in one DB.batch, so
 * a concurrent spend can never overdraw and the ledger stays consistent with
 * the balance. Fails closed with `insufficient_credits` (or `unknown_user`).
 */
export async function chargeCredits(env: Env, input: CreditChargeInput): Promise<CreditChargeResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`chargeCredits amount must be > 0, got ${input.amount}`);
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;

  // Success is detected via RETURNING, not meta.changes: production D1
  // reports `changes` from internal row writes (indexes included), so a
  // one-row UPDATE can report changes > 1 there while local D1 reports 1.
  const results = await env.DB.batch<{ balance: number }>([
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_wallets (user_id, currency, balance)
       SELECT id, ?, 0 FROM users WHERE id = ?`,
    ).bind(currency, input.userId),
    env.DB.prepare(
      `INSERT INTO credit_ledger (user_id, currency, delta, balance_after, action, entity_type, entity_id, plugin_id, note, created_by)
       SELECT user_id, currency, ?, balance - ?, ?, ?, ?, ?, ?, ?
         FROM credit_wallets
        WHERE user_id = ? AND currency = ? AND balance >= ?`,
    ).bind(
      -amount, amount, input.action, input.entityType ?? null, input.entityId ?? null,
      input.pluginId ?? null, input.note ?? null, input.createdBy, input.userId, currency, amount,
    ),
    env.DB.prepare(
      `UPDATE credit_wallets
          SET balance = balance - ?
        WHERE user_id = ? AND currency = ? AND balance >= ?
        RETURNING balance`,
    ).bind(amount, input.userId, currency, amount),
  ]);

  const updated = results[2].results;
  if (updated.length === 1) {
    return { ok: true, balanceAfter: updated[0].balance };
  }
  const balance = await getCreditBalance(env, input.userId, currency);
  if (balance === null) return { ok: false, error: 'unknown_user', balance: 0, required: amount };
  return { ok: false, error: 'insufficient_credits', balance, required: amount };
}

/**
 * Grants (positive delta) or deducts (negative delta) credits with a ledger
 * row — admin adjustments, refunds. Deductions use the same overdraft guard
 * as chargeCredits; grants always apply.
 */
export async function adjustCredits(
  env: Env,
  input: { userId: number; delta: number; currency?: CreditCurrency; action: string; note?: string; pluginId?: string; entityType?: string; entityId?: string; createdBy: string },
): Promise<CreditChargeResult> {
  const delta = Math.trunc(input.delta);
  if (delta === 0) throw new Error('adjustCredits delta must be non-zero');
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;
  if (delta < 0) {
    return chargeCredits(env, {
      userId: input.userId,
      amount: -delta,
      currency,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      pluginId: input.pluginId,
      note: input.note,
      createdBy: input.createdBy,
    });
  }

  // RETURNING instead of meta.changes for the same reason as chargeCredits.
  const results = await env.DB.batch<{ balance: number }>([
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_wallets (user_id, currency, balance)
       SELECT id, ?, 0 FROM users WHERE id = ?`,
    ).bind(currency, input.userId),
    env.DB.prepare(
      `INSERT INTO credit_ledger (user_id, currency, delta, balance_after, action, entity_type, entity_id, plugin_id, note, created_by)
       SELECT user_id, currency, ?, balance + ?, ?, ?, ?, ?, ?, ?
         FROM credit_wallets WHERE user_id = ? AND currency = ?`,
    ).bind(
      delta, delta, input.action, input.entityType ?? null, input.entityId ?? null,
      input.pluginId ?? null, input.note ?? null, input.createdBy, input.userId, currency,
    ),
    env.DB.prepare(
      `UPDATE credit_wallets
          SET balance = balance + ?
        WHERE user_id = ? AND currency = ?
        RETURNING balance`,
    ).bind(delta, input.userId, currency),
  ]);

  const updated = results[2].results;
  if (updated.length !== 1) {
    return { ok: false, error: 'unknown_user', balance: 0, required: 0 };
  }
  return { ok: true, balanceAfter: updated[0].balance };
}

/**
 * Best-effort refund after a charged operation failed downstream (e.g. the
 * page insert threw after the deduction). Never throws: the original failure
 * is what the caller must surface, and a missed refund is admin-fixable from
 * the ledger. `source` routes the refund back to whichever balance paid
 * (spendCredits reports it): the user's own, or the shared pool.
 */
export async function refundCredits(
  env: Env,
  input: { userId: number; amount: number; currency?: CreditCurrency; action: string; note?: string; pluginId?: string; scopePluginId?: string; createdBy: string; source?: CreditSource },
): Promise<void> {
  if (Math.trunc(input.amount) <= 0) return;
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;
  try {
    if (input.source === 'plugin') {
      if (!input.scopePluginId) throw new Error('plugin-wallet refund needs scopePluginId');
      await writePluginCredits(env, input.scopePluginId, Math.trunc(input.amount), false, {
        currency,
        action: `${input.action}:refund`,
        userId: input.userId,
        note: input.note,
        createdBy: input.createdBy,
      });
      return;
    }
    if (input.source === 'shared') {
      await adjustSharedCredits(env, {
        delta: Math.trunc(input.amount),
        currency,
        action: `${input.action}:refund`,
        userId: input.userId,
        note: input.note,
        pluginId: input.pluginId,
        createdBy: input.createdBy,
      });
      return;
    }
    await adjustCredits(env, {
      userId: input.userId,
      delta: Math.trunc(input.amount),
      currency,
      action: `${input.action}:refund`,
      note: input.note,
      pluginId: input.pluginId,
      createdBy: input.createdBy,
    });
  } catch (error) {
    console.error('credit refund failed', input, error);
  }
}

export type CreditTransferResult =
  | { ok: true; senderBalance: number; recipientBalance: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number }
  | { ok: false; error: 'unknown_user' };

/**
 * Moves `amount` credits from one user to another, writing a paired ledger row
 * on each side ('transfer:send' with a negative delta, 'transfer:receive' with
 * a positive one). The sender is debited first under the same overdraft guard
 * as a spend; only if that succeeds is the recipient credited. Should the
 * recipient credit fail (e.g. the row vanished mid-transfer), the sender is
 * auto-refunded so credits can never be destroyed. Recipient eligibility (not
 * the sender, not an administrator) is the caller's to enforce.
 */
export async function transferCredits(
  env: Env,
  input: { fromUserId: number; toUserId: number; amount: number; currency?: CreditCurrency; note?: string; createdBy: string },
): Promise<CreditTransferResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`transferCredits amount must be > 0, got ${input.amount}`);
  if (input.fromUserId === input.toUserId) throw new Error('transferCredits cannot target the same user');
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;

  const debit = await chargeCredits(env, {
    userId: input.fromUserId,
    amount,
    currency,
    action: 'transfer:send',
    entityType: 'user',
    entityId: String(input.toUserId),
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!debit.ok) {
    return debit.error === 'insufficient_credits'
      ? { ok: false, error: 'insufficient_credits', balance: debit.balance, required: amount }
      : { ok: false, error: 'unknown_user' };
  }

  const credit = await adjustCredits(env, {
    userId: input.toUserId,
    delta: amount,
    currency,
    action: 'transfer:receive',
    entityType: 'user',
    entityId: String(input.fromUserId),
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!credit.ok) {
    await refundCredits(env, {
      userId: input.fromUserId,
      amount,
      currency,
      action: 'transfer:send',
      note: 'auto-refund: recipient credit failed',
      createdBy: input.createdBy,
    });
    return { ok: false, error: 'unknown_user' };
  }

  return { ok: true, senderBalance: debit.balanceAfter, recipientBalance: credit.balanceAfter };
}

export async function listCreditLedger(
  env: Env,
  userId: number,
  opts: { limit?: number; offset?: number; currency?: CreditCurrency } = {},
): Promise<CreditLedgerRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const currency = opts.currency ?? DEFAULT_CREDIT_CURRENCY;
  const rows = await env.DB.prepare(
    'SELECT * FROM credit_ledger WHERE user_id = ? AND currency = ? ORDER BY id DESC LIMIT ? OFFSET ?',
  ).bind(userId, currency, limit, offset).all<CreditLedgerRow>();
  return rows.results;
}

export async function countCreditLedger(
  env: Env,
  userId: number,
  currency: CreditCurrency = DEFAULT_CREDIT_CURRENCY,
): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM credit_ledger WHERE user_id = ? AND currency = ?',
  ).bind(userId, currency).first<{ total: number }>();
  return Math.max(0, row?.total ?? 0);
}

// ── Shared credit pool ────────────────────────────────────────────────────────

/** Which balance a spend was taken from. */
export type CreditSource = 'user' | 'shared' | 'plugin';

export interface SharedCreditLedgerRow {
  id: number;
  currency: CreditCurrency;
  delta: number;
  balance_after: number;
  action: string;
  /** The user the pool paid for / transferred to; NULL for pool top-ups. */
  user_id: number | null;
  entity_type: string | null;
  entity_id: string | null;
  plugin_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export type SharedCreditResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number };

export async function getSharedCreditBalance(
  env: Env,
  currency: CreditCurrency = DEFAULT_CREDIT_CURRENCY,
): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM shared_credits WHERE currency = ?')
    .bind(currency).first<{ balance: number }>();
  return row?.balance ?? 0;
}

/** Every shared pool's balance, keyed by currency. */
export async function getSharedCreditBalances(env: Env): Promise<Record<CreditCurrency, number>> {
  const rows = await env.DB.prepare('SELECT currency, balance FROM shared_credits')
    .all<{ currency: string; balance: number }>();
  const balances = emptyCurrencyTotals();
  for (const row of rows.results) {
    if (isCreditCurrency(row.currency)) balances[row.currency] = row.balance;
  }
  return balances;
}

interface SharedCreditChangeInput {
  /** The beneficiary recorded on the ledger row; null for pool top-ups. */
  userId?: number | null;
  /** Which pool to move. Omitted → 'credit'. */
  currency?: CreditCurrency;
  action: string;
  entityType?: string;
  entityId?: string;
  pluginId?: string;
  note?: string;
  createdBy: string;
}

/** Atomic pool write: ledger INSERT + balance UPDATE sharing one guard, like
 *  chargeCredits. The row is created lazily. Success is detected via
 *  RETURNING. */
async function writeSharedCredits(
  env: Env,
  delta: number,
  guarded: boolean,
  input: SharedCreditChangeInput,
): Promise<SharedCreditResult> {
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;
  const guardSql = guarded ? ' AND balance >= ?' : '';
  const guardArgs = guarded ? [-delta] : [];
  const results = await env.DB.batch<{ balance: number }>([
    env.DB.prepare('INSERT OR IGNORE INTO shared_credits (currency, balance) VALUES (?, 0)')
      .bind(currency),
    env.DB.prepare(
      `INSERT INTO shared_credit_ledger (currency, delta, balance_after, action, user_id, entity_type, entity_id, plugin_id, note, created_by)
       SELECT ?, ?, balance + ?, ?, ?, ?, ?, ?, ?, ?
         FROM shared_credits WHERE currency = ?${guardSql}`,
    ).bind(
      currency, delta, delta, input.action, input.userId ?? null, input.entityType ?? null,
      input.entityId ?? null, input.pluginId ?? null, input.note ?? null, input.createdBy, currency, ...guardArgs,
    ),
    env.DB.prepare(`UPDATE shared_credits SET balance = balance + ? WHERE currency = ?${guardSql} RETURNING balance`)
      .bind(delta, currency, ...guardArgs),
  ]);

  const updated = results[2].results;
  if (updated.length === 1) return { ok: true, balanceAfter: updated[0].balance };
  return {
    ok: false,
    error: 'insufficient_credits',
    balance: await getSharedCreditBalance(env, currency),
    required: -delta,
  };
}

/** Atomically deducts from the shared pool; fails closed when the pool can't
 *  cover the amount. `userId` is the beneficiary recorded on the ledger row. */
export async function chargeSharedCredits(
  env: Env,
  input: SharedCreditChangeInput & { amount: number },
): Promise<SharedCreditResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`chargeSharedCredits amount must be > 0, got ${input.amount}`);
  return writeSharedCredits(env, -amount, true, input);
}

/** Grants (positive delta) or deducts (negative delta) shared-pool credits —
 *  admin top-ups, refunds. Deductions use the overdraft guard. */
export async function adjustSharedCredits(
  env: Env,
  input: SharedCreditChangeInput & { delta: number },
): Promise<SharedCreditResult> {
  const delta = Math.trunc(input.delta);
  if (delta === 0) throw new Error('adjustSharedCredits delta must be non-zero');
  return writeSharedCredits(env, delta, delta < 0, input);
}

// ── Plugin wallets ────────────────────────────────────────────────────────────
// Credits a plugin's creator supplies to this site (POST
// /__cms/credits/plugin-grant), one balance per (plugin, currency). They pay
// only for costs that plugin declares — spendCredits() tries them first when
// given a scopePluginId — and never move to a member's wallet or the shared
// pool. A plugin minting its own credits can therefore only waive its own
// fees. Forfeited when the plugin is unregistered (forfeitPluginCredits), so a
// Worker that later claims the same manifest id inherits nothing.

export interface PluginCreditLedgerRow {
  id: number;
  plugin_id: string;
  currency: CreditCurrency;
  delta: number;
  balance_after: number;
  action: string;
  /** The member a spend benefited; NULL for grants, revokes and forfeits. */
  user_id: number | null;
  entity_type: string | null;
  entity_id: string | null;
  grant_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

interface PluginCreditChangeInput {
  currency?: CreditCurrency;
  action: string;
  /** Beneficiary of a spend. The write is a no-op when no such user exists,
   *  so an invalid identity can never drain a plugin wallet. */
  userId?: number | null;
  entityType?: string;
  entityId?: string;
  grantId?: string;
  note?: string;
  createdBy: string;
}

export async function getPluginCreditBalance(
  env: Env,
  pluginId: string,
  currency: CreditCurrency = DEFAULT_CREDIT_CURRENCY,
): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM plugin_credits WHERE plugin_id = ? AND currency = ?')
    .bind(pluginId, currency).first<{ balance: number }>();
  return row?.balance ?? 0;
}

/** Every wallet of one plugin, keyed by currency. */
export async function getPluginCreditBalances(env: Env, pluginId: string): Promise<Record<CreditCurrency, number>> {
  const rows = await env.DB.prepare('SELECT currency, balance FROM plugin_credits WHERE plugin_id = ?')
    .bind(pluginId).all<{ currency: string; balance: number }>();
  const balances = emptyCurrencyTotals();
  for (const row of rows.results) {
    if (isCreditCurrency(row.currency)) balances[row.currency] = row.balance;
  }
  return balances;
}

/** Atomic plugin-wallet write: ledger INSERT + balance UPDATE sharing one
 *  guard, like writeSharedCredits. Success is detected via RETURNING. */
async function writePluginCredits(
  env: Env,
  pluginId: string,
  delta: number,
  guarded: boolean,
  input: PluginCreditChangeInput,
): Promise<SharedCreditResult> {
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;
  const userId = input.userId ?? null;
  let guardSql = guarded ? ' AND balance >= ?' : '';
  const guardArgs: unknown[] = guarded ? [-delta] : [];
  if (userId !== null) {
    guardSql += ' AND EXISTS (SELECT 1 FROM users WHERE id = ?)';
    guardArgs.push(userId);
  }
  const results = await env.DB.batch<{ balance: number }>([
    env.DB.prepare('INSERT OR IGNORE INTO plugin_credits (plugin_id, currency, balance) VALUES (?, ?, 0)')
      .bind(pluginId, currency),
    env.DB.prepare(
      `INSERT INTO plugin_credit_ledger (plugin_id, currency, delta, balance_after, action, user_id, entity_type, entity_id, grant_id, note, created_by)
       SELECT plugin_id, currency, ?, balance + ?, ?, ?, ?, ?, ?, ?, ?
         FROM plugin_credits WHERE plugin_id = ? AND currency = ?${guardSql}`,
    ).bind(
      delta, delta, input.action, userId, input.entityType ?? null, input.entityId ?? null,
      input.grantId ?? null, input.note ?? null, input.createdBy, pluginId, currency, ...guardArgs,
    ),
    env.DB.prepare(`UPDATE plugin_credits SET balance = balance + ? WHERE plugin_id = ? AND currency = ?${guardSql} RETURNING balance`)
      .bind(delta, pluginId, currency, ...guardArgs),
  ]);

  const updated = results[2].results;
  if (updated.length === 1) return { ok: true, balanceAfter: updated[0].balance };
  return {
    ok: false,
    error: 'insufficient_credits',
    balance: await getPluginCreditBalance(env, pluginId, currency),
    required: -delta,
  };
}

/** Deducts from a plugin wallet for `input.userId`'s benefit; fails closed
 *  when the wallet can't cover the FULL amount. An empty wallet — the common
 *  case — costs one read and no write. */
async function chargePluginCredits(
  env: Env,
  pluginId: string,
  amount: number,
  input: PluginCreditChangeInput,
): Promise<SharedCreditResult> {
  const balance = await getPluginCreditBalance(env, pluginId, input.currency);
  if (balance < amount) return { ok: false, error: 'insufficient_credits', balance, required: amount };
  return writePluginCredits(env, pluginId, -amount, true, input);
}

export type PluginGrantResult =
  | { ok: true; duplicate: boolean; delta: number; currency: CreditCurrency; balanceAfter: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number }
  | { ok: false; error: 'grant_conflict' };

/**
 * A plugin's creator adds (positive delta) or takes back (negative delta)
 * credits in its own wallet. `grantId` is unique per plugin: repeating a
 * grant returns the original result with `duplicate: true` and changes
 * nothing, so a creator can retry safely; reusing an id for a different
 * amount or currency is a `grant_conflict`. A take-back never goes below
 * zero.
 */
export async function grantPluginCredits(
  env: Env,
  input: { pluginId: string; delta: number; currency?: CreditCurrency; grantId: string; note?: string; createdBy: string },
): Promise<PluginGrantResult> {
  const delta = Math.trunc(input.delta);
  if (delta === 0) throw new Error('grantPluginCredits delta must be non-zero');
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;

  const existing = async (): Promise<PluginGrantResult | null> => {
    const row = await env.DB.prepare(
      'SELECT currency, delta, balance_after FROM plugin_credit_ledger WHERE plugin_id = ? AND grant_id = ?',
    ).bind(input.pluginId, input.grantId).first<{ currency: string; delta: number; balance_after: number }>();
    if (!row) return null;
    if (row.currency !== currency || row.delta !== delta) return { ok: false, error: 'grant_conflict' };
    return { ok: true, duplicate: true, delta, currency, balanceAfter: row.balance_after };
  };

  const prior = await existing();
  if (prior) return prior;
  try {
    const write = await writePluginCredits(env, input.pluginId, delta, delta < 0, {
      currency,
      action: delta > 0 ? 'plugin:grant' : 'plugin:revoke',
      grantId: input.grantId,
      note: input.note,
      createdBy: input.createdBy,
    });
    if (!write.ok) return write;
    return { ok: true, duplicate: false, delta, currency, balanceAfter: write.balanceAfter };
  } catch (error) {
    // A concurrent request with the same grant id won the UNIQUE constraint;
    // the batch rolled back, so report what that request did.
    if (/UNIQUE constraint failed/i.test(String(error))) {
      const raced = await existing();
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Zeroes every wallet of a plugin, with one ledger row per non-empty wallet —
 * for unregistering it. One batch, so a spend can't slip between the ledger
 * and the balance.
 */
export async function forfeitPluginCredits(env: Env, pluginId: string, createdBy: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO plugin_credit_ledger (plugin_id, currency, delta, balance_after, action, created_by)
       SELECT plugin_id, currency, -balance, 0, 'plugin:forfeit', ?
         FROM plugin_credits WHERE plugin_id = ? AND balance <> 0`,
    ).bind(createdBy, pluginId),
    env.DB.prepare('UPDATE plugin_credits SET balance = 0 WHERE plugin_id = ? AND balance <> 0').bind(pluginId),
  ]);
}

export async function listPluginCreditLedger(
  env: Env,
  pluginId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<PluginCreditLedgerRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await env.DB.prepare(
    'SELECT * FROM plugin_credit_ledger WHERE plugin_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
  ).bind(pluginId, limit, offset).all<PluginCreditLedgerRow>();
  return rows.results;
}

/** Refusal fields shared by every spend failure. `pluginOnly` marks a cost
 *  only its plugin's wallet may pay; balance/sharedBalance are then 0, since
 *  neither was eligible. */
interface SpendRefusal {
  balance: number;
  sharedBalance: number;
  pluginBalance?: number;
  pluginOnly?: true;
  required: number;
}

export type CreditSpendResult =
  | { ok: true; source: CreditSource; balanceAfter: number }
  | ({ ok: false; error: 'unknown_user' | 'insufficient_credits' } & SpendRefusal);

async function userExists(env: Env, userId: number): Promise<boolean> {
  return !!await env.DB.prepare('SELECT 1 AS found FROM users WHERE id = ?').bind(userId).first();
}

/**
 * With a scopePluginId, that plugin's wallet pays first, for the FULL amount
 * or not at all. Then: charges the user's own balance; when it can't cover the FULL amount,
 * the shared pool pays the full amount instead (all-or-nothing per pool, never
 * split — refunds stay one-sided). A pool-covered spend is recorded only in
 * the shared ledger, with the user as beneficiary. An unknown user never falls
 * back — an invalid identity must not drain the pool. The result's `source`
 * says which balance paid, so a downstream refund can target it.
 */
export async function spendCredits(env: Env, input: CreditChargeInput): Promise<CreditSpendResult> {
  const amount = Math.trunc(input.amount);
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;
  let pluginBalance: number | undefined;
  if (input.scopePluginId && amount > 0) {
    const own = await chargePluginCredits(env, input.scopePluginId, amount, {
      currency,
      action: input.action,
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      note: input.note,
      createdBy: input.createdBy,
    });
    if (own.ok) return { ok: true, source: 'plugin', balanceAfter: own.balanceAfter };
    pluginBalance = own.balance;
    if (input.pluginOnly) {
      return {
        ok: false,
        error: await userExists(env, input.userId) ? 'insufficient_credits' : 'unknown_user',
        balance: 0,
        sharedBalance: 0,
        pluginBalance,
        pluginOnly: true,
        required: amount,
      };
    }
  }
  const charge = await chargeCredits(env, input);
  if (charge.ok) return { ok: true, source: 'user', balanceAfter: charge.balanceAfter };
  if (charge.error === 'unknown_user') {
    return {
      ok: false,
      error: 'unknown_user',
      balance: 0,
      sharedBalance: await getSharedCreditBalance(env, currency),
      pluginBalance,
      required: amount,
    };
  }

  // Only the SAME currency's pool can cover the spend — a full diamond pool
  // never pays a credit charge, and vice versa.
  const shared = await chargeSharedCredits(env, {
    amount,
    currency,
    action: input.action,
    userId: input.userId,
    entityType: input.entityType,
    entityId: input.entityId,
    pluginId: input.pluginId,
    note: input.note,
    createdBy: input.createdBy,
  });
  if (shared.ok) return { ok: true, source: 'shared', balanceAfter: shared.balanceAfter };
  return { ok: false, error: 'insufficient_credits', balance: charge.balance, sharedBalance: shared.balance, pluginBalance, required: amount };
}

/** One currency's part of a multi-currency charge. */
export interface CurrencyAmount {
  currency: CreditCurrency;
  amount: number;
  /** The plugin whose cost this part is; its wallet may pay the part. */
  scopePluginId?: string;
  /** With scopePluginId: only that plugin's wallet may pay this part. */
  pluginOnly?: boolean;
}

/** A part spendCurrencies() took, and which balance paid it. */
export type SpentAmount = CurrencyAmount & { source: CreditSource };

export type MultiSpendResult =
  | { ok: true; spent: SpentAmount[] }
  | ({ ok: false; error: 'unknown_user' | 'insufficient_credits'; currency: CreditCurrency; pluginId?: string } & SpendRefusal);

/**
 * Spends several parts for one action — a page type priced in credits by
 * one plugin and in diamonds by another costs both at once.
 *
 * Each part carrying a scopePluginId is first offered to that plugin's wallet
 * (the full part or nothing); a `pluginOnly` part the wallet can't cover
 * refuses the whole spend. Whatever no plugin wallet paid is then combined
 * per currency and spent as ONE charge from the user, falling back to the
 * shared pool — exactly what happens when no plugin wallet is funded.
 *
 * All-or-nothing across parts: if any spend is refused, everything already
 * debited is refunded before the refusal is returned. A caller therefore
 * never has to unwind a partial charge, and never half-charges a create it
 * then rejects.
 */
export async function spendCurrencies(
  env: Env,
  input: Omit<CreditChargeInput, 'amount' | 'currency' | 'scopePluginId'> & { amounts: readonly CurrencyAmount[] },
): Promise<MultiSpendResult> {
  const { amounts, ...base } = input;
  const spent: SpentAmount[] = [];
  const remaining = emptyCurrencyTotals();
  for (const part of amounts) {
    const amount = Math.trunc(part.amount);
    if (amount <= 0) continue;
    if (part.scopePluginId) {
      const own = await chargePluginCredits(env, part.scopePluginId, amount, {
        currency: part.currency,
        action: base.action,
        userId: base.userId,
        entityType: base.entityType,
        entityId: base.entityId,
        note: base.note,
        createdBy: base.createdBy,
      });
      if (own.ok) {
        spent.push({ currency: part.currency, amount, scopePluginId: part.scopePluginId, source: 'plugin' });
        continue;
      }
      if (part.pluginOnly) {
        await refundCurrencies(env, {
          userId: base.userId,
          action: base.action,
          pluginId: base.pluginId,
          note: 'auto-refund: another part of the same charge was refused',
          createdBy: base.createdBy,
          spent,
        });
        return {
          ok: false,
          error: await userExists(env, base.userId) ? 'insufficient_credits' : 'unknown_user',
          currency: part.currency,
          pluginId: part.scopePluginId,
          balance: 0,
          sharedBalance: 0,
          pluginBalance: own.balance,
          pluginOnly: true,
          required: amount,
        };
      }
    }
    remaining[part.currency] += amount;
  }

  for (const { currency, amount } of currencyAmounts(remaining)) {
    const charge = await spendCredits(env, { ...base, amount, currency });
    if (charge.ok) {
      spent.push({ currency, amount, source: charge.source });
      continue;
    }
    await refundCurrencies(env, {
      userId: base.userId,
      action: base.action,
      pluginId: base.pluginId,
      note: 'auto-refund: another part of the same charge was refused',
      createdBy: base.createdBy,
      spent,
    });
    return {
      ok: false,
      error: charge.error,
      currency,
      balance: charge.balance,
      sharedBalance: charge.sharedBalance,
      required: charge.required,
    };
  }
  return { ok: true, spent };
}

/** The non-zero parts of a per-currency total, in display order — the shape
 *  spendCurrencies() takes. */
export function currencyAmounts(totals: Record<CreditCurrency, number>): CurrencyAmount[] {
  return CREDIT_CURRENCIES
    .map((currency) => ({ currency, amount: Math.trunc(totals[currency] ?? 0) }))
    .filter((part) => part.amount > 0);
}

/** A page-create cost as spendCurrencies() parts, one per (plugin, currency),
 *  so each plugin's share can be paid from its own wallet. `count` scales
 *  the cost for a batch of creates. */
export function pageCreateAmounts(cost: PageCreateCost, count = 1): CurrencyAmount[] {
  const byPart = new Map<string, CurrencyAmount>();
  for (const part of cost.parts) {
    const pluginOnly = part.pluginOnly === true;
    const key = `${part.pluginId}\u0000${part.currency}\u0000${pluginOnly}`;
    const entry = byPart.get(key)
      ?? { currency: part.currency, amount: 0, scopePluginId: part.pluginId, ...(pluginOnly ? { pluginOnly } : {}) };
    entry.amount += part.value * count;
    byPart.set(key, entry);
  }
  return [...byPart.values()].filter((part) => part.amount > 0);
}

/**
 * Reverses what spendCurrencies() took, each part back to the balance that
 * paid it. `portion` (0..1) refunds only part of the charge — for a batch
 * where some of the rows were written after all. Never throws, like
 * refundCredits().
 */
export async function refundCurrencies(
  env: Env,
  input: {
    userId: number;
    action: string;
    pluginId?: string;
    note?: string;
    createdBy: string;
    spent: ReadonlyArray<SpentAmount>;
    portion?: number;
  },
): Promise<void> {
  const portion = Math.min(Math.max(input.portion ?? 1, 0), 1);
  if (portion <= 0) return;
  for (const part of input.spent) {
    await refundCredits(env, {
      userId: input.userId,
      amount: Math.round(part.amount * portion),
      currency: part.currency,
      source: part.source,
      scopePluginId: part.scopePluginId,
      action: input.action,
      pluginId: input.pluginId,
      note: input.note,
      createdBy: input.createdBy,
    });
  }
}

export type SharedDonationResult =
  | { ok: true; balanceAfter: number; sharedBalance: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number }
  | { ok: false; error: 'unknown_user' };

/**
 * Moves `amount` credits from a user's own balance into the shared pool — the
 * profile page's "donate" action, open to any user since the pool benefits
 * everyone. Paired 'shared:donate' ledger rows on both sides: negative on the
 * user's ledger (overdraft-guarded like any spend), positive on the shared
 * ledger with the donor as beneficiary. Should the pool credit fail, the user
 * is auto-refunded so credits can never be destroyed.
 */
export async function donateSharedCredits(
  env: Env,
  input: { fromUserId: number; amount: number; currency?: CreditCurrency; note?: string; createdBy: string },
): Promise<SharedDonationResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`donateSharedCredits amount must be > 0, got ${input.amount}`);
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;

  const debit = await chargeCredits(env, {
    userId: input.fromUserId,
    amount,
    currency,
    action: 'shared:donate',
    entityType: 'shared',
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!debit.ok) {
    return debit.error === 'insufficient_credits'
      ? { ok: false, error: 'insufficient_credits', balance: debit.balance, required: amount }
      : { ok: false, error: 'unknown_user' };
  }

  try {
    const credit = await adjustSharedCredits(env, {
      delta: amount,
      currency,
      action: 'shared:donate',
      userId: input.fromUserId,
      note: input.note,
      createdBy: input.createdBy,
    });
    if (credit.ok) return { ok: true, balanceAfter: debit.balanceAfter, sharedBalance: credit.balanceAfter };
  } catch (error) {
    console.error('shared credit donation failed', input, error);
  }
  await refundCredits(env, {
    userId: input.fromUserId,
    amount,
    currency,
    action: 'shared:donate',
    note: 'auto-refund: pool credit failed',
    createdBy: input.createdBy,
  });
  return { ok: false, error: 'unknown_user' };
}

export type SharedTransferResult =
  | { ok: true; sharedBalance: number; recipientBalance: number }
  | { ok: false; error: 'insufficient_credits'; balance: number; required: number }
  | { ok: false; error: 'unknown_user' };

/**
 * Moves `amount` credits from the shared pool to a user's balance, writing a
 * ledger row on each side ('shared:send' on the pool ledger with the recipient
 * as beneficiary, 'shared:receive' on the user ledger). The pool is debited
 * first under the overdraft guard; if the user credit then fails (unknown
 * user), the pool is auto-refunded so credits can never be destroyed.
 * Authorization ('credits:share') is the caller's to enforce.
 */
export async function transferSharedCredits(
  env: Env,
  input: { toUserId: number; amount: number; currency?: CreditCurrency; note?: string; createdBy: string },
): Promise<SharedTransferResult> {
  const amount = Math.trunc(input.amount);
  if (amount <= 0) throw new Error(`transferSharedCredits amount must be > 0, got ${input.amount}`);
  const currency = input.currency ?? DEFAULT_CREDIT_CURRENCY;

  // The shared ledger's beneficiary column is a foreign key — debiting with a
  // nonexistent recipient would abort on the constraint, so check first.
  const recipient = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(input.toUserId).first<{ id: number }>();
  if (!recipient) return { ok: false, error: 'unknown_user' };

  const debit = await chargeSharedCredits(env, {
    amount,
    currency,
    action: 'shared:send',
    userId: input.toUserId,
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!debit.ok) return { ok: false, error: 'insufficient_credits', balance: debit.balance, required: amount };

  const credit = await adjustCredits(env, {
    userId: input.toUserId,
    delta: amount,
    currency,
    action: 'shared:receive',
    entityType: 'shared',
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!credit.ok) {
    await adjustSharedCredits(env, {
      delta: amount,
      currency,
      action: 'shared:send:refund',
      userId: input.toUserId,
      note: 'auto-refund: recipient credit failed',
      createdBy: input.createdBy,
    }).catch((error) => console.error('shared credit refund failed', input, error));
    return { ok: false, error: 'unknown_user' };
  }

  return { ok: true, sharedBalance: debit.balanceAfter, recipientBalance: credit.balanceAfter };
}

export async function listSharedCreditLedger(
  env: Env,
  opts: { limit?: number; offset?: number; currency?: CreditCurrency } = {},
): Promise<SharedCreditLedgerRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const currency = opts.currency ?? DEFAULT_CREDIT_CURRENCY;
  const rows = await env.DB.prepare(
    'SELECT * FROM shared_credit_ledger WHERE currency = ? ORDER BY id DESC LIMIT ? OFFSET ?',
  ).bind(currency, limit, offset).all<SharedCreditLedgerRow>();
  return rows.results;
}
