import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { signJWT } from './auth-fixtures';
import {
  adjustSharedCredits,
  chargeCredits,
  declaredCredits,
  getCreditBalance,
  getCreditBalances,
  getSharedCreditBalance,
  getSharedCreditBalances,
  pageCreateCostForType,
  spendCredits,
  spendCurrencies,
  transferCredits,
} from '../src/features/credits/service';
import { sweepCreditSubscriptions } from '../src/features/credits/subscriptions';
import type { JWTPayload } from '../src/types';
import type { PluginManifest } from '../src/features/plugins/types';
import type { CreditContributor } from '../src/features/credits/contracts';

// The diamond currency: a second wallet with its own per-user balance, its own
// shared pool and its own ledger lines. The rule under test throughout is that
// the two never mix — a diamond cost is refused on an empty diamond balance
// however many credits the payer holds, and vice versa.

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'messaging';
const PLUGIN_SECRET = 'test-plugin-secret-value';
const ADMIN_ID = 1;
const PAYER_ID = 901;

const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Messaging Suite',
  version: '1.0.0',
  contentTypes: { blueprint: { broadcast: ['name:text/title'] } },
  credits: [
    // Real money leaves the operator's pocket for these, so they are priced
    // in diamonds rather than credits.
    { key: 'send_sms', label: 'Send SMS', charge: 'metered', unit: 'message', currency: 'diamond', default: 3 },
    { key: 'send_whatsapp', label: 'Send WhatsApp', charge: 'metered', unit: 'message', currency: 'diamond', default: 2 },
    { key: 'sms_number', label: 'SMS number', charge: 'recurring', unit: 'number', currency: 'diamond', default: 15 },
    // No currency → the ordinary credit wallet.
    { key: 'send_edm', label: 'Send EDM', charge: 'metered', unit: 'recipient', default: 2 },
    { key: 'create_broadcast', label: 'Create a broadcast', charge: 'page_create', page_type: 'broadcast', currency: 'diamond', default: 5 },
    // Unknown currency → dropped, never silently billed to another wallet.
    { key: 'send_pigeon', label: 'Send pigeon', charge: 'metered', currency: 'gold', default: 9 },
  ],
} as unknown as PluginManifest;

let ipCounter = 0;

async function registerPlugin(): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
    .bind('Messaging', url, PLUGIN_SECRET).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(href).pathname;
      if (path === '/__plugin/manifest') return Response.json(MANIFEST);
      if (path.startsWith('/__plugin/hooks/')) return new Response('ok');
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

function cmsApiAs(userId: number, method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-plugin-secret': PLUGIN_SECRET,
      'x-plugin-id': PLUGIN_ID,
      'x-acting-user-id': String(userId),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: String(ADMIN_ID),
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  const headers = new Headers(init.headers);
  headers.set('Cookie', `access_token=${token}`);
  headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers }));
}

function postForm(path: string, fields: Record<string, string>): Promise<Response> {
  return adminFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
}

async function seedUser(id: number, credits: number, diamonds: number, role = 'admin'): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, oauth_id, email, name, role)
       VALUES (?, ?, ?, 'Test User', ?)
       ON CONFLICT(id) DO UPDATE SET role = excluded.role`,
    ).bind(id, `test:${id}`, `user${id}@example.com`, role),
    env.DB.prepare(
      `INSERT INTO credit_wallets (user_id, currency, balance) VALUES (?, 'credit', ?)
       ON CONFLICT(user_id, currency) DO UPDATE SET balance = excluded.balance`,
    ).bind(id, credits),
    env.DB.prepare(
      `INSERT INTO credit_wallets (user_id, currency, balance) VALUES (?, 'diamond', ?)
       ON CONFLICT(user_id, currency) DO UPDATE SET balance = excluded.balance`,
    ).bind(id, diamonds),
  ]);
}

async function seedPool(currency: 'credit' | 'diamond', amount: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO shared_credits (currency, balance) VALUES (?, ?)
     ON CONFLICT(currency) DO UPDATE SET balance = excluded.balance`,
  ).bind(currency, amount).run();
}

async function ledgerRows(id: number): Promise<Array<{ currency: string; delta: number; action: string }>> {
  const rows = await env.DB.prepare(
    'SELECT currency, delta, action FROM credit_ledger WHERE user_id = ? ORDER BY id ASC',
  ).bind(id).all<{ currency: string; delta: number; action: string }>();
  return rows.results;
}

let savedSecret: unknown;

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
  await env.DB.prepare('DELETE FROM credit_ledger').run();
  await env.DB.prepare('DELETE FROM shared_credit_ledger').run();
  await env.DB.prepare('DELETE FROM credit_subscriptions').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.credits.%'").run();
  await env.DB.prepare("DELETE FROM pages WHERE page_type = 'broadcast'").run();
  await seedPool('credit', 0);
  await seedPool('diamond', 0);
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  await registerPlugin();
  await seedUser(ADMIN_ID, 0, 0);
  await seedUser(PAYER_ID, 0, 0);
});

afterEach(() => {
  testEnv.PLUGIN_SECRET = savedSecret;
});

describe('declared currency', () => {
  const contributor: CreditContributor = {
    id: PLUGIN_ID,
    name: 'Messaging Suite',
    credits: MANIFEST.credits ?? [],
    pricablePageTypes: new Set(['broadcast']),
  };

  it('honors a declared currency and defaults the rest to credits', () => {
    const byKey = new Map(declaredCredits(contributor).map((def) => [def.key, def]));
    expect(byKey.get('send_sms')!.currency).toBe('diamond');
    expect(byKey.get('send_whatsapp')!.currency).toBe('diamond');
    expect(byKey.get('create_broadcast')!.currency).toBe('diamond');
    expect(byKey.get('send_edm')!.currency).toBe('credit');
  });

  it('drops a cost declaring an unknown currency rather than billing credits', () => {
    expect(declaredCredits(contributor).map((def) => def.key)).not.toContain('send_pigeon');
  });
});

describe('per-user diamond balance', () => {
  it('deducts diamonds and leaves credits untouched', async () => {
    await seedUser(PAYER_ID, 500, 40);
    const charge = await chargeCredits(env, {
      userId: PAYER_ID, amount: 15, currency: 'diamond', action: 'messaging:send_sms', createdBy: 'test',
    });
    expect(charge).toMatchObject({ ok: true, balanceAfter: 25 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 500, diamond: 25 });
    expect(await ledgerRows(PAYER_ID)).toEqual([
      { currency: 'diamond', delta: -15, action: 'messaging:send_sms' },
    ]);
  });

  it('refuses a diamond charge on an empty diamond balance, however many credits are held', async () => {
    await seedUser(PAYER_ID, 10_000, 2);
    const charge = await chargeCredits(env, {
      userId: PAYER_ID, amount: 5, currency: 'diamond', action: 'messaging:send_sms', createdBy: 'test',
    });
    expect(charge).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 2, required: 5 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 10_000, diamond: 2 });
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
  });

  it('transfers diamonds between users without touching either credit balance', async () => {
    await seedUser(PAYER_ID, 100, 50);
    await seedUser(902, 7, 0, 'editor');
    const result = await transferCredits(env, {
      fromUserId: PAYER_ID, toUserId: 902, amount: 30, currency: 'diamond', createdBy: String(PAYER_ID),
    });
    expect(result).toMatchObject({ ok: true, senderBalance: 20, recipientBalance: 30 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 100, diamond: 20 });
    expect(await getCreditBalances(env, 902)).toEqual({ credit: 7, diamond: 30 });
  });
});

describe('shared diamond pool', () => {
  it('covers a diamond spend the user cannot afford', async () => {
    await seedUser(PAYER_ID, 0, 1);
    await seedPool('diamond', 100);
    const spend = await spendCredits(env, {
      userId: PAYER_ID, amount: 12, currency: 'diamond', action: 'messaging:send_sms', createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: true, source: 'shared', balanceAfter: 88 });
    expect(await getCreditBalance(env, PAYER_ID, 'diamond')).toBe(1);
    expect(await getSharedCreditBalances(env)).toEqual({ credit: 0, diamond: 88 });
  });

  it('never pays a diamond spend out of the credit pool', async () => {
    await seedUser(PAYER_ID, 0, 0);
    await seedPool('credit', 10_000);
    const spend = await spendCredits(env, {
      userId: PAYER_ID, amount: 5, currency: 'diamond', action: 'messaging:send_sms', createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 0, sharedBalance: 0 });
    expect(await getSharedCreditBalance(env, 'credit')).toBe(10_000);
  });

  it('keeps each pool ledger to its own currency', async () => {
    await adjustSharedCredits(env, { delta: 40, currency: 'diamond', action: 'admin:adjust', createdBy: '1' });
    await adjustSharedCredits(env, { delta: 90, action: 'admin:adjust', createdBy: '1' });
    const rows = await env.DB.prepare('SELECT currency, delta, balance_after FROM shared_credit_ledger ORDER BY id')
      .all<{ currency: string; delta: number; balance_after: number }>();
    expect(rows.results).toEqual([
      { currency: 'diamond', delta: 40, balance_after: 40 },
      { currency: 'credit', delta: 90, balance_after: 90 },
    ]);
  });
});

describe('multi-currency spends', () => {
  it('spends every wallet a cost touches', async () => {
    await seedUser(PAYER_ID, 100, 20);
    const spend = await spendCurrencies(env, {
      userId: PAYER_ID,
      amounts: [{ currency: 'credit', amount: 30 }, { currency: 'diamond', amount: 5 }],
      action: 'messaging:blast',
      createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: true });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 70, diamond: 15 });
  });

  it('rolls the first wallet back when a later one is short', async () => {
    await seedUser(PAYER_ID, 100, 1);
    const spend = await spendCurrencies(env, {
      userId: PAYER_ID,
      amounts: [{ currency: 'credit', amount: 30 }, { currency: 'diamond', amount: 5 }],
      action: 'messaging:blast',
      createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'insufficient_credits', currency: 'diamond', required: 5 });
    // The credit debit is compensated, so the payer is left whole; both the
    // spend and its refund stay on the ledger.
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 100, diamond: 1 });
    expect(await ledgerRows(PAYER_ID)).toEqual([
      { currency: 'credit', delta: -30, action: 'messaging:blast' },
      { currency: 'credit', delta: 30, action: 'messaging:blast:refund' },
    ]);
  });
});

describe('plugin credit API', () => {
  it('charges a diamond-priced metered action against the diamond wallet', async () => {
    await seedUser(PAYER_ID, 60, 30);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'send_sms', quantity: 4 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, charged: 12, currency: 'diamond', balance: 18 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 60, diamond: 18 });
  });

  it('refuses with 402 naming the currency that fell short', async () => {
    await seedUser(PAYER_ID, 10_000, 5);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'send_whatsapp', quantity: 10 });
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string; credit: Record<string, unknown> };
    expect(body.error).toBe('insufficient_credits');
    expect(body.credit).toEqual({ currency: 'diamond', required: 20, balance: 5, shared_balance: 0 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 10_000, diamond: 5 });
  });

  it('quotes a diamond cost against the diamond balances', async () => {
    await seedUser(PAYER_ID, 10_000, 6);
    await seedPool('diamond', 4);
    const res = await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits/quote?key=send_sms&quantity=2');
    expect(await res.json()).toMatchObject({
      key: 'send_sms', currency: 'diamond', unit_cost: 3, total: 6, balance: 6, shared_balance: 4, affordable: true,
    });
  });

  it('lists every wallet and each cost’s currency', async () => {
    await seedUser(PAYER_ID, 42, 7);
    await seedPool('diamond', 9);
    const res = await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits');
    const body = await res.json() as {
      balance: number; balances: Record<string, number>; shared_balances: Record<string, number>;
      credits: Array<{ key: string; currency: string }>;
    };
    expect(body.balance).toBe(42);
    expect(body.balances).toEqual({ credit: 42, diamond: 7 });
    expect(body.shared_balances).toEqual({ credit: 0, diamond: 9 });
    const byKey = new Map(body.credits.map((credit) => [credit.key, credit.currency]));
    expect(byKey.get('send_sms')).toBe('diamond');
    expect(byKey.get('send_edm')).toBe('credit');
  });
});

describe('diamond-priced page creates', () => {
  it('totals the cost per currency', async () => {
    const cost = await pageCreateCostForType(env, 'broadcast');
    expect(cost.totals).toEqual({ credit: 0, diamond: 5 });
    expect(cost.parts).toEqual([
      { pluginId: PLUGIN_ID, key: 'create_broadcast', label: 'Create a broadcast', currency: 'diamond', value: 5 },
    ]);
  });

  it('charges the diamond wallet through the write-back API', async () => {
    await seedUser(PAYER_ID, 0, 12);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'broadcast', name: 'B1' });
    expect(res.status).toBe(201);
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 0, diamond: 7 });
    expect(await ledgerRows(PAYER_ID)).toEqual([
      { currency: 'diamond', delta: -5, action: 'messaging:create_broadcast' },
    ]);
  });

  it('rejects the create with 402 when only credits are held', async () => {
    await seedUser(PAYER_ID, 10_000, 0);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'broadcast', name: 'B1' });
    expect(res.status).toBe(402);
    expect((await res.json() as { credit: unknown }).credit)
      .toEqual({ currency: 'diamond', required: 5, balance: 0, shared_balance: 0 });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'broadcast'")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('recurring diamond subscriptions', () => {
  it('bills the monthly sweep against the diamond wallet', async () => {
    await seedUser(PAYER_ID, 500, 60);
    const report = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/usage', { key: 'sms_number', quantity: 2 });
    expect(await report.json()).toMatchObject({ ok: true, currency: 'diamond' });

    const sweep = await sweepCreditSubscriptions(env);
    expect(sweep).toMatchObject({ processed: 1, charged: 1 });
    // 2 numbers × 15 diamonds, in advance.
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 500, diamond: 30 });
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ currency: 'diamond', delta: -30 });
  });
});

describe('admin wallets', () => {
  it('adjusts the diamond balance from the user edit page', async () => {
    await seedUser(PAYER_ID, 25, 0);
    const res = await postForm(`/admin/users/${PAYER_ID}/credits`, {
      amount: '40', note: 'topped up', currency: 'diamond',
    });
    expect(res.status).toBe(302);
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 25, diamond: 40 });
  });

  it('defaults to credits when the form names no currency', async () => {
    await seedUser(PAYER_ID, 0, 0);
    await postForm(`/admin/users/${PAYER_ID}/credits`, { amount: '15', note: 'welcome' });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 15, diamond: 0 });
  });

  it('ignores an unrecognised currency rather than inventing a wallet', async () => {
    await seedUser(PAYER_ID, 0, 0);
    await postForm(`/admin/users/${PAYER_ID}/credits`, { amount: '15', note: 'welcome', currency: 'gold' });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 15, diamond: 0 });
  });

  it('tops up and grants the diamond pool', async () => {
    await seedUser(PAYER_ID, 0, 0, 'editor');
    await postForm('/admin/users/shared-credits', { amount: '200', note: 'bought', currency: 'diamond' });
    expect(await getSharedCreditBalances(env)).toEqual({ credit: 0, diamond: 200 });

    const grant = await postForm(`/admin/users/${PAYER_ID}/credits/shared`, { amount: '50', currency: 'diamond' });
    expect(grant.status).toBe(302);
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 0, diamond: 50 });
    expect(await getSharedCreditBalances(env)).toEqual({ credit: 0, diamond: 150 });
  });

  it('donates diamonds to the pool from the profile', async () => {
    await seedUser(ADMIN_ID, 0, 80);
    const res = await postForm('/admin/profile/credits/shared', { amount: '30', currency: 'diamond' });
    expect(res.status).toBe(302);
    expect(await getCreditBalance(env, ADMIN_ID, 'diamond')).toBe(50);
    expect(await getSharedCreditBalances(env)).toEqual({ credit: 0, diamond: 30 });
  });

  it('renders a wallet card per currency on the profile', async () => {
    await seedUser(ADMIN_ID, 10, 4);
    const html = await (await adminFetch('/admin/profile')).text();
    expect(html).toContain('"currency":"diamond"');
    expect(html).toContain('credits.currency.diamond');
    expect(html).toContain('creditWallets');
  });
});
