import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import cms from '../src/index';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { signJWT } from './auth-fixtures';
import {
  declaredCredits,
  getCreditBalances,
  getPluginCreditBalance,
  getPluginCreditBalances,
  grantPluginCredits,
  pageCreateAmounts,
  refundCurrencies,
  saveCreditValues,
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
  contentTypes: { blueprint: { broadcast: ['name:text/title'], memo: ['name:text/title'] } },
  credits: [
    { key: 'send_edm', label: 'Send EDM', charge: 'metered', unit: 'recipient', default: 2 },
    { key: 'send_sms', label: 'Send SMS', charge: 'metered', unit: 'message', currency: 'diamond', default: 3 },
    { key: 'storage', label: 'Storage', charge: 'recurring', unit: 'GB', default: 10 },
    { key: 'create_broadcast', label: 'Create a broadcast', charge: 'page_create', page_type: 'broadcast', default: 5 },
    // Paid only from the plugin's own wallet.
    { key: 'ai_summary', label: 'AI summary', charge: 'metered', unit: 'summary', default: 4, plugin_only: true },
    { key: 'archive', label: 'Archive', charge: 'recurring', unit: 'GB', default: 6, plugin_only: true },
    { key: 'create_memo', label: 'Create a memo', charge: 'page_create', page_type: 'memo', default: 7, plugin_only: true },
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

function pluginRequest(userId: number, method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-plugin-secret': PLUGIN_SECRET,
      'x-plugin-id': PLUGIN_ID,
      'x-acting-user-id': String(userId),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function cmsApiAs(userId: number, method: string, path: string, body?: unknown): Promise<Response> {
  return worker.fetch(pluginRequest(userId, method, path, body));
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
  await env.DB.prepare('DELETE FROM plugin_charge_receipts').run();
  await env.DB.prepare('DELETE FROM plugin_credits').run();
  await env.DB.prepare('DELETE FROM credit_subscriptions').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.credits.%'").run();
  await env.DB.prepare("DELETE FROM pages WHERE page_type IN ('broadcast', 'memo')").run();
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

  it.each([
    { source: 'plugin', table: 'plugin_credit_ledger' },
    { source: 'user', table: 'credit_ledger' },
    { source: 'shared', table: 'shared_credit_ledger' },
  ])('debits the $source wallet once when charge retries overlap', async ({ source, table }) => {
    if (source === 'plugin') await fund(PLUGIN_ID, 20);
    if (source === 'user') await seedUser(PAYER_ID, 40);
    if (source !== 'user') await seedPool('credit', 40);

    const body = { key: 'send_edm', quantity: 10, charge_id: 'edm:batch-1', entity_id: 'batch-1' };
    const path = '/__cms/credits/charge';
    const charge = (payload = body, payer = PAYER_ID) => cmsApiAs(payer, 'POST', path, payload);
    // Start the competing request after the first has missed the receipt and
    // reached the debit batch for this wallet, but before that batch runs.
    const session = env.DB.withSession('first-primary');
    let debitPrepared = false;
    let competingResponse: Response | undefined;
    const DB = {
      withSession: () => ({
        prepare(sql: string) {
          if (sql.startsWith(`INSERT INTO ${table} (`)) debitPrepared = true;
          return session.prepare(sql);
        },
        async batch(statements: D1PreparedStatement[]) {
          if (debitPrepared && !competingResponse) competingResponse = await charge();
          return session.batch(statements);
        },
      }),
    } as D1Database;
    const ctx = createExecutionContext();
    const firstResponse = await cms.fetch(pluginRequest(PAYER_ID, 'POST', path, body), { ...env, DB }, ctx);
    await waitOnExecutionContext(ctx);
    expect(competingResponse).toBeDefined();
    const original = { ok: true, charged: 20, currency: 'credit', balance: source === 'user' ? 20 : 0, source };
    for (const response of [firstResponse, competingResponse!]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(original);
    }

    await seedUser(PAYER_ID, 100);
    expect(await (await charge()).json()).toEqual(original);
    for (const conflict of [await charge({ ...body, quantity: 1 }), await charge(body, ADMIN_ID)]) {
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: 'charge_id_conflict' });
    }
    for (const ledger of ['plugin_credit_ledger', 'credit_ledger', 'shared_credit_ledger']) {
      const spends = await env.DB.prepare(`SELECT delta FROM ${ledger} WHERE action = ?`)
        .bind(`${PLUGIN_ID}:send_edm`).all();
      expect(spends.results).toEqual(ledger === table ? [{ delta: -20 }] : []);
    }
  });

  it('allows the same charge ID after an insufficient-funds response', async () => {
    const charge = () => cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', {
      key: 'send_edm', charge_id: 'retry-after-top-up',
    });
    expect((await charge()).status).toBe(402);
    await seedUser(PAYER_ID, 5);
    expect(await (await charge()).json()).toMatchObject({ ok: true, charged: 2, balance: 3 });
  });

  it('replays a zero-price charge after the host changes the price', async () => {
    await saveCreditValues(env, PLUGIN_ID, { send_edm: 0 });
    await seedUser(PAYER_ID, 5);
    const charge = () => cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', {
      key: 'send_edm', charge_id: 'free-send',
    });
    const original = { ok: true, charged: 0, currency: 'credit', balance: 5 };
    expect(await (await charge()).json()).toEqual(original);
    await saveCreditValues(env, PLUGIN_ID, { send_edm: 2 });
    expect(await (await charge()).json()).toEqual(original);
    expect((await getCreditBalances(env, PAYER_ID))?.credit).toBe(5);
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

describe('plugin-only costs', () => {
  it('reads plugin_only from the manifest, strictly', () => {
    const defs = declaredCredits({
      id: PLUGIN_ID,
      name: 'Messaging Suite',
      credits: [...(MANIFEST.credits ?? []), { key: 'loose', charge: 'metered', plugin_only: 'yes' }] as never,
      pricablePageTypes: new Set(['broadcast', 'memo']),
    });
    const byKey = new Map(defs.map((def) => [def.key, def.pluginOnly]));
    expect(byKey.get('ai_summary')).toBe(true);
    expect(byKey.get('create_memo')).toBe(true);
    expect(byKey.get('send_edm')).toBe(false);
    expect(byKey.get('loose')).toBe(false);
  });

  it('charges the plugin wallet', async () => {
    await fund(PLUGIN_ID, 10);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'ai_summary', quantity: 2 });
    expect(await res.json()).toMatchObject({ ok: true, charged: 8, source: 'plugin' });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(2);
  });

  it('refuses instead of falling back to the member or the pool', async () => {
    await seedUser(PAYER_ID, 1000);
    await seedPool('credit', 1000);
    await fund(PLUGIN_ID, 3);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'ai_summary', quantity: 1 });
    expect(res.status).toBe(402);
    expect((await res.json() as { credit: unknown }).credit)
      .toEqual({ currency: 'credit', required: 4, balance: 0, shared_balance: 0, plugin_balance: 3, plugin_only: true });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 1000, diamond: 0 });
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(3);
  });

  it('quotes against the plugin wallet only', async () => {
    await seedUser(PAYER_ID, 1000);
    const quote = await (await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits/quote?key=ai_summary&quantity=1')).json();
    expect(quote).toMatchObject({ plugin_only: true, plugin_balance: 0, affordable: false });
    const list = await (await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits')).json() as { credits: Array<{ key: string; plugin_only: boolean }> };
    expect(list.credits.find((credit) => credit.key === 'ai_summary')?.plugin_only).toBe(true);
    expect(list.credits.find((credit) => credit.key === 'send_edm')?.plugin_only).toBe(false);
  });

  it('blocks a page create the plugin wallet cannot cover', async () => {
    await seedUser(PAYER_ID, 1000);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'memo', name: 'M1' });
    expect(res.status).toBe(402);
    expect((await res.json() as { credit: unknown }).credit)
      .toMatchObject({ required: 7, plugin_only: true, plugin_id: PLUGIN_ID, plugin_balance: 0 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 1000, diamond: 0 });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'memo'").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('creates the page when the plugin wallet covers it', async () => {
    await fund(PLUGIN_ID, 7);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'memo', name: 'M1' });
    expect(res.status).toBe(201);
    expect(await getPluginCreditBalance(env, PLUGIN_ID)).toBe(0);
  });

  it('refunds earlier parts when a plugin-only part is refused', async () => {
    await fund(OTHER_PLUGIN_ID, 50);
    const spend = await spendCurrencies(env, {
      userId: PAYER_ID,
      amounts: [
        { currency: 'credit', amount: 10, scopePluginId: OTHER_PLUGIN_ID },
        { currency: 'credit', amount: 5, scopePluginId: PLUGIN_ID, pluginOnly: true },
      ],
      action: 'page_create:memo',
      createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'insufficient_credits', pluginOnly: true, pluginId: PLUGIN_ID });
    expect(await getPluginCreditBalance(env, OTHER_PLUGIN_ID)).toBe(50);
  });

  it('reports an unknown user, not a short wallet', async () => {
    const spend = await spendCredits(env, {
      userId: 999999, amount: 4, action: 'x', scopePluginId: PLUGIN_ID, pluginOnly: true, createdBy: 'test',
    });
    expect(spend).toMatchObject({ ok: false, error: 'unknown_user', pluginOnly: true });
  });

  it('marks a recurring subscription past due instead of billing the member', async () => {
    await seedUser(PAYER_ID, 1000);
    await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/usage', { key: 'archive', quantity: 1 });
    expect(await sweepCreditSubscriptions(env)).toMatchObject({ processed: 1, pastDue: 1 });
    expect(await getCreditBalances(env, PAYER_ID)).toEqual({ credit: 1000, diamond: 0 });
  });

  it('marks plugin-only costs on the pricing screen', async () => {
    const html = await (await adminFetch(`/admin/plugins-manage/${pluginRowId}/credits`)).text();
    expect(html).toContain('"key":"ai_summary"');
    expect(html).toMatch(/"key":"ai_summary"[^}]*"pluginOnly":true/);
    expect(html).toMatch(/"key":"send_edm"[^}]*"pluginOnly":false/);
  });
});
