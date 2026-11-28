// Credits moving between balances or across currencies: refunds routed back to
// whichever balance paid, user and shared-pool transfers, donations, and the
// spend paths that try plugin wallet, user balance, then shared pool.

import type { Env } from '../../types';
import { CREDIT_CURRENCIES, DEFAULT_CREDIT_CURRENCY, emptyCurrencyTotals, type CreditCurrency } from './currencies';
import type { PageCreateCost } from './pricing';
import { adjustCredits, adjustSharedCredits, chargeCredits, chargePluginCredits, chargeSharedCredits, getSharedCreditBalance, writePluginCredits, type CreditChargeInput, type CreditSource } from './balances';

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
      receipt: input.receipt,
      settlement: input.settlement,
      evidence: input.evidence,
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
    receipt: input.receipt,
    settlement: input.settlement,
    evidence: input.evidence,
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
