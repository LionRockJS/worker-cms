// The credits feature's runtime service entry.
//
// src/generated/services.ts includes this entry only when the feature is
// enabled. Core and sibling features call the neutral dispatchers in
// src/features/services.ts and never import this module or its contracts.

import type { FeatureServiceEntry } from '../services';
import type { CreditPricingRow } from './contracts';
import type { AppContext } from '../../core/http/context';
import { effectivePermissions, resolveRolePermissions, splitRoles } from '../../core/auth/roles';
import type { Env } from '../../types';
import { loadShowCredits } from '../../core/db/settings';
import { creditLedgerRowForView } from './ledger-view';
import { recordTableReads } from '../../core/http/access-log';
import { recordWalletReads } from './read-audit';
import {
  adminAction,
  PROFILE_DONATE_PATH,
  PROFILE_TRANSFER_PATH,
  SHARED_POOL_ADJUST_PATH,
} from './paths';
import {
  countCreditLedger,
  creditUnitLabel,
  currencyAmounts,
  currencyLabel,
  currencyLabelKey,
  currencyUnitKey,
  declaredCredits,
  creditContributor,
  effectiveCreditsForId,
  emptyCurrencyTotals,
  getCreditBalances,
  getSharedCreditBalances,
  listCreditLedger,
  listSharedCreditLedger,
  pageCreateAction,
  pageCreateCostForType,
  refundCurrencies,
  saveCreditValues,
  spendCurrencies,
  type NormalizedCreditDef,
  type PluginCreditValues,
} from './service';
import { sweepCreditSubscriptions } from './subscriptions';
import {
  CREDIT_CURRENCIES,
  type CreditCurrency,
} from './currencies';

/** Ledger rows per page on the profile screen. */
const PROFILE_LEDGER_PAGE_SIZE = 20;
/** Ledger rows shown on the users-admin screens (no pagination there). */
const USERS_LEDGER_PAGE_SIZE = 10;

const CREDIT_TRANSFER_ACTION = adminAction(PROFILE_TRANSFER_PATH);
const SHARED_DONATE_ACTION = adminAction(PROFILE_DONATE_PATH);
const SHARED_POOL_ACTION = adminAction(SHARED_POOL_ADJUST_PATH);

export const creditsServices: FeatureServiceEntry = {
  id: 'credits',

  /**
   * Charges the signed-in editor for a page create. A type nobody prices is
   * free, and returns a charge whose refund is a no-op.
   */
  async reservePageCreate(c: AppContext, pageType: string) {
    const cost = await pageCreateCostForType(c.env, pageType);
    if (cost.total <= 0) return { ok: true, charged: 0, refund: async () => {} };

    const userId = Number(c.get('user').sub);
    const action = pageCreateAction(pageType, cost);
    // A page type may be priced in more than one wallet (one plugin charges
    // credits for it, another diamonds); every part is spent or none is.
    const charge = await spendCurrencies(c.env, {
      userId,
      amounts: currencyAmounts(cost.totals),
      action,
      entityType: pageType,
      createdBy: String(userId),
    });
    if (!charge.ok) {
      const money = currencyLabel(charge.currency);
      return {
        ok: false,
        status: charge.error === 'unknown_user' ? 400 : 402,
        code: charge.error === 'unknown_user' ? 'unknown_user' : 'insufficient_credits',
        message: charge.error === 'unknown_user'
          ? `Your user account could not be charged ${money}.`
          : `Not enough ${money}: creating this needs ${charge.required} ${money} and you have ${charge.balance} (shared pool: ${charge.sharedBalance}).`,
      };
    }

    const spent = charge.spent;
    return {
      ok: true,
      charged: spent.reduce((sum, part) => sum + part.amount, 0),
      refund: () => refundCurrencies(c.env, { userId, action, createdBy: String(userId), spent }),
    };
  },

  async adminScreenProps(c: AppContext, target): Promise<Record<string, unknown>> {
    if (!await loadShowCredits(c.env)) return { showCreditsPanel: false };
    if (target.screen === 'profile') return profileCreditProps(c);
    if (target.screen === 'users') return sharedPoolProps(c.env);
    if (target.screen === 'user') return userCreditProps(c, target.userId);
    return {};
  },

  /**
   * Charges a batch of page creates for an API caller. Structured rather than
   * message-formatted: the caller turns a refusal into its own 402 payload.
   */
  async reservePageCreates(env: Env, input) {
    const totals = emptyCurrencyTotals();
    const breakdown: Record<string, number> = {};
    let action = 'page_create:batch';
    let singleType: string | undefined;
    for (const { pageType, count } of input.pageTypes) {
      const cost = await pageCreateCostForType(env, pageType);
      if (cost.total > 0) {
        for (const currency of CREDIT_CURRENCIES) totals[currency] += cost.totals[currency] * count;
        breakdown[pageType] = cost.total * count;
      }
      if (input.pageTypes.length === 1 && count === 1) {
        action = pageCreateAction(pageType, cost);
        singleType = pageType;
      }
    }

    const amounts = currencyAmounts(totals);
    const payer = input.payerUserId;
    if (!amounts.length || payer === null) {
      return { ok: true, charged: 0, refund: async () => {} };
    }

    const createdBy = input.contributorId ? `plugin:${input.contributorId}` : String(payer);
    const charge = await spendCurrencies(env, {
      userId: payer,
      amounts,
      action,
      entityType: singleType,
      pluginId: input.contributorId,
      note: singleType ? undefined : JSON.stringify(breakdown),
      createdBy,
    });
    if (!charge.ok) {
      return charge.error === 'unknown_user'
        ? {
          ok: false,
          status: 400,
          code: 'unknown_acting_user',
          message: 'The acting user does not exist.',
        }
        : {
          ok: false,
          status: 402,
          code: 'insufficient_credits',
          message: `The ${currencyLabel(charge.currency)} balance is insufficient.`,
          details: {
            credit: {
              currency: charge.currency,
              required: charge.required,
              balance: charge.balance,
              shared_balance: charge.sharedBalance,
            },
          },
        };
    }

    const spent = charge.spent;
    return {
      ok: true,
      charged: spent.reduce((sum, part) => sum + part.amount, 0),
      refund: (portion?: number) => refundCurrencies(env, {
        userId: payer,
        action,
        pluginId: input.contributorId,
        createdBy,
        spent,
        portion,
      }),
    };
  },

  async call(operation, env, input): Promise<unknown> {
    const request = typeof input === 'object' && input !== null
      ? input as { contributorId?: unknown; submitted?: unknown }
      : {};
    const contributorId = typeof request.contributorId === 'string' ? request.contributorId : '';
    if (!contributorId) return operation === 'pricing' ? [] : {};

    if (operation === 'pricing') return creditPricing(env, contributorId);
    if (operation === 'save-pricing') {
      const submitted = request.submitted && typeof request.submitted === 'object' && !Array.isArray(request.submitted)
        ? request.submitted as Record<string, string>
        : {};
      return saveCreditPricing(env, contributorId, submitted);
    }
    return undefined;
  },

  async scheduled(env: Env): Promise<string | null> {
    const sweep = await sweepCreditSubscriptions(env);
    return sweep.processed ? `credit subscription sweep: ${JSON.stringify(sweep)}` : null;
  },
};

async function creditPricing(env: Env, contributorId: string): Promise<CreditPricingRow[]> {
  const credits = await effectiveCreditsForId(env, contributorId);
  return credits.map((credit) => ({
    key: credit.def.key,
    label: credit.def.label,
    description: credit.def.description,
    currency: credit.def.currency,
    currencyKey: currencyUnitKey(credit.def.currency),
    chargeLabel: chargeLabel(credit.def),
    chargeKey: chargeKey(credit.def),
    defaultValue: credit.def.defaultValue,
    effectiveValue: credit.value,
    configured: credit.configured,
  }));
}

async function saveCreditPricing(
  env: Env,
  contributorId: string,
  submitted: Record<string, string>,
): Promise<Record<string, number>> {
  const contributor = await creditContributor(env, contributorId);
  if (!contributor) return {};
  // Only declared keys are saved; blank = unset, so the default applies.
  const values: PluginCreditValues = {};
  for (const def of declaredCredits(contributor)) {
    const raw = (submitted[def.key] ?? '').trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) values[def.key] = Math.trunc(parsed);
  }
  await saveCreditValues(env, contributorId, values);
  return values;
}

/**
 * The profile page's wallets: one card per currency, each with its own
 * balance, transfer and donate forms, and independently paginated ledger.
 * The view walks `creditWallets`, so adding a currency adds a card without
 * touching the markup.
 */
async function profileCreditProps(c: AppContext): Promise<Record<string, unknown>> {
  const userId = Number(c.get('user').sub);
  recordWalletReads(userId);
  const [balances, sharedBalances] = await Promise.all([
    getCreditBalances(c.env, userId),
    getSharedCreditBalances(c.env),
  ]);

  const wallets = await Promise.all(CREDIT_CURRENCIES.map(async (currency) => {
    const requestedPage = positivePage(c.req.query(ledgerPageParam(currency)));
    const total = await countCreditLedger(c.env, userId, currency);
    const pageCount = Math.max(1, Math.ceil(total / PROFILE_LEDGER_PAGE_SIZE));
    const page = Math.min(requestedPage, pageCount);
    const ledger = await listCreditLedger(c.env, userId, {
      currency,
      limit: PROFILE_LEDGER_PAGE_SIZE,
      offset: (page - 1) * PROFILE_LEDGER_PAGE_SIZE,
    });
    recordTableReads('credit.ledger-read', 'credit_ledger', ledger.map(row => row.id));
    return {
      ...walletIdentity(currency),
      balance: balances?.[currency] ?? 0,
      sharedBalance: sharedBalances[currency],
      transferAction: CREDIT_TRANSFER_ACTION,
      donateAction: SHARED_DONATE_ACTION,
      ledger: ledger.map(creditLedgerRowForView),
      hasLedger: ledger.length > 0,
      showPagination: pageCount > 1,
      pagination: {
        page,
        pageCount,
        total,
        from: total === 0 ? 0 : ((page - 1) * PROFILE_LEDGER_PAGE_SIZE) + 1,
        to: Math.min(page * PROFILE_LEDGER_PAGE_SIZE, total),
        hasPrevious: page > 1,
        previousHref: profileCreditPageHref(currency, page - 1),
        hasNext: page < pageCount,
        nextHref: profileCreditPageHref(currency, page + 1),
      },
    };
  }));

  return {
    // Gates the whole panel in the view: absent when this feature is not
    // installed, so the markup renders nothing rather than an empty card.
    showCreditsPanel: true,
    creditWallets: wallets,
  };
}

/** The shared-pool cards on the users list — one per currency. */
async function sharedPoolProps(env: Env): Promise<Record<string, unknown>> {
  recordWalletReads(null);
  const balances = await getSharedCreditBalances(env);
  const wallets = await Promise.all(CREDIT_CURRENCIES.map(async (currency) => {
    const ledger = await listSharedCreditLedger(env, { currency, limit: USERS_LEDGER_PAGE_SIZE });
    recordTableReads('credit.ledger-read', 'shared_credit_ledger', ledger.map(row => row.id));
    return {
      ...walletIdentity(currency),
      balance: balances[currency],
      adjustAction: SHARED_POOL_ACTION,
      ledger: ledger.map(creditLedgerRowForView),
      hasLedger: ledger.length > 0,
    };
  }));
  return {
    showCreditsPanel: true,
    sharedWallets: wallets,
  };
}

/** One user's balances, adjust/grant forms and recent ledger, per currency. */
async function userCreditProps(c: AppContext, userId: number): Promise<Record<string, unknown>> {
  recordWalletReads(userId);
  const [balances, sharedBalances, rolePermissions] = await Promise.all([
    getCreditBalances(c.env, userId),
    getSharedCreditBalances(c.env),
    resolveRolePermissions(c.env),
  ]);
  // The grant-from-pool form is only useful to viewers who can actually POST
  // it (that route is gated on credits:share; admins always pass).
  const viewerRole = c.get('user').role;
  const canShareCredits = splitRoles(viewerRole).includes('admin')
    || effectivePermissions(rolePermissions, viewerRole).has('credits:share');

  const wallets = await Promise.all(CREDIT_CURRENCIES.map(async (currency) => {
    const ledger = await listCreditLedger(c.env, userId, { currency, limit: USERS_LEDGER_PAGE_SIZE });
    recordTableReads('credit.ledger-read', 'credit_ledger', ledger.map(row => row.id));
    return {
      ...walletIdentity(currency),
      balance: balances?.[currency] ?? 0,
      sharedBalance: sharedBalances[currency],
      adjustAction: `/admin/users/${userId}/credits`,
      grantAction: `/admin/users/${userId}/credits/shared`,
      ledger: ledger.map(creditLedgerRowForView),
      hasLedger: ledger.length > 0,
    };
  }));

  return {
    showCreditsPanel: true,
    canShareCredits,
    creditWallets: wallets,
  };
}

/** The currency fields every wallet card renders from: the hidden form value
 *  and the translation keys for its name and description. */
function walletIdentity(currency: CreditCurrency): {
  currency: CreditCurrency; nameKey: string; descriptionKey: string;
} {
  return {
    currency,
    nameKey: currencyLabelKey(currency),
    descriptionKey: `credits.currency_description.${currency}`,
  };
}

/** Query parameter paging one wallet's ledger on the profile page. */
function ledgerPageParam(currency: CreditCurrency): string {
  return `${currency}_page`;
}

function positivePage(value: string | undefined): number {
  const page = Number(value ?? '1');
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function profileCreditPageHref(currency: CreditCurrency, page: number): string {
  return page <= 1 ? '/admin/profile' : `/admin/profile?${ledgerPageParam(currency)}=${page}`;
}

/** Human charge description for a pricing row. */
function chargeLabel(def: NormalizedCreditDef): string {
  return def.charge === 'page_create' ? String(def.pageType) : creditUnitLabel(def);
}

function chargeKey(def: NormalizedCreditDef): string {
  if (def.charge === 'page_create') return 'view_strings.sections_plugin_credits.on_create';
  if (def.charge === 'recurring') {
    return def.billing === 'arrears'
      ? 'view_strings.sections_plugin_credits.monthly_arrears_per'
      : 'view_strings.sections_plugin_credits.monthly_advance_per';
  }
  return 'view_strings.sections_plugin_credits.metered_per';
}
