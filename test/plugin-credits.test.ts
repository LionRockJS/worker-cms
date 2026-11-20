import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { signJWT } from './auth-fixtures';
import {
  getCreditBalances,
  getPluginCreditBalance,
  getPluginCreditBalances,
  grantPluginCredits,
  pageCreateAmounts,
  refundCurrencies,
  spendCredits,
  spendCurrencies,
} from '../src/features/credits/service';
import { sweepCreditSubscriptions } from '../src/features/credits/subscriptions';
import type { JWTPayload } from '../src/types';
import type { PluginManifest } from '../src/features/plugins/types';

// Plugin wallets: credits a plugin's creator supplies to the site. The rules
// under test: they pay only that plugin's own costs, before the member's
// balance and the shared pool; a grant is idempotent by grant_id; and the
// wallet is forfeited when the plugin is unregistered.

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'messaging';
const OTHER_PLUGIN_ID = 'events';
const PLUGIN_SECRET = 'test-plugin-secret-value';
const ADMIN_ID = 1;
const PAYER_ID = 901;

const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Messaging Suite',
  version: '1.0.0',
  contentTypes: { blueprint: { broadcast: ['name:text/title'] } },
  credits: [
    { key: 'send_edm', label: 'Send EDM', charge: 'metered', unit: 'recipient', default: 2 },
    { key: 'send_sms', label: 'Send SMS', charge: 'metered', unit: 'message', currency: 'diamond', default: 3 },
    { key: 'storage', label: 'Storage', charge: 'recurring', unit: 'GB', default: 10 },
    { key: 'create_broadcast', label: 'Create a broadcast', charge: 'page_create', page_type: 'broadcast', default: 5 },
  ],
} as unknown as PluginManifest;

let ipCounter = 0;
let pluginRowId = 0;

async function registerPlugin(): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  const row = await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?) RETURNING id')
    .bind('Messaging', url, PLUGIN_SECRET).first<{ id: number }>();
  pluginRowId = row!.id;
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
  headers.set('CF-Connecting-IP', `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers }));
}

async function seedUser(id: number, credits: number, diamonds = 0): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, oauth_id, email, name, role)
       VALUES (?, ?, ?, 'Test User', 'admin')
       ON CONFLICT(id) DO NOTHING`,
    ).bind(id, `test:${id}`, `user${id}@example.com`),
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

function fund(pluginId: string, amount: number, currency: 'credit' | 'diamond' = 'credit') {
  return grantPluginCredits(env, {
    pluginId, delta: amount, currency, grantId: `seed-${crypto.randomUUID()}`, createdBy: 'test',
  });
}

async function walletLedger(pluginId: string) {
  const rows = await env.DB.prepare(
    'SELECT currency, delta, balance_after, action, user_id FROM plugin_credit_ledger WHERE plugin_id = ? ORDER BY id',
  ).bind(pluginId).all();
  return rows.results;
}

let savedSecret: unknown;

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM credit_ledger').run();
  await env.DB.prepare('DELETE FROM shared_credit_ledger').run();
  await env.DB.prepare('DELETE FROM plugin_credit_ledger').run();
  await env.DB.prepare('DELETE FROM plugin_credits').run();
  await env.DB.prepare('DELETE FROM credit_subscriptions').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.credits.%'").run();
  await env.DB.prepare("DELETE FROM pages WHERE page_type = 'broadcast'").run();
  await seedPool('credit', 0);
  await seedPool('diamond', 0);
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  await registerPlugin();
  await seedUser(ADMIN_ID, 0);
  await seedUser(PAYER_ID, 0);
});

afterEach(() => {
  testEnv.PLUGIN_SECRET = savedSecret;
});

describe('spend order', () => {
  it('pays from the plugin wallet before the member and the pool', async () => {
    await seedUser(PAYER_ID, 100);
    await seedPool('credit', 100);
    await fund(PLUGIN_ID, 50);
    const spend = await spendCredits(env, {
      userId: PAYER_ID, amount: 30, action: 'messaging:send_edm', scopePluginId: PLUGIN_ID, createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: true, source: 'plugin', balanceAfter: 20 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 100, diamond: 0 });
    expect((await walletLedger(PLUGIN_ID)).at(-1)).toMatchObject({ delta: -30, balance_after: 20, user_id: PAYER_ID });
  });

  it('falls back to the member for the FULL amount when the wallet is short', async () => {
    await seedUser(PAYER_ID, 100);
    await fund(PLUGIN_ID, 10);
    const spend = await spendCredits(env, {
      userId: PAYER_ID, amount: 25, action: 'messaging:send_edm', scopePluginId: PLUGIN_ID, createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: true, source: 'user', balanceAfter: 75 });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(10);
  });

  it('never spends another plugin\'s wallet', async () => {
    await fund(OTHER_PLUGIN_ID, 1000);
    const spend = await spendCredits(env, {
      userId: PAYER_ID, amount: 5, action: 'messaging:send_edm', scopePluginId: PLUGIN_ID, createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'insufficient_credits', pluginBalance: 0 });
    expect(await getPluginCreditBalance(env, OTHER_PLUGIN_ID)).toBe(1000);
  });

  it('is never spent without a scope', async () => {
    await fund(PLUGIN_ID, 1000);
    const spend = await spendCredits(env, { userId: PAYER_ID, amount: 5, action: 'x', createdBy: 'test' });
    expect(spend).toMatchObject({ ok: false, error: 'insufficient_credits' });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(1000);
  });

  it('keeps currencies apart', async () => {
    await fund(PLUGIN_ID, 1000, 'credit');
    const spend = await spendCredits(env, {
      userId: PAYER_ID, amount: 3, currency: 'diamond', action: 'messaging:send_sms', scopePluginId: PLUGIN_ID, createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'insufficient_credits' });
  });

  it('never pays for an unknown user', async () => {
    await fund(PLUGIN_ID, 1000);
    const spend = await spendCredits(env, {
      userId: 999999, amount: 5, action: 'x', scopePluginId: PLUGIN_ID, createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'unknown_user' });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(1000);
  });
});

describe('multi-plugin page-create costs', () => {
  const cost = {
    totals: { credit: 15, diamond: 0 },
    total: 15,
    parts: [
      { pluginId: PLUGIN_ID, key: 'a', label: 'A', currency: 'credit' as const, value: 5 },
      { pluginId: OTHER_PLUGIN_ID, key: 'b', label: 'B', currency: 'credit' as const, value: 10 },
    ],
  };

  it('splits the cost into one part per plugin', () => {
    expect(pageCreateAmounts(cost, 2)).toEqual([
      { currency: 'credit', amount: 10, scopePluginId: PLUGIN_ID },
      { currency: 'credit', amount: 20, scopePluginId: OTHER_PLUGIN_ID },
    ]);
  });

  it('lets each plugin pay only its own part; the rest is one member charge', async () => {
    await seedUser(PAYER_ID, 100);
    await fund(PLUGIN_ID, 50);
    const spend = await spendCurrencies(env, {
      userId: PAYER_ID, amounts: pageCreateAmounts(cost), action: 'page_create:broadcast', createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: true });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(45);
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 90, diamond: 0 });
  });

  it('refunds the plugin part when the member part is refused', async () => {
    await fund(PLUGIN_ID, 50);
    const spend = await spendCurrencies(env, {
      userId: PAYER_ID, amounts: pageCreateAmounts(cost), action: 'page_create:broadcast', createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'insufficient_credits', required: 10 });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(50);
  });

  it('refunds a plugin-paid part back to the plugin wallet', async () => {
    await fund(PLUGIN_ID, 50);
    await fund(OTHER_PLUGIN_ID, 50);
    const spend = await spendCurrencies(env, {
      userId: PAYER_ID, amounts: pageCreateAmounts(cost), action: 'page_create:broadcast', createdBy: 'test',
    });
    if (!spend.ok) throw new Error('spend refused');
    await refundCurrencies(env, { userId: PAYER_ID, action: 'page_create:broadcast', createdBy: 'test', spent: spend.spent });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(50);
    expect(await getPluginCreditBalance(env, OTHER_PLUGIN_ID)).toBe(50);
  });

  it('charges the plugin wallet through the write-back API', async () => {
    await fund(PLUGIN_ID, 12);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'broadcast', name: 'B1' });
    expect(res.status).toBe(201);
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(7);
  });
});

describe('grant API', () => {
  it('grants credits to the calling plugin\'s wallet', async () => {
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: 500, grant_id: 'pack-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false, currency: 'credit', amount: 500, plugin_balance: 500 });
    expect(await getPluginCreditBalances(env, PLUGIN_ID)).toEqual({ credit: 500, diamond: 0 });
  });

  it('is idempotent by grant_id', async () => {
    await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: 500, grant_id: 'pack-1' });
    const again = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: 500, grant_id: 'pack-1' });
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true, plugin_balance: 500 });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(500);
  });

  it('rejects a reused grant_id with a different amount', async () => {
    await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: 500, grant_id: 'pack-1' });
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: 900, grant_id: 'pack-1' });
    expect(res.status).toBe(409);
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(500);
  });

  it('takes credits back, never below zero', async () => {
    await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: 50, grant_id: 'pack-1' });
    const over = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: -80, grant_id: 'revoke-1' });
    expect(over.status).toBe(402);
    const ok = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', { amount: -20, grant_id: 'revoke-2' });
    expect(await ok.json()).toMatchObject({ ok: true, plugin_balance: 30 });
  });

  it('validates its input', async () => {
    for (const body of [{ amount: 0, grant_id: 'g' }, { amount: 1.5, grant_id: 'g' }, { amount: 5 }, { amount: 5, grant_id: 'g', currency: 'gold' }]) {
      const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/plugin-grant', body);
      expect(res.status).toBe(400);
    }
  });

  it('pays a metered charge from the wallet and reports it', async () => {
    await seedUser(PAYER_ID, 100);
    await fund(PLUGIN_ID, 40);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'send_edm', quantity: 10 });
    expect(await res.json()).toMatchObject({ ok: true, charged: 20, source: 'plugin', balance: 100 });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(20);
  });

  it('reports plugin balances in the listing, the quote and a refusal', async () => {
    await fund(PLUGIN_ID, 8);
    const list = await (await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits')).json() as Record<string, unknown>;
    expect(list.plugin_balances).toEqual({ credit: 8, diamond: 0 });
    const quote = await (await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits/quote?key=send_edm&quantity=4')).json();
    expect(quote).toMatchObject({ total: 8, plugin_balance: 8, affordable: true });
    const refused = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'send_edm', quantity: 5 });
    expect(refused.status).toBe(402);
    expect((await refused.json() as { credit: unknown }).credit).toMatchObject({ plugin_balance: 8 });
  });
});

describe('recurring subscriptions', () => {
  it('bills the sweep from the plugin wallet first', async () => {
    await seedUser(PAYER_ID, 500);
    await fund(PLUGIN_ID, 100);
    await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/usage', { key: 'storage', quantity: 3 });
    expect(await sweepCreditSubscriptions(env)).toMatchObject({ processed: 1, charged: 1 });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(70);
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 500, diamond: 0 });
  });
});

describe('admin screens', () => {
  it('shows the wallet on the plugin credits screen', async () => {
    await fund(PLUGIN_ID, 321);
    const res = await adminFetch(`/admin/plugins-manage/${pluginRowId}/credits`);
    expect(res.status).toBe(200);
    // The view renders client-side; assert on the payload it is handed.
    const html = await res.text();
    expect(html).toContain('"hasWallet":true');
    expect(html).toContain('"currency":"credit","currencyKey":"credits.currency.credit","unitKey":"credits.unit.credit","balance":321');
    expect(html).toContain('"action":"plugin:grant"');
  });

  it('forfeits the wallet when the plugin is unregistered', async () => {
    await env.DB.prepare('INSERT OR IGNORE INTO plugin_identity_approvals (plugin_row_id, manifest_id) VALUES (?, ?)')
      .bind(pluginRowId, PLUGIN_ID).run();
    await fund(PLUGIN_ID, 75);
    await fund(PLUGIN_ID, 4, 'diamond');
    await fund(OTHER_PLUGIN_ID, 9);
    const res = await adminFetch(`/admin/plugins-manage/${pluginRowId}/delete`, { method: 'POST' });
    expect(res.status).toBe(302);
    expect(await getPluginCreditBalances(env, PLUGIN_ID)).toEqual({ credit: 0, diamond: 0 });
    expect((await walletLedger(PLUGIN_ID)).filter((row) => row.action === 'plugin:forfeit')).toHaveLength(2);
    expect(await getPluginCreditBalance(env, OTHER_PLUGIN_ID)).toBe(9);
  });
});
