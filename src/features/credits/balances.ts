// Single-balance reads and writes: each user's wallets (credit_wallets), the
// site-wide shared pool (shared_credits) and plugin wallets, each with its
// append-only ledger. Every write is one guarded DB.batch; see ./service.ts.

import type { Env } from '../../types';
import { insertChargeReceipt, type ChargeReceiptKey } from './charge-receipts';
import { DEFAULT_CREDIT_CURRENCY, isCreditCurrency, emptyCurrencyTotals, type CreditCurrency } from './currencies';

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
  receipt?: ChargeReceiptKey;
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
    ...(input.receipt ? [insertChargeReceipt(env, input.receipt, input.userId, currency, amount, 'user',
      'EXISTS (SELECT 1 FROM credit_wallets WHERE user_id = ? AND currency = ? AND balance >= ?)',
      [input.userId, currency, amount])] : []),
    env.DB.prepare(
      `UPDATE credit_wallets
          SET balance = balance - ?
        WHERE user_id = ? AND currency = ? AND balance >= ?
        RETURNING balance`,
    ).bind(amount, input.userId, currency, amount),
  ]);

  const updated = results.at(-1)!.results;
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
  receipt?: ChargeReceiptKey;
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
    ...(input.receipt ? [insertChargeReceipt(env, input.receipt, input.userId!, currency, -delta, 'shared',
      `EXISTS (SELECT 1 FROM shared_credits WHERE currency = ?${guardSql})`,
      [currency, ...guardArgs])] : []),
    env.DB.prepare(`UPDATE shared_credits SET balance = balance + ? WHERE currency = ?${guardSql} RETURNING balance`)
      .bind(delta, currency, ...guardArgs),
  ]);

  const updated = results.at(-1)!.results;
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
  receipt?: ChargeReceiptKey;
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
export async function writePluginCredits(
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
    ...(input.receipt ? [insertChargeReceipt(env, input.receipt, userId!, currency, -delta, 'plugin',
      `EXISTS (SELECT 1 FROM plugin_credits WHERE plugin_id = ? AND currency = ?${guardSql})`,
      [pluginId, currency, ...guardArgs])] : []),
    env.DB.prepare(`UPDATE plugin_credits SET balance = balance + ? WHERE plugin_id = ? AND currency = ?${guardSql} RETURNING balance`)
      .bind(delta, pluginId, currency, ...guardArgs),
  ]);

  const updated = results.at(-1)!.results;
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
export async function chargePluginCredits(
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
