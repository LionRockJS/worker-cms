import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { declaredCredits, getCreditBalance } from '../src/features/credits/service';
import {
  addMonthsUTC,
  blockCost,
  sqliteDate,
  sweepCreditSubscriptions,
  type CreditSubscriptionRow,
} from '../src/features/credits/subscriptions';
import type { PluginManifest } from '../src/features/plugins/types';

// Recurring credit billing: plugin-reported usage snapshots
// (POST /__cms/credits/usage) upsert subscription rows the cron sweep bills
// monthly — in advance (current quantity) or arrears (period peak).

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'events';
const PLUGIN_SECRET = 'test-plugin-secret-value';
const PAYER_ID = 601;

// record_storage: 50 credits per started block of 5000 records, in advance.
// archive_storage: 10 credits per started block of 1000 records, in arrears.
const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Events Suite',
  version: '1.0.0',
  contentTypes: { blueprint: { event: ['name:text/title'] } },
  credits: [
    { key: 'record_storage', label: 'Record storage', charge: 'recurring', unit: 'record', per: 5000, default: 50 },
    { key: 'archive_storage', label: 'Archive storage', charge: 'recurring', unit: 'record', per: 1000, default: 10, billing: 'arrears' },
    { key: 'send_edm', label: 'Send EDM email', charge: 'metered', unit: 'recipient', default: 2 },
    // Invalid recurring declarations → dropped.
    { key: 'weekly_thing', charge: 'recurring', period: 'week', default: 5 },
    { key: 'maybe_billing', charge: 'recurring', billing: 'sometimes', default: 5 },
  ],
} as unknown as PluginManifest;

function manifestFetcher(manifest: PluginManifest): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher;
}

let pluginUrl = '';

async function registerPlugin(): Promise<string> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Events', url, PLUGIN_SECRET).run();
  __injectPluginFetcher(url, manifestFetcher(MANIFEST));
  return url;
}

function cmsApi(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-plugin-secret': PLUGIN_SECRET,
      'x-plugin-id': PLUGIN_ID,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

function reportUsage(key: string, quantity: number, userId = PAYER_ID): Promise<Response> {
  return cmsApi('POST', '/__cms/credits/usage', { key, quantity, user_id: userId });
}

async function seedUser(id: number, credits: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, oauth_id, email, name, role)
       VALUES (?, ?, ?, 'Test User', 'editor')
       ON CONFLICT(id) DO UPDATE SET role = excluded.role`,
    ).bind(id, `test:${id}`, `user${id}@example.com`),
    env.DB.prepare(
      `INSERT INTO credit_wallets (user_id, currency, balance) VALUES (?, 'credit', ?)
       ON CONFLICT(user_id, currency) DO UPDATE SET balance = excluded.balance`,
    ).bind(id, credits),
  ]);
}

async function subscriptionRow(key: string, userId = PAYER_ID): Promise<CreditSubscriptionRow | null> {
  return env.DB.prepare(
    'SELECT * FROM credit_subscriptions WHERE user_id = ? AND plugin_id = ? AND credit_key = ?',
  ).bind(userId, PLUGIN_ID, key).first<CreditSubscriptionRow>();
}

async function ledgerRows(id: number): Promise<Array<{ delta: number; action: string; note: string | null }>> {
  const rows = await env.DB.prepare(
    'SELECT delta, action, note FROM credit_ledger WHERE user_id = ? ORDER BY id ASC',
  ).bind(id).all<{ delta: number; action: string; note: string | null }>();
  return rows.results;
}

/** Seconds between a stored SQLite timestamp and a Date — for "≈ now" checks. */
function secondsFrom(stored: string, date: Date): number {
  return Math.abs(new Date(`${stored.replace(' ', 'T')}Z`).getTime() - date.getTime()) / 1000;
}

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM credit_subscriptions').run();
  await env.DB.prepare('DELETE FROM credit_ledger').run();
  await env.DB.prepare('DELETE FROM shared_credit_ledger').run();
  await env.DB.prepare(
    `INSERT INTO shared_credits (currency, balance) VALUES ('credit', 0)
     ON CONFLICT(currency) DO UPDATE SET balance = excluded.balance`,
  ).run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.credits.%'").run();
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  pluginUrl = await registerPlugin();
  await seedUser(PAYER_ID, 0);
});

describe('declaredCredits recurring validation', () => {
  it('normalizes recurring costs and defaults billing to advance', () => {
    const defs = declaredCredits(MANIFEST, new Set(['event']));
    expect(defs.map((def) => def.key)).toEqual(['record_storage', 'archive_storage', 'send_edm']);
    expect(defs.find((def) => def.key === 'record_storage')).toMatchObject({
      charge: 'recurring', per: 5000, billing: 'advance', defaultValue: 50, unit: 'record',
    });
    expect(defs.find((def) => def.key === 'archive_storage')).toMatchObject({ per: 1000, billing: 'arrears' });
    // Non-recurring costs carry the neutral defaults.
    expect(defs.find((def) => def.key === 'send_edm')).toMatchObject({ per: 1, billing: null });
  });

  it('defaults per to 1 and drops out-of-range values', () => {
    const manifest = {
      ...MANIFEST,
      credits: [
        { key: 'no_per', charge: 'recurring', default: 3 },
        { key: 'neg_per', charge: 'recurring', per: -5, default: 3 },
      ],
    } as unknown as PluginManifest;
    const defs = declaredCredits(manifest, new Set());
    expect(defs.find((def) => def.key === 'no_per')!.per).toBe(1);
    expect(defs.find((def) => def.key === 'neg_per')!.per).toBe(1);
  });
});

describe('blockCost', () => {
  it('bills per started block', () => {
    expect(blockCost(7342, 5000, 50)).toBe(100);
    expect(blockCost(5000, 5000, 50)).toBe(50);
    expect(blockCost(1, 5000, 50)).toBe(50);
    expect(blockCost(0, 5000, 50)).toBe(0);
    expect(blockCost(10, 5000, 0)).toBe(0);
  });
});

describe('addMonthsUTC', () => {
  it('clamps the day of month', () => {
    expect(addMonthsUTC(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonthsUTC(new Date('2026-07-17T08:30:00Z'), 1).toISOString()).toBe('2026-08-17T08:30:00.000Z');
  });
});

describe('POST /__cms/credits/usage', () => {
  it('creates an advance subscription due immediately', async () => {
    const res = await reportUsage('record_storage', 7342);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; subscription: { status: string; quantity: number } };
    expect(body.ok).toBe(true);
    expect(body.subscription).toMatchObject({ key: 'record_storage', quantity: 7342, peak_quantity: 7342, status: 'active' });

    const row = (await subscriptionRow('record_storage'))!;
    expect(secondsFrom(row.next_charge_at, new Date())).toBeLessThan(60);
  });

  it('creates an arrears subscription due one month out', async () => {
    await reportUsage('archive_storage', 1500);
    const row = (await subscriptionRow('archive_storage'))!;
    expect(secondsFrom(row.next_charge_at, addMonthsUTC(new Date(), 1))).toBeLessThan(60);
  });

  it('replaces quantity but only ratchets the peak up', async () => {
    await reportUsage('archive_storage', 1500);
    await reportUsage('archive_storage', 400);
    let row = (await subscriptionRow('archive_storage'))!;
    expect(row.quantity).toBe(400);
    expect(row.peak_quantity).toBe(1500);

    await reportUsage('archive_storage', 2200);
    row = (await subscriptionRow('archive_storage'))!;
    expect(row.peak_quantity).toBe(2200);
  });

  it('never creates a row for a zero report', async () => {
    const res = await reportUsage('record_storage', 0);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { subscription: unknown }).subscription).toBeNull();
    expect(await subscriptionRow('record_storage')).toBeNull();
  });

  it('rejects unknown keys, non-recurring keys, and unknown users', async () => {
    expect((await reportUsage('nope', 10)).status).toBe(400);
    const metered = await reportUsage('send_edm', 10);
    expect(metered.status).toBe(400);
    expect(((await metered.json()) as { error: string }).error).toBe('not_recurring');
    expect((await reportUsage('record_storage', 10, 999_999)).status).toBe(400);
  });
});

describe('sweepCreditSubscriptions — advance', () => {
  it('bills the current snapshot for the coming month and advances the anchor', async () => {
    await seedUser(PAYER_ID, 500);
    await reportUsage('record_storage', 7342);

    const sweep = await sweepCreditSubscriptions(env);
    expect(sweep).toMatchObject({ processed: 1, charged: 1, pastDue: 0, canceled: 0 });
    expect(await getCreditBalance(env, PAYER_ID)).toBe(400); // 2 blocks × 50

    const rows = await ledgerRows(PAYER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: -100, action: 'events:record_storage' });

    const row = (await subscriptionRow('record_storage'))!;
    expect(row.status).toBe('active');
    expect(row.last_mode).toBe('advance');
    expect(secondsFrom(row.next_charge_at, addMonthsUTC(new Date(), 1))).toBeLessThan(120);

    // Not due again until the boundary.
    expect((await sweepCreditSubscriptions(env)).processed).toBe(0);
    const later = await sweepCreditSubscriptions(env, { now: new Date(addMonthsUTC(new Date(), 1).getTime() + 60_000) });
    expect(later.charged).toBe(1);
    expect(await getCreditBalance(env, PAYER_ID)).toBe(300);
  });

  it('flips to past_due on insufficient credits and retries daily', async () => {
    await reportUsage('record_storage', 100); // 1 block = 50, balance 0, pool 0
    const sweep = await sweepCreditSubscriptions(env);
    expect(sweep).toMatchObject({ processed: 1, charged: 0, pastDue: 1 });
    expect(await ledgerRows(PAYER_ID)).toHaveLength(0);

    let row = (await subscriptionRow('record_storage'))!;
    expect(row.status).toBe('past_due');
    expect(row.last_mode).toBeNull();
    expect(secondsFrom(row.next_charge_at, new Date(Date.now() + 86_400_000))).toBeLessThan(60);

    // Top up; the daily retry bills the same period and reactivates.
    await seedUser(PAYER_ID, 50);
    const retry = await sweepCreditSubscriptions(env, { now: new Date(Date.now() + 86_400_000 + 60_000) });
    expect(retry.charged).toBe(1);
    row = (await subscriptionRow('record_storage'))!;
    expect(row.status).toBe('active');
    expect(await getCreditBalance(env, PAYER_ID)).toBe(0);
  });

  it('settles and cancels a subscription whose usage dropped to zero', async () => {
    await seedUser(PAYER_ID, 100);
    await reportUsage('record_storage', 100);
    await sweepCreditSubscriptions(env); // first month billed (50)

    await reportUsage('record_storage', 0);
    const boundary = new Date(addMonthsUTC(new Date(), 1).getTime() + 60_000);
    const sweep = await sweepCreditSubscriptions(env, { now: boundary });
    expect(sweep).toMatchObject({ processed: 1, charged: 0, canceled: 1 });

    const row = (await subscriptionRow('record_storage'))!;
    expect(row.status).toBe('canceled');
    expect(await getCreditBalance(env, PAYER_ID)).toBe(50);
  });

  it('reactivates a canceled subscription as a fresh one', async () => {
    await seedUser(PAYER_ID, 100);
    await reportUsage('record_storage', 100);
    await sweepCreditSubscriptions(env);
    await reportUsage('record_storage', 0);
    await sweepCreditSubscriptions(env, { now: new Date(addMonthsUTC(new Date(), 1).getTime() + 60_000) });

    await reportUsage('record_storage', 6000);
    const row = (await subscriptionRow('record_storage'))!;
    expect(row.status).toBe('active');
    expect(row.peak_quantity).toBe(6000);
    expect(row.last_mode).toBeNull();
    expect(secondsFrom(row.next_charge_at, new Date())).toBeLessThan(60);
  });
});

describe('sweepCreditSubscriptions — arrears', () => {
  it('bills the period peak at the boundary, then resets the peak', async () => {
    await seedUser(PAYER_ID, 100);
    await reportUsage('archive_storage', 1500);
    await reportUsage('archive_storage', 400); // peak stays 1500

    expect((await sweepCreditSubscriptions(env)).processed).toBe(0); // nothing due yet

    const boundary = new Date(addMonthsUTC(new Date(), 1).getTime() + 60_000);
    const sweep = await sweepCreditSubscriptions(env, { now: boundary });
    expect(sweep.charged).toBe(1);
    expect(await getCreditBalance(env, PAYER_ID)).toBe(80); // peak 1500 → 2 blocks × 10

    const row = (await subscriptionRow('archive_storage'))!;
    expect(row.peak_quantity).toBe(400);
    expect(row.last_mode).toBe('arrears');
    const rows = await ledgerRows(PAYER_ID);
    expect(rows[0].note).toContain('peak 1500');
  });

  it('charges the final period before canceling on zero usage', async () => {
    await seedUser(PAYER_ID, 100);
    await reportUsage('archive_storage', 900);
    await reportUsage('archive_storage', 0);

    const boundary = new Date(addMonthsUTC(new Date(), 1).getTime() + 60_000);
    const sweep = await sweepCreditSubscriptions(env, { now: boundary });
    expect(sweep).toMatchObject({ charged: 1, canceled: 1 });
    expect(await getCreditBalance(env, PAYER_ID)).toBe(90); // peak 900 → 1 block × 10
    expect((await subscriptionRow('archive_storage'))!.status).toBe('canceled');
  });
});

describe('sweepCreditSubscriptions — mode switches and lifecycle', () => {
  it('skips the pre-paid period when switching advance → arrears', async () => {
    await seedUser(PAYER_ID, 100);
    await reportUsage('archive_storage', 1500);
    // Pretend the last charge was made under advance billing.
    await env.DB.prepare(
      "UPDATE credit_subscriptions SET last_mode = 'advance', next_charge_at = ? WHERE credit_key = 'archive_storage'",
    ).bind(sqliteDate(new Date())).run();

    const sweep = await sweepCreditSubscriptions(env);
    expect(sweep).toMatchObject({ processed: 1, charged: 0 });
    expect(await getCreditBalance(env, PAYER_ID)).toBe(100);

    const row = (await subscriptionRow('archive_storage'))!;
    expect(row.last_mode).toBe('arrears');
    expect(secondsFrom(row.next_charge_at, addMonthsUTC(new Date(), 1))).toBeLessThan(120);
  });

  it('bills elapsed arrears plus the coming month when switching arrears → advance', async () => {
    await seedUser(PAYER_ID, 500);
    await reportUsage('record_storage', 7342); // advance cost, 2 blocks × 50
    await env.DB.prepare(
      "UPDATE credit_subscriptions SET last_mode = 'arrears', peak_quantity = 12081 WHERE credit_key = 'record_storage'",
    ).run();

    const sweep = await sweepCreditSubscriptions(env);
    expect(sweep.charged).toBe(1);
    // One combined spend: arrears peak 12081 → 3 blocks (150) + advance 7342 → 2 blocks (100).
    expect(await getCreditBalance(env, PAYER_ID)).toBe(250);
    const rows = await ledgerRows(PAYER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(-250);
    expect(rows[0].note).toContain('billing switch');
  });

  it('defers when the plugin is unreachable and cancels when the cost is gone', async () => {
    await seedUser(PAYER_ID, 100);
    await reportUsage('record_storage', 100);

    // Unreachable plugin → defer an hour, status untouched.
    await env.DB.prepare('UPDATE plugins SET enabled = 0').run();
    clearManifestCache();
    let sweep = await sweepCreditSubscriptions(env);
    expect(sweep).toMatchObject({ processed: 1, deferred: 1, charged: 0 });
    let row = (await subscriptionRow('record_storage'))!;
    expect(row.status).toBe('active');
    expect(secondsFrom(row.next_charge_at, new Date(Date.now() + 3_600_000))).toBeLessThan(60);

    // Manifest no longer declares the cost → canceled.
    await env.DB.prepare('UPDATE plugins SET enabled = 1').run();
    clearManifestCache();
    __injectPluginFetcher(pluginUrl, manifestFetcher({ ...MANIFEST, credits: [] } as unknown as PluginManifest));
    sweep = await sweepCreditSubscriptions(env, { now: new Date(Date.now() + 3_700_000) });
    expect(sweep).toMatchObject({ processed: 1, canceled: 1 });
    expect((await subscriptionRow('record_storage'))!.status).toBe('canceled');
  });

  it('falls back to the shared pool like any other spend', async () => {
    await env.DB.prepare(
      `INSERT INTO shared_credits (currency, balance) VALUES ('credit', 80)
       ON CONFLICT(currency) DO UPDATE SET balance = excluded.balance`,
    ).run();
    await reportUsage('record_storage', 100); // 1 block = 50, user balance 0

    const sweep = await sweepCreditSubscriptions(env);
    expect(sweep.charged).toBe(1);
    expect(await getCreditBalance(env, PAYER_ID)).toBe(0);
    const shared = await env.DB.prepare("SELECT balance FROM shared_credits WHERE currency = 'credit'").first<{ balance: number }>();
    expect(shared!.balance).toBe(30);
  });
});

describe('GET /__cms/credits and /__cms/credits/subscriptions', () => {
  it('exposes per and billing on recurring costs', async () => {
    const res = await cmsApi('GET', '/__cms/credits');
    const body = await res.json() as { credits: Array<{ key: string; per?: number; billing?: string }> };
    expect(body.credits.find((credit) => credit.key === 'record_storage')).toMatchObject({ per: 5000, billing: 'advance' });
    expect(body.credits.find((credit) => credit.key === 'archive_storage')).toMatchObject({ per: 1000, billing: 'arrears' });
    expect(body.credits.find((credit) => credit.key === 'send_edm')!.billing).toBeUndefined();
  });

  it('lists the plugin subscriptions, optionally per user', async () => {
    await seedUser(602, 0);
    await reportUsage('record_storage', 100);
    await reportUsage('record_storage', 200, 602);

    const all = await cmsApi('GET', '/__cms/credits/subscriptions');
    expect(((await all.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(2);

    const one = await cmsApi('GET', '/__cms/credits/subscriptions?user_id=602');
    const body = await one.json() as { subscriptions: Array<{ user_id: number; quantity: number }> };
    expect(body.subscriptions).toEqual([expect.objectContaining({ user_id: 602, quantity: 200 })]);

    expect((await cmsApi('GET', '/__cms/credits/subscriptions?user_id=abc')).status).toBe(400);
  });
});
