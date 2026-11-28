// Credit balance, quotes, charges and recurring-usage reports for the API
// callers that declare priced actions (today, plugin Workers).
//
// The charge engine stays host-side on purpose: a caller may ask what an
// action costs and ask for it to be charged, but never adjusts a balance
// itself, so overdraft protection cannot be bypassed by a compromised caller.
//
// It lives with the engine rather than with the platform that authenticates
// the callers: the platform supplies the identity through
// coreExtensions().authenticateApiCaller, so neither feature imports the
// other. With no platform installed there is nobody to authenticate, and
// every endpoint here 404s.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import type { AppContext } from '../../../core/http/context';
import { coreExtensions, type ApiCallerIdentity } from '../../../core/extensions';
import { fingerprint } from '../../../core/db/bounded-mutation';
import { recordRead, recordTableReads } from '../../../core/http/access-log';
import { recordWalletReads } from '../read-audit';
import type { CreditCurrency } from '../currencies';
import {
  effectiveCreditsForId,
  getCreditBalance,
  getCreditBalances,
  getPluginCreditBalance,
  getPluginCreditBalances,
  getSharedCreditBalance,
  getSharedCreditBalances,
  grantPluginCredits,
  spendCredits,
} from '../service';
import { isCreditCurrency } from '../currencies';
import { insertChargeReceipt, readChargeReceipt } from '../charge-receipts';
import { listSubscriptionsForPlugin, reportSubscriptionUsage, type CreditSubscriptionRow } from '../subscriptions';

export const creditApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Mounted at this prefix by src/index.ts rather than under /admin. */
export const basePath = '/__cms';

/** Numeric coercion that treats null/undefined/'' as "no value" — Number()
 *  maps all three to 0/NaN, and a stray 0 would be read as a real quantity. */
function asFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The authenticated caller, or the Response to send back. Without a platform
 *  to identify callers these endpoints do not exist. */
async function authenticateCaller(c: AppContext): Promise<ApiCallerIdentity | Response> {
  const authenticate = coreExtensions().authenticateApiCaller;
  if (!authenticate) return c.notFound();
  return authenticate(c);
}

/** Whose balance the caller is acting against. */
function actingUserId(c: AppContext): number | null {
  return coreExtensions().actingUserId?.(c) ?? null;
}

function readActor(c: AppContext, callerId: string) {
  const userId = actingUserId(c);
  return { userId: userId === null ? null : String(userId), roles: null, sessionSid: null, via: callerId };
}

function announceBalances(c: AppContext, callerId: string, currencies?: readonly CreditCurrency[]): void {
  recordWalletReads(actingUserId(c), currencies, readActor(c, callerId));
}

function announceContributor(c: AppContext, callerId: string): void {
  recordRead({ action: 'credit.plugin-read', kind: 'plugin', key: callerId, targetType: 'credit_contributor', ids: [callerId], count: 1, actor: readActor(c, callerId) });
}

// ── Credits ───────────────────────────────────────────────────────────────────
// The calling plugin's declared costs with effective prices, plus the acting
// user's balance when x-acting-user-id is sent. Read-only, for plugin UIs
// ("Creating this list costs 25 credits — you have 320").
creditApiRoutes.get('/credits', async (c) => {
  const auth = await authenticateCaller(c);
  if (auth instanceof Response) return auth;

  const payer = actingUserId(c);
  const credits = await effectiveCreditsForId(c.env, auth.callerId);
  const balances = payer !== null ? await getCreditBalances(c.env, payer) : null;
  const sharedBalances = await getSharedCreditBalances(c.env);
  const pluginBalances = await getPluginCreditBalances(c.env, auth.callerId);
  announceBalances(c, auth.callerId);
  announceContributor(c, auth.callerId);
  return c.json({
    // `balance` / `shared_balance` stay the ordinary credit wallet, which is
    // what callers written before diamonds existed read; `balances` /
    // `shared_balances` carry every wallet, keyed by currency.
    balance: balances?.credit ?? null,
    shared_balance: sharedBalances.credit,
    balances,
    shared_balances: sharedBalances,
    // This plugin's own wallets (credits its creator supplied), keyed by
    // currency. They pay this plugin's costs before anyone else's balance.
    plugin_balances: pluginBalances,
    credits: credits.map((credit) => ({
      key: credit.def.key,
      label: credit.def.label,
      description: credit.def.description,
      charge: credit.def.charge,
      currency: credit.def.currency,
      page_type: credit.def.pageType,
      unit: credit.def.unit,
      value: credit.value,
      configured: credit.configured,
      // Recurring costs: block size and billing mode (per `per` units/month).
      per: credit.def.charge === 'recurring' ? credit.def.per : undefined,
      billing: credit.def.billing ?? undefined,
      // Paid only from plugin_balances, never the member or the shared pool.
      plugin_only: credit.def.pluginOnly,
    })),
  });
});

// Affordability pre-check for a declared cost — lets a plugin verify a long
// job (an EDM blast, a big import) fits the balance BEFORE starting it.
// Nothing is deducted here.
creditApiRoutes.get('/credits/quote', async (c) => {
  const auth = await authenticateCaller(c);
  if (auth instanceof Response) return auth;

  const key = (c.req.query('key') ?? '').trim();
  const quantity = Math.trunc(asFiniteNumber(c.req.query('quantity')) ?? 1);
  if (!key) return c.json({ error: 'key_required' }, 400);
  if (quantity < 1 || quantity > 1_000_000) return c.json({ error: 'invalid_quantity' }, 400);

  const credit = (await effectiveCreditsForId(c.env, auth.callerId)).find((entry) => entry.def.key === key);
  if (!credit) return c.json({ error: 'unknown_credit_key' }, 400);

  const payer = actingUserId(c);
  // Both balances are the ones for THIS cost's currency: a diamond cost is
  // quoted against the diamond wallet, never the credit one.
  const currency = credit.def.currency;
  const balance = payer !== null ? await getCreditBalance(c.env, payer, currency) : null;
  const sharedBalance = await getSharedCreditBalance(c.env, currency);
  const pluginBalance = await getPluginCreditBalance(c.env, auth.callerId, currency);
  const total = credit.value * quantity;
  announceBalances(c, auth.callerId, [currency]);
  announceContributor(c, auth.callerId);
  return c.json({
    key,
    currency,
    unit_cost: credit.value,
    quantity,
    total,
    balance,
    shared_balance: sharedBalance,
    plugin_balance: pluginBalance,
    plugin_only: credit.def.pluginOnly,
    // Each balance pays the full amount or nothing, so any eligible one
    // covering the total makes it affordable. A plugin-only cost has one.
    affordable: total === 0 || pluginBalance >= total
      || (!credit.def.pluginOnly && ((balance !== null && balance >= total) || sharedBalance >= total)),
  });
});

// Plugin-reported usage for metered costs the host can't observe (e.g. one
// EDM send per recipient). Only keys the calling plugin's manifest declares
// as metered are accepted — a plugin cannot invent ad-hoc charges — and the
// price still comes from the host-side configuration, never the request.
creditApiRoutes.post('/credits/charge', async (c) => {
  const auth = await authenticateCaller(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as {
    key?: unknown; quantity?: unknown; charge_id?: unknown; entity_type?: unknown; entity_id?: unknown; note?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return c.json({ error: 'key_required' }, 400);
  const quantity = Math.trunc(asFiniteNumber(body.quantity) ?? 1);
  if (quantity < 1 || quantity > 1_000_000) return c.json({ error: 'invalid_quantity' }, 400);

  const chargeId = body.charge_id;
  if (chargeId !== undefined && (typeof chargeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(chargeId))) {
    return c.json({ error: 'invalid_charge_id' }, 400);
  }
  const payer = actingUserId(c);
  if (payer === null) return c.json({ error: 'acting_user_required' }, 400);
  const entityType = typeof body.entity_type === 'string' ? body.entity_type.slice(0, 60) : undefined;
  const entityId = typeof body.entity_id === 'string' || typeof body.entity_id === 'number' ? String(body.entity_id).slice(0, 60) : undefined;
  const note = typeof body.note === 'string' ? body.note.slice(0, 300) : undefined;
  const receipt = chargeId === undefined ? undefined : {
    pluginId: auth.callerId,
    chargeId,
    fingerprint: await fingerprint(JSON.stringify([payer, key, quantity, entityType, entityId, note])),
  };
  const replay = async () => {
    if (!receipt) return null;
    const saved = await readChargeReceipt(c.env, receipt);
    if (!saved) return null;
    return saved.conflict ? c.json({ error: 'charge_id_conflict' }, 409) : c.json(saved.response);
  };
  const previous = await replay();
  if (previous) return previous;

  const credit = (await effectiveCreditsForId(c.env, auth.callerId)).find((entry) => entry.def.key === key);
  if (!credit) return c.json({ error: 'unknown_credit_key' }, 400);
  if (credit.def.charge !== 'metered') return c.json({ error: 'not_metered' }, 400);

  const currency = credit.def.currency;
  const total = credit.value * quantity;
  announceBalances(c, auth.callerId, [currency]);
  announceContributor(c, auth.callerId);
  const spend = () => spendCredits(c.env, {
    userId: payer,
    amount: total,
    currency,
    action: `${auth.callerId}:${key}`,
    entityType,
    entityId,
    note,
    pluginId: auth.callerId,
    // The calling plugin's own wallet pays its own metered cost first.
    scopePluginId: auth.callerId,
    pluginOnly: credit.def.pluginOnly,
    createdBy: `plugin:${auth.callerId}`,
    receipt,
  });

  let charge: Awaited<ReturnType<typeof spendCredits>>;
  try {
    if (total === 0) {
      if (!receipt) return c.json({ ok: true, charged: 0, currency, balance: await getCreditBalance(c.env, payer, currency) });
      await insertChargeReceipt(c.env, receipt, payer, currency, 0).run();
      const saved = await replay();
      if (!saved) throw new Error('Metered charge receipt unavailable');
      return saved;
    }
    charge = await spend();
  } catch (error) {
    // A concurrent request can win the receipt's unique constraint.
    const saved = await replay();
    if (saved) return saved;
    throw error;
  }
  // Read even after a decline. A concurrent debit may have used the last funds.
  const saved = await replay();
  if (saved) return saved;
  if (receipt && charge.ok) throw new Error('Metered charge receipt unavailable');
  if (!charge.ok) {
    if (charge.error === 'unknown_user') return c.json({ error: 'unknown_acting_user' }, 400);
    // The error code is the same for every wallet — `currency` says which one
    // fell short, so a caller can tell "buy diamonds" from "buy credits".
    return c.json(
      {
        error: 'insufficient_credits',
        credit: {
          currency,
          required: charge.required,
          balance: charge.balance,
          shared_balance: charge.sharedBalance,
          plugin_balance: charge.pluginBalance ?? 0,
          ...(charge.pluginOnly ? { plugin_only: true } : {}),
        },
      },
      402,
    );
  }
  // `balance` stays the user's own balance either way; when the shared pool
  // paid, the user's balance is unchanged and must be re-read.
  const balance = charge.source === 'user' ? charge.balanceAfter : await getCreditBalance(c.env, payer, currency);
  return c.json({ ok: true, charged: total, currency, balance, source: charge.source });
});

// A plugin's creator supplies credits to this site (positive amount) or takes
// them back (negative amount, never below zero). They land in the calling
// plugin's own wallet and pay only that plugin's costs, so a plugin can mint
// them freely: the most it can do is waive its own fees. `grant_id` makes the
// call idempotent — repeat it to retry safely; reusing one for a different
// amount or currency is a 409.
creditApiRoutes.post('/credits/plugin-grant', async (c) => {
  const auth = await authenticateCaller(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as {
    amount?: unknown; currency?: unknown; grant_id?: unknown; note?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const amount = asFiniteNumber(body.amount);
  if (amount === null || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000) {
    return c.json({ error: 'invalid_amount' }, 400);
  }
  const currency = body.currency === undefined ? undefined : body.currency;
  if (currency !== undefined && !isCreditCurrency(currency)) return c.json({ error: 'unknown_currency' }, 400);
  const grantId = typeof body.grant_id === 'string' ? body.grant_id.trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(grantId)) return c.json({ error: 'invalid_grant_id' }, 400);

  const result = await grantPluginCredits(c.env, {
    pluginId: auth.callerId,
    delta: amount,
    currency,
    grantId,
    note: typeof body.note === 'string' ? body.note.slice(0, 300) : undefined,
    createdBy: `plugin:${auth.callerId}`,
  });
  announceContributor(c, auth.callerId);
  if (!result.ok) {
    if (result.error === 'grant_conflict') return c.json({ error: 'grant_conflict' }, 409);
    return c.json({ error: 'insufficient_credits', balance: result.balance, required: result.required }, 402);
  }
  return c.json({
    ok: true,
    duplicate: result.duplicate,
    currency: result.currency,
    amount: result.delta,
    plugin_balance: result.balanceAfter,
  });
});

/** The subscription fields exposed to plugins (host bookkeeping omitted). */
function subscriptionJson(row: CreditSubscriptionRow) {
  return {
    key: row.credit_key,
    user_id: row.user_id,
    quantity: row.quantity,
    peak_quantity: row.peak_quantity,
    status: row.status,
    next_charge_at: row.next_charge_at,
    last_charged_at: row.last_charged_at,
  };
}

// Plugin-reported usage snapshot for recurring costs (e.g. stored records).
// Upserts the subscription row the cron sweep bills monthly; nothing is
// charged here, so a report can never fail on an empty balance. Like metered
// charges, only manifest-declared keys are accepted and the price comes from
// host-side configuration. `user_id` in the body (fallback: x-acting-user-id)
// says whose usage this is — the authenticated plugin is trusted to attribute
// usage, exactly as it is trusted for metered charges.
creditApiRoutes.post('/credits/usage', async (c) => {
  const auth = await authenticateCaller(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as {
    key?: unknown; quantity?: unknown; user_id?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return c.json({ error: 'key_required' }, 400);
  const quantity = Math.trunc(asFiniteNumber(body.quantity) ?? -1);
  if (quantity < 0 || quantity > 1_000_000_000) return c.json({ error: 'invalid_quantity' }, 400);

  const credit = (await effectiveCreditsForId(c.env, auth.callerId)).find((entry) => entry.def.key === key);
  if (!credit) return c.json({ error: 'unknown_credit_key' }, 400);
  if (credit.def.charge !== 'recurring') return c.json({ error: 'not_recurring' }, 400);

  const bodyUserId = Math.trunc(asFiniteNumber(body.user_id) ?? 0);
  const userId = bodyUserId > 0 ? bodyUserId : actingUserId(c);
  if (userId === null || userId <= 0) return c.json({ error: 'user_required' }, 400);

  const report = await reportSubscriptionUsage(c, auth, { userId, credit, quantity });
  if (!report.ok) return c.json({ error: 'unknown_user' }, 400);
  if (report.subscription) recordTableReads('credit.subscription-read', 'credit_subscriptions', [report.subscription.id], readActor(c, auth.callerId));
  announceContributor(c, auth.callerId);
  return c.json({
    ok: true,
    currency: credit.def.currency,
    subscription: report.subscription ? subscriptionJson(report.subscription) : null,
  });
});

// The calling plugin's recurring subscriptions — for enforcement (a plugin
// should go read-only on a 'past_due' storage subscription) and plugin UIs.
// Optional ?user_id= narrows to one user.
creditApiRoutes.get('/credits/subscriptions', async (c) => {
  const auth = await authenticateCaller(c);
  if (auth instanceof Response) return auth;

  const rawUser = c.req.query('user_id');
  let userId: number | undefined;
  if (rawUser !== undefined) {
    userId = Math.trunc(asFiniteNumber(rawUser) ?? 0);
    if (userId <= 0) return c.json({ error: 'invalid_user_id' }, 400);
  }
  const rows = await listSubscriptionsForPlugin(c.env, auth.callerId, userId);
  recordTableReads('credit.subscription-read', 'credit_subscriptions', rows.map(row => row.id), readActor(c, auth.callerId));
  announceContributor(c, auth.callerId);
  return c.json({ subscriptions: rows.map(subscriptionJson) });
});

// List pages of a content type the plugin owns.
