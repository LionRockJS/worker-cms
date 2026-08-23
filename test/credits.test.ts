import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from '../src/features/plugins/registry';
import { clearConfigCache } from '../src/core/db/content-config';
import { signJWT } from '../src/core/auth/jwt';
import {
  adjustCredits,
  adjustSharedCredits,
  chargeCredits,
  declaredCredits,
  donateSharedCredits,
  getCreditBalance,
  getSharedCreditBalance,
  loadCreditValues,
  saveCreditValues,
  spendCredits,
  transferCredits,
  transferSharedCredits,
} from '../src/features/credits/service';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { JWTPayload } from '../src/types';
import type { PluginManifest } from '../src/features/plugins/types';
import type { CreditContributor } from '../src/features/credits/contracts';

// Credit system: manifest-declared costs, admin-configured prices, charged by
// the host on page creates (both doors) and plugin-reported metered usage,
// with an append-only ledger.

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'events';
const PLUGIN_SECRET = 'test-plugin-secret-value';
const ADMIN_ID = 1;
const PAYER_ID = 501;

const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Events Suite',
  version: '1.0.0',
  contentTypes: {
    blueprint: {
      event: ['name:text/title'],
      guest: ['@email:email', 'name'],
      mail_list: ['*event'],
    },
  },
  credits: [
    { key: 'create_event', label: 'Create an event', charge: 'page_create', page_type: 'event', default: 100 },
    { key: 'create_guest_list', label: 'Create a guest list', charge: 'page_create', page_type: 'mail_list', default: 25 },
    // No default → free until an admin sets a price.
    { key: 'import_guest', label: 'Import a guest', charge: 'page_create', page_type: 'guest' },
    { key: 'send_edm', label: 'Send EDM email', charge: 'metered', unit: 'recipient', default: 2 },
    // Not an owned/approved type → dropped, or any plugin could tax another
    // plugin's content.
    { key: 'sabotage', label: 'Sabotage', charge: 'page_create', page_type: 'contact', default: 999 },
  ],
  limits: [
    { key: 'max_events', label: 'Maximum events', page_type: 'event', scope: 'total', default: 50 },
    { key: 'edm_rate', label: 'EDM send rate', scope: 'per_second', default: 5 },
  ],
} as unknown as PluginManifest;

let ipCounter = 0;
let pluginUrl = '';

async function registerPlugin(): Promise<string> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Events', url, PLUGIN_SECRET).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(href).pathname;
      if (path === '/__plugin/manifest') return Response.json(MANIFEST);
      if (path.startsWith('/__plugin/hooks/')) return new Response('ok');
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
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

/** Same call with the acting-user attribution header plugins echo back. */
function cmsApiAs(userId: number, method: string, path: string, body?: unknown): Promise<Response> {
  return cmsApi(method, path, body, { 'x-acting-user-id': String(userId) });
}

async function authCookie(role = 'admin'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: String(ADMIN_ID),
    email: 'admin@example.com',
    name: 'Admin User',
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', await authCookie());
  headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers }));
}

async function seedUser(id: number, credits: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, oauth_id, email, name, role)
       VALUES (?, ?, ?, 'Test User', 'admin')
       ON CONFLICT(id) DO UPDATE SET role = excluded.role`,
    ).bind(id, `test:${id}`, `user${id}@example.com`),
    env.DB.prepare(
      `INSERT INTO credit_wallets (user_id, currency, balance) VALUES (?, 'credit', ?)
       ON CONFLICT(user_id, currency) DO UPDATE SET balance = excluded.balance`,
    ).bind(id, credits),
  ]);
}

async function seedNonAdmin(id: number, credits: number, email: string, role = 'editor'): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, oauth_id, email, name, role)
       VALUES (?, ?, ?, 'Recipient', ?)
       ON CONFLICT(id) DO UPDATE SET role = excluded.role, email = excluded.email`,
    ).bind(id, `test:${id}`, email, role),
    env.DB.prepare(
      `INSERT INTO credit_wallets (user_id, currency, balance) VALUES (?, 'credit', ?)
       ON CONFLICT(user_id, currency) DO UPDATE SET balance = excluded.balance`,
    ).bind(id, credits),
  ]);
}

async function balance(id: number): Promise<number | null> {
  return getCreditBalance(env, id);
}

async function ledgerRows(id: number): Promise<Array<{ delta: number; balance_after: number; action: string }>> {
  const rows = await env.DB.prepare(
    'SELECT delta, balance_after, action FROM credit_ledger WHERE user_id = ? ORDER BY id ASC',
  ).bind(id).all<{ delta: number; balance_after: number; action: string }>();
  return rows.results;
}

async function seedSharedPool(amount: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO shared_credits (currency, balance) VALUES ('credit', ?)
     ON CONFLICT(currency) DO UPDATE SET balance = excluded.balance`,
  ).bind(amount).run();
}

async function sharedLedgerRows(): Promise<Array<{ delta: number; balance_after: number; action: string; user_id: number | null }>> {
  const rows = await env.DB.prepare(
    'SELECT delta, balance_after, action, user_id FROM shared_credit_ledger ORDER BY id ASC',
  ).all<{ delta: number; balance_after: number; action: string; user_id: number | null }>();
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
  await seedSharedPool(0);
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.credits.%' OR key LIKE 'plugin.limits.%'").run();
  await env.DB.prepare("DELETE FROM pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  await env.DB.prepare("DELETE FROM trash_pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  pluginUrl = await registerPlugin();
  await seedUser(ADMIN_ID, 0);
  await seedUser(PAYER_ID, 0);
});

describe('declaredCredits validation', () => {
  const allowed = new Set(['event', 'guest', 'mail_list']);
  /** The manifest as the plugin platform contributes it to the credits engine. */
  const contributor = (manifest: PluginManifest = MANIFEST): CreditContributor => ({
    id: PLUGIN_ID,
    name: 'Events Suite',
    credits: manifest.credits ?? [],
    pricablePageTypes: allowed,
  });

  it('keeps valid costs and drops ones on non-owned page types', () => {
    const defs = declaredCredits(contributor());
    expect(defs.map((def) => def.key)).toEqual(['create_event', 'create_guest_list', 'import_guest', 'send_edm']);
  });

  it('normalizes charge kind, unit, and defaults', () => {
    const defs = declaredCredits(contributor());
    expect(defs.find((def) => def.key === 'create_event')).toMatchObject({ charge: 'page_create', pageType: 'event', defaultValue: 100 });
    expect(defs.find((def) => def.key === 'import_guest')!.defaultValue).toBe(0);
    expect(defs.find((def) => def.key === 'send_edm')).toMatchObject({ charge: 'metered', pageType: null, unit: 'recipient', defaultValue: 2 });
  });

  it('drops malformed entries', () => {
    const manifest = {
      ...MANIFEST,
      credits: [
        { key: 'a', charge: 'weird', page_type: 'event' },
        { key: 'b', charge: 'page_create' },                    // missing page_type
        { key: 'c', charge: 'metered', default: -5 },           // negative default → 0
        { key: 'c', charge: 'metered', default: 9 },            // duplicate
        { key: 'BAD KEY', charge: 'metered' },
      ],
    } as unknown as PluginManifest;
    const defs = declaredCredits(contributor(manifest));
    expect(defs.map((def) => def.key)).toEqual(['c']);
    expect(defs[0].defaultValue).toBe(0);
  });
});

describe('chargeCredits / adjustCredits', () => {
  it('deducts atomically and writes a matching ledger row', async () => {
    await seedUser(PAYER_ID, 100);
    const result = await chargeCredits(env, {
      userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test',
    });
    expect(result).toMatchObject({ ok: true, balanceAfter: 70 });
    expect(await balance(PAYER_ID)).toBe(70);
    expect(await ledgerRows(PAYER_ID)).toEqual([{ delta: -30, balance_after: 70, action: 'test:spend' }]);
  });

  it('fails closed on insufficient balance, touching nothing', async () => {
    await seedUser(PAYER_ID, 10);
    const result = await chargeCredits(env, {
      userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test',
    });
    expect(result).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 10, required: 30 });
    expect(await balance(PAYER_ID)).toBe(10);
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
  });

  it('reports an unknown user', async () => {
    const result = await chargeCredits(env, { userId: 999999, amount: 5, action: 'test:spend', createdBy: 'test' });
    expect(result).toMatchObject({ ok: false, error: 'unknown_user' });
  });

  it('grants unconditionally but never deducts below zero', async () => {
    await seedUser(PAYER_ID, 5);
    const grant = await adjustCredits(env, { userId: PAYER_ID, delta: 50, action: 'admin:adjust', createdBy: '1' });
    expect(grant).toMatchObject({ ok: true, balanceAfter: 55 });

    const overdraw = await adjustCredits(env, { userId: PAYER_ID, delta: -100, action: 'admin:adjust', createdBy: '1' });
    expect(overdraw).toMatchObject({ ok: false, error: 'insufficient_credits' });
    expect(await balance(PAYER_ID)).toBe(55);
  });

  // Regression: the users_updated_at AFTER UPDATE trigger fires when the row's
  // updated_at is in the past, and D1's meta.changes counts the trigger's write
  // too — so a one-row credit UPDATE reports changes: 2 on production. The old
  // `meta.changes === 1` guard then wrongly reported unknown_user even though
  // the write succeeded. Detection now uses RETURNING, which is trigger-immune.
  it('succeeds when the updated_at trigger fires (production changes > 1)', async () => {
    await seedUser(PAYER_ID, 100);
    await env.DB.prepare("UPDATE users SET updated_at = '2000-01-01 00:00:00' WHERE id = ?")
      .bind(PAYER_ID).run();

    const grant = await adjustCredits(env, { userId: PAYER_ID, delta: 50, action: 'admin:adjust', createdBy: '1' });
    expect(grant).toMatchObject({ ok: true, balanceAfter: 150 });

    await env.DB.prepare("UPDATE users SET updated_at = '2000-01-01 00:00:00' WHERE id = ?")
      .bind(PAYER_ID).run();
    const spend = await chargeCredits(env, { userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test' });
    expect(spend).toMatchObject({ ok: true, balanceAfter: 120 });
    expect(await balance(PAYER_ID)).toBe(120);
  });
});

describe('/__cms page-create charging', () => {
  it('charges the acting user with the declaring plugin key as the action', async () => {
    await seedUser(PAYER_ID, 150);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'E1' });
    expect(res.status).toBe(201);
    expect(await balance(PAYER_ID)).toBe(50);
    expect(await ledgerRows(PAYER_ID)).toEqual([
      { delta: -100, balance_after: 50, action: 'events:create_event' },
    ]);
  });

  it('rejects with 402 and creates nothing when the balance is short', async () => {
    await seedUser(PAYER_ID, 99);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'E1' });
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string; credit: { required: number; balance: number } };
    expect(body.error).toBe('insufficient_credits');
    expect(body.credit).toEqual({ currency: 'credit', required: 100, balance: 99, shared_balance: 0 });

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'event'")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await balance(PAYER_ID)).toBe(99);
  });

  it('does not charge server-to-server creates with no acting user', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'Public flow' });
    expect(res.status).toBe(201);
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
  });

  it('honors an admin-configured price over the manifest default', async () => {
    await saveCreditValues(env, PLUGIN_ID, { create_event: 10 });
    await seedUser(PAYER_ID, 15);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'Cheap' });
    expect(res.status).toBe(201);
    expect(await balance(PAYER_ID)).toBe(5);
  });

  it('charges a batch once, all-or-nothing', async () => {
    await seedUser(PAYER_ID, 60);
    const ok = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages/batch', {
      pages: [{ page_type: 'mail_list', name: 'L1' }, { page_type: 'mail_list', name: 'L2' }],
    });
    expect(ok.status).toBe(200);
    expect(await balance(PAYER_ID)).toBe(10);
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ delta: -50, action: 'page_create:batch' });

    // Third + fourth list cost 50 but only 10 remains → whole batch rejected.
    const blocked = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages/batch', {
      pages: [{ page_type: 'mail_list', name: 'L3' }, { page_type: 'mail_list', name: 'L4' }],
    });
    expect(blocked.status).toBe(402);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'mail_list'")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('creates free page types without touching the ledger', async () => {
    await seedUser(PAYER_ID, 10);
    // import_guest declares no default → guests are free until priced.
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'guest', name: 'G1' });
    expect(res.status).toBe(201);
    expect(await balance(PAYER_ID)).toBe(10);
  });
});

describe('/__cms credits endpoints', () => {
  it('GET /credits reports prices and the acting user balance', async () => {
    await seedUser(PAYER_ID, 320);
    const res = await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits');
    expect(res.status).toBe(200);
    const body = await res.json() as { balance: number; credits: Array<Record<string, unknown>> };
    expect(body.balance).toBe(320);
    expect(body.credits.map((credit) => credit.key)).toEqual(['create_event', 'create_guest_list', 'import_guest', 'send_edm']);
    expect(body.credits.find((credit) => credit.key === 'send_edm')).toMatchObject({ charge: 'metered', unit: 'recipient', value: 2 });
  });

  it('GET /credits/quote prices a quantity without deducting', async () => {
    await seedUser(PAYER_ID, 100);
    const res = await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits/quote?key=send_edm&quantity=60');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ unit_cost: 2, quantity: 60, total: 120, balance: 100, affordable: false });
    expect(await balance(PAYER_ID)).toBe(100);
  });

  it('POST /credits/charge deducts metered usage', async () => {
    await seedUser(PAYER_ID, 100);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', {
      key: 'send_edm', quantity: 30, entity_type: 'edm', entity_id: 42, note: 'Launch blast',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, charged: 60, balance: 40 });
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ delta: -60, action: 'events:send_edm' });
  });

  it('rejects charges for undeclared keys, non-metered keys, and missing acting user', async () => {
    await seedUser(PAYER_ID, 100);
    expect((await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'made_up' })).status).toBe(400);
    expect((await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'create_event' })).status).toBe(400);
    expect((await cmsApi('POST', '/__cms/credits/charge', { key: 'send_edm', quantity: 1 })).status).toBe(400);
    expect(await balance(PAYER_ID)).toBe(100);
  });

  it('returns 402 with the shortfall on insufficient balance', async () => {
    await seedUser(PAYER_ID, 5);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'send_edm', quantity: 10 });
    expect(res.status).toBe(402);
    expect((await res.json() as { credit: unknown }).credit)
      .toEqual({ currency: 'credit', required: 20, balance: 5, shared_balance: 0 });
  });
});

describe('admin editor charging', () => {
  it('charges the signed-in editor on POST /admin/pages', async () => {
    await seedUser(ADMIN_ID, 250);
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Editor Event', slug: 'editor-event-credit', page_type: 'event' }),
    });
    expect(res.status).toBe(302);
    expect(await balance(ADMIN_ID)).toBe(150);
    expect((await ledgerRows(ADMIN_ID))[0]).toMatchObject({ delta: -100, action: 'events:create_event' });
  });

  it('re-renders with an error and charges nothing when the balance is short', async () => {
    await seedUser(ADMIN_ID, 40);
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Editor Event', slug: 'editor-event-poor', page_type: 'event' }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Not enough credits');
    expect(await balance(ADMIN_ID)).toBe(40);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'event'")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('never charges for a request that fails validation', async () => {
    await seedUser(ADMIN_ID, 250);
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: '', slug: '', page_type: 'event' }),
    });
    expect(res.status).toBe(422);
    expect(await balance(ADMIN_ID)).toBe(250);
  });
});

describe('admin credit management', () => {
  it('grants credits with a note and logs the adjustment', async () => {
    const res = await adminFetch(`/admin/users/${PAYER_ID}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '500', note: 'Starter balance' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('flash=');
    expect(await balance(PAYER_ID)).toBe(500);
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ delta: 500, action: 'admin:adjust' });
  });

  it('requires a note and refuses deductions below zero', async () => {
    await seedUser(PAYER_ID, 100);
    const noNote = await adminFetch(`/admin/users/${PAYER_ID}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '50', note: '' }),
    });
    expect(noNote.headers.get('location')).toContain('error=');

    const overdraw = await adminFetch(`/admin/users/${PAYER_ID}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '-500', note: 'Clawback' }),
    });
    expect(overdraw.headers.get('location')).toContain('error=');
    expect(await balance(PAYER_ID)).toBe(100);
  });

  it('shows the balance and ledger on the user edit page', async () => {
    await seedUser(PAYER_ID, 75);
    await chargeCredits(env, { userId: PAYER_ID, amount: 25, action: 'events:create_guest_list', createdBy: 'test' });
    const res = await adminFetch(`/admin/users/${PAYER_ID}/edit`);
    expect(res.status).toBe(200);
    // The admin shell renders liquid client-side; assert on the embedded
    // view data rather than the final markup.
    const html = await res.text();
    expect(html).toContain('creditWallets');
    expect(html).toContain('events:create_guest_list');
  });
});

describe('credit transfers', () => {
  const RECIPIENT_ID = 700;
  const RECIPIENT_EMAIL = 'recipient@example.com';

  it('moves credits and writes a paired ledger row on each side', async () => {
    await seedUser(ADMIN_ID, 100);
    const result = await transferCredits(env, {
      fromUserId: ADMIN_ID, toUserId: PAYER_ID, amount: 30, note: 'thanks', createdBy: String(ADMIN_ID),
    });
    expect(result).toMatchObject({ ok: true, senderBalance: 70, recipientBalance: 30 });
    expect(await balance(ADMIN_ID)).toBe(70);
    expect(await balance(PAYER_ID)).toBe(30);
    expect(await ledgerRows(ADMIN_ID)).toEqual([{ delta: -30, balance_after: 70, action: 'transfer:send' }]);
    expect(await ledgerRows(PAYER_ID)).toEqual([{ delta: 30, balance_after: 30, action: 'transfer:receive' }]);
  });

  it('fails closed on insufficient balance, touching neither user', async () => {
    await seedUser(ADMIN_ID, 10);
    const result = await transferCredits(env, {
      fromUserId: ADMIN_ID, toUserId: PAYER_ID, amount: 30, createdBy: String(ADMIN_ID),
    });
    expect(result).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 10, required: 30 });
    expect(await balance(ADMIN_ID)).toBe(10);
    expect(await balance(PAYER_ID)).toBe(0);
    expect(await ledgerRows(ADMIN_ID)).toEqual([]);
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
  });

  it('sends credits to another user from the profile page', async () => {
    await seedUser(ADMIN_ID, 250);
    await seedNonAdmin(RECIPIENT_ID, 0, RECIPIENT_EMAIL);
    const res = await adminFetch('/admin/profile/credits/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: RECIPIENT_EMAIL, amount: '40', note: 'lunch' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('flash=');
    expect(await balance(ADMIN_ID)).toBe(210);
    expect(await balance(RECIPIENT_ID)).toBe(40);
    expect((await ledgerRows(RECIPIENT_ID))[0]).toMatchObject({ delta: 40, action: 'transfer:receive' });
  });

  it('matches the recipient email case-insensitively', async () => {
    await seedUser(ADMIN_ID, 100);
    await seedNonAdmin(RECIPIENT_ID, 0, RECIPIENT_EMAIL);
    const res = await adminFetch('/admin/profile/credits/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: 'Recipient@Example.com', amount: '5' }),
    });
    expect(res.headers.get('location')).toContain('flash=');
    expect(await balance(RECIPIENT_ID)).toBe(5);
  });

  it('refuses sending to yourself, to an admin, or to an unknown email', async () => {
    await seedUser(ADMIN_ID, 100);
    // seedUser stores ADMIN_ID's email as user1@example.com.
    const toSelf = await adminFetch('/admin/profile/credits/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: `user${ADMIN_ID}@example.com`, amount: '10' }),
    });
    expect(toSelf.headers.get('location')).toContain('yourself');

    const toAdmin = await adminFetch('/admin/profile/credits/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: `user${PAYER_ID}@example.com`, amount: '10' }),
    });
    expect(toAdmin.headers.get('location')).toContain('administrator');

    const toNobody = await adminFetch('/admin/profile/credits/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: 'ghost@example.com', amount: '10' }),
    });
    expect(toNobody.headers.get('location')).toContain('error=');

    expect(await balance(ADMIN_ID)).toBe(100);
  });

  it('rejects a transfer that would overdraw the sender', async () => {
    await seedUser(ADMIN_ID, 5);
    await seedNonAdmin(RECIPIENT_ID, 0, RECIPIENT_EMAIL);
    const res = await adminFetch('/admin/profile/credits/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: RECIPIENT_EMAIL, amount: '50' }),
    });
    expect(res.headers.get('location')).toContain('error=Not%20enough%20credits');
    expect(await balance(ADMIN_ID)).toBe(5);
    expect(await balance(RECIPIENT_ID)).toBe(0);
  });

  it('renders the send-credits form on the profile page', async () => {
    await seedUser(ADMIN_ID, 100);
    const res = await adminFetch('/admin/profile');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/admin/profile/credits/transfer');
  });

  it('hides profile transfer and donation forms when the wallet is empty', async () => {
    const profileView = await (await env.VIEWS.fetch('https://views.local/sections/profile.liquid')).text();
    expect(profileView).toMatch(
      /\{% if wallet\.balance > 0 %\}\s*<form method="POST" action="\{\{ wallet\.transferAction \}\}"[\s\S]*<form method="POST" action="\{\{ wallet\.donateAction \}\}"[\s\S]*<\/form>\s*\{% endif %\}/,
    );
  });
});

describe('profile and plugins-manage pages', () => {
  it('shows the balance and recent activity on the profile', async () => {
    await seedUser(ADMIN_ID, 180);
    await chargeCredits(env, { userId: ADMIN_ID, amount: 100, action: 'events:create_event', createdBy: '1' });
    const res = await adminFetch('/admin/profile');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('creditWallets');
    expect(html).toContain('events:create_event');
  });

  it('paginates credit history on the profile', async () => {
    await seedUser(ADMIN_ID, 0);
    for (let i = 1; i <= 25; i += 1) {
      await adjustCredits(env, { userId: ADMIN_ID, delta: 1, action: `profile:entry-${i}`, createdBy: '1' });
    }

    const firstPage = await adminFetch('/admin/profile');
    expect(firstPage.status).toBe(200);
    const firstHtml = await firstPage.text();
    expect(firstHtml).toContain('profile:entry-25');
    expect(firstHtml).toContain('profile:entry-6');
    expect(firstHtml).not.toContain('profile:entry-5');
    expect(firstHtml).toContain('"showPagination":true');
    expect(firstHtml).toContain('"nextHref":"/admin/profile?credit_page=2"');
    expect(firstHtml).toContain('"from":1');
    expect(firstHtml).toContain('"to":20');

    const secondPage = await adminFetch('/admin/profile?credit_page=2');
    expect(secondPage.status).toBe(200);
    const secondHtml = await secondPage.text();
    expect(secondHtml).toContain('profile:entry-5');
    expect(secondHtml).toContain('profile:entry-1');
    expect(secondHtml).not.toContain('profile:entry-6');
    expect(secondHtml).toContain('"previousHref":"/admin/profile"');
    expect(secondHtml).toContain('"from":21');
    expect(secondHtml).toContain('"to":25');
  });

  it('lists and saves declared prices on the plugin credits page', async () => {
    const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(pluginUrl).first<{ id: number }>();
    const page = await adminFetch(`/admin/plugins-manage/${row!.id}/credits`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Create an event');
    expect(html).not.toContain('sabotage');

    const save = await adminFetch(`/admin/plugins-manage/${row!.id}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value_create_event: '10', value_send_edm: '0', value_sabotage: '5', value_bogus: '1' }),
    });
    expect(save.status).toBe(302);
    expect(await loadCreditValues(env, PLUGIN_ID)).toEqual({ create_event: 10, send_edm: 0 });
  });

  it('summarizes chargeable actions across plugins', async () => {
    await saveCreditValues(env, PLUGIN_ID, { create_event: 10 });
    const page = await adminFetch('/admin/settings/credits');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('"pluginLabel":"Events Suite"');
    expect(html).toContain('"chargeCount":4');
    expect(html).toContain('"paidCount":3');
    expect(html).toContain('"effectiveLabel":"10 credits"');
    // Usage limits are summarized alongside credits on the same page.
    expect(html).toContain('"hasLimitRows":true');
    expect(html).toContain('"label":"Maximum events"');
    expect(html).toContain('"scopeLabel":"Total"');
    expect(html).toContain('"scopeLabel":"Per second"');
    // Admins can reach the configure links from the summary.
    expect(html).toContain('"canConfigure":true');
  });

  it('lets a non-manager view the summary but not the configure links or routes', async () => {
    await saveCreditValues(env, PLUGIN_ID, { create_event: 10 });
    const editorCookie = await authCookie('editor');
    const editorFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set('Cookie', editorCookie);
      headers.set('Sec-Fetch-Site', 'same-origin');
      ipCounter += 1;
      headers.set('CF-Connecting-IP', `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
      return worker.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers }));
    };

    // An editor (no plugin:manage) can view the read-only summary…
    const page = await editorFetch('/admin/settings/credits');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('"pluginLabel":"Events Suite"');
    // …but the Configure links are withheld.
    expect(html).toContain('"canConfigure":false');

    // …and the configure route itself stays gated by plugin:manage.
    const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(pluginUrl).first<{ id: number }>();
    const denied = await editorFetch(`/admin/plugins-manage/${row!.id}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value_create_event: '99' }),
    });
    expect(denied.status).toBe(403);
    // The override is unchanged — the editor's POST never took effect.
    expect(await loadCreditValues(env, PLUGIN_ID)).toEqual({ create_event: 10 });
  });
});

describe('shared credit pool', () => {
  it('grants and deducts atomically with a guarded ledger', async () => {
    const grant = await adjustSharedCredits(env, { delta: 500, action: 'admin:adjust', createdBy: '1' });
    expect(grant).toMatchObject({ ok: true, balanceAfter: 500 });
    expect(await getSharedCreditBalance(env)).toBe(500);

    const overdraw = await adjustSharedCredits(env, { delta: -600, action: 'admin:adjust', createdBy: '1' });
    expect(overdraw).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 500 });
    expect(await getSharedCreditBalance(env)).toBe(500);
    expect(await sharedLedgerRows()).toEqual([
      { delta: 500, balance_after: 500, action: 'admin:adjust', user_id: null },
    ]);
  });

  it('spendCredits charges the user when their balance covers it', async () => {
    await seedUser(PAYER_ID, 100);
    await seedSharedPool(100);
    const result = await spendCredits(env, { userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test' });
    expect(result).toMatchObject({ ok: true, source: 'user', balanceAfter: 70 });
    expect(await getSharedCreditBalance(env)).toBe(100);
    expect(await sharedLedgerRows()).toEqual([]);
  });

  it('spendCredits falls back to the pool for the full amount when the user is short', async () => {
    await seedUser(PAYER_ID, 10);
    await seedSharedPool(100);
    const result = await spendCredits(env, { userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test' });
    expect(result).toMatchObject({ ok: true, source: 'shared', balanceAfter: 70 });
    // All-or-nothing per pool: the user's own 10 credits are untouched.
    expect(await balance(PAYER_ID)).toBe(10);
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
    expect(await sharedLedgerRows()).toEqual([
      { delta: -30, balance_after: 70, action: 'test:spend', user_id: PAYER_ID },
    ]);
  });

  it('spendCredits fails closed when neither balance covers it', async () => {
    await seedUser(PAYER_ID, 10);
    await seedSharedPool(20);
    const result = await spendCredits(env, { userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test' });
    expect(result).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 10, sharedBalance: 20, required: 30 });
    expect(await balance(PAYER_ID)).toBe(10);
    expect(await getSharedCreditBalance(env)).toBe(20);
  });

  it('spendCredits never lets an unknown user drain the pool', async () => {
    await seedSharedPool(100);
    const result = await spendCredits(env, { userId: 999999, amount: 30, action: 'test:spend', createdBy: 'test' });
    expect(result).toMatchObject({ ok: false, error: 'unknown_user' });
    expect(await getSharedCreditBalance(env)).toBe(100);
  });

  it('donateSharedCredits moves a user\'s own credits into the pool with paired ledger rows', async () => {
    await seedUser(PAYER_ID, 100);
    const result = await donateSharedCredits(env, { fromUserId: PAYER_ID, amount: 40, note: 'chip in', createdBy: String(PAYER_ID) });
    expect(result).toMatchObject({ ok: true, balanceAfter: 60, sharedBalance: 40 });
    expect(await balance(PAYER_ID)).toBe(60);
    expect(await getSharedCreditBalance(env)).toBe(40);
    expect(await ledgerRows(PAYER_ID)).toEqual([{ delta: -40, balance_after: 60, action: 'shared:donate' }]);
    expect(await sharedLedgerRows()).toEqual([
      { delta: 40, balance_after: 40, action: 'shared:donate', user_id: PAYER_ID },
    ]);
  });

  it('donateSharedCredits fails closed when the donor is short', async () => {
    await seedUser(PAYER_ID, 10);
    const result = await donateSharedCredits(env, { fromUserId: PAYER_ID, amount: 40, createdBy: String(PAYER_ID) });
    expect(result).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 10, required: 40 });
    expect(await balance(PAYER_ID)).toBe(10);
    expect(await getSharedCreditBalance(env)).toBe(0);
    expect(await sharedLedgerRows()).toEqual([]);
  });

  it('transferSharedCredits moves pool credits to a user with paired ledger rows', async () => {
    await seedSharedPool(200);
    const result = await transferSharedCredits(env, { toUserId: PAYER_ID, amount: 80, note: 'budget', createdBy: '1' });
    expect(result).toMatchObject({ ok: true, sharedBalance: 120, recipientBalance: 80 });
    expect(await balance(PAYER_ID)).toBe(80);
    expect(await sharedLedgerRows()).toEqual([
      { delta: -80, balance_after: 120, action: 'shared:send', user_id: PAYER_ID },
    ]);
    expect(await ledgerRows(PAYER_ID)).toEqual([
      { delta: 80, balance_after: 80, action: 'shared:receive' },
    ]);
  });

  it('transferSharedCredits fails closed when the pool is short or the user unknown', async () => {
    await seedSharedPool(50);
    const short = await transferSharedCredits(env, { toUserId: PAYER_ID, amount: 80, createdBy: '1' });
    expect(short).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 50, required: 80 });
    expect(await getSharedCreditBalance(env)).toBe(50);
    expect(await balance(PAYER_ID)).toBe(0);

    // Unknown recipient: the pool debit is auto-refunded, never destroyed.
    const ghost = await transferSharedCredits(env, { toUserId: 999999, amount: 30, createdBy: '1' });
    expect(ghost).toMatchObject({ ok: false, error: 'unknown_user' });
    expect(await getSharedCreditBalance(env)).toBe(50);
  });
});

describe('shared pool at charge sites', () => {
  it('covers a /__cms page create the user cannot afford', async () => {
    await seedUser(PAYER_ID, 40);
    await seedSharedPool(150);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'Pooled' });
    expect(res.status).toBe(201);
    expect(await balance(PAYER_ID)).toBe(40);
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
    expect(await sharedLedgerRows()).toEqual([
      { delta: -100, balance_after: 50, action: 'events:create_event', user_id: PAYER_ID },
    ]);
  });

  it('rejects with both balances when neither covers a create', async () => {
    await seedUser(PAYER_ID, 40);
    await seedSharedPool(60);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'Broke' });
    expect(res.status).toBe(402);
    const body = await res.json() as { credit: unknown };
    expect(body.credit).toEqual({ currency: 'credit', required: 100, balance: 40, shared_balance: 60 });
    expect(await getSharedCreditBalance(env)).toBe(60);
  });

  it('covers a metered charge and reports the source', async () => {
    await seedUser(PAYER_ID, 5);
    await seedSharedPool(100);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'send_edm', quantity: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, charged: 60, balance: 5, source: 'shared' });
    expect(await getSharedCreditBalance(env)).toBe(40);
  });

  it('quotes affordability against the pool too', async () => {
    await seedUser(PAYER_ID, 5);
    await seedSharedPool(200);
    const res = await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits/quote?key=send_edm&quantity=60');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ total: 120, balance: 5, shared_balance: 200, affordable: true });
  });

  it('covers an admin editor create when the editor is short', async () => {
    await seedUser(ADMIN_ID, 10);
    await seedSharedPool(300);
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Pooled Event', slug: 'pooled-event', page_type: 'event' }),
    });
    expect(res.status).toBe(302);
    expect(await balance(ADMIN_ID)).toBe(10);
    expect(await getSharedCreditBalance(env)).toBe(200);
    expect((await sharedLedgerRows())[0]).toMatchObject({ delta: -100, action: 'events:create_event', user_id: ADMIN_ID });
  });
});

describe('shared credit administration', () => {
  it('adjusts the pool from the users admin with a mandatory note', async () => {
    const grant = await adminFetch('/admin/users/shared-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '500', note: 'Quarterly budget' }),
    });
    expect(grant.status).toBe(302);
    expect(grant.headers.get('location')).toContain('flash=');
    expect(await getSharedCreditBalance(env)).toBe(500);

    const noNote = await adminFetch('/admin/users/shared-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '50', note: '' }),
    });
    expect(noNote.headers.get('location')).toContain('error=');

    const overdraw = await adminFetch('/admin/users/shared-credits', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '-900', note: 'Clawback' }),
    });
    expect(overdraw.headers.get('location')).toContain('error=');
    expect(await getSharedCreditBalance(env)).toBe(500);
  });

  it('shows the pool balance and ledger on the users admin', async () => {
    await seedSharedPool(0);
    await adjustSharedCredits(env, { delta: 250, action: 'admin:adjust', note: 'seed', createdBy: '1' });
    const res = await adminFetch('/admin/users');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('sharedWallets');
    expect(html).toContain('/admin/users/shared-credits');
    expect(html.indexOf('data-privacy-table')).toBeLessThan(html.indexOf('/admin/users/shared-credits'));
  });

  it('lets a user donate their own credits to the pool from the profile', async () => {
    await seedUser(ADMIN_ID, 100);
    const res = await adminFetch('/admin/profile/credits/shared', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '60', note: 'chip in' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('flash=');
    expect(await balance(ADMIN_ID)).toBe(40);
    expect(await getSharedCreditBalance(env)).toBe(60);
    expect((await ledgerRows(ADMIN_ID))[0]).toMatchObject({ delta: -60, action: 'shared:donate' });
    expect(await sharedLedgerRows()).toEqual([
      { delta: 60, balance_after: 60, action: 'shared:donate', user_id: ADMIN_ID },
    ]);
  });

  it('rejects a donation the donor cannot cover or with a non-positive amount', async () => {
    await seedUser(ADMIN_ID, 10);
    await seedSharedPool(0);
    const short = await adminFetch('/admin/profile/credits/shared', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '60' }),
    });
    expect(short.headers.get('location')).toContain('error=');

    const zero = await adminFetch('/admin/profile/credits/shared', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '0' }),
    });
    expect(zero.headers.get('location')).toContain('error=');
    expect(await balance(ADMIN_ID)).toBe(10);
    expect(await getSharedCreditBalance(env)).toBe(0);

    const page = await adminFetch('/admin/profile');
    expect(await page.text()).toContain('/admin/profile/credits/shared');
  });

  it('grants pool credits to a user from the user edit page', async () => {
    await seedSharedPool(200);
    const res = await adminFetch(`/admin/users/${PAYER_ID}/credits/shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '60', note: 'campaign budget' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('flash=');
    expect(await getSharedCreditBalance(env)).toBe(140);
    expect(await balance(PAYER_ID)).toBe(60);
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ delta: 60, action: 'shared:receive' });
    expect(await sharedLedgerRows()).toEqual([
      { delta: -60, balance_after: 140, action: 'shared:send', user_id: PAYER_ID },
    ]);

    // The pool cannot be overdrawn by a grant either.
    const short = await adminFetch(`/admin/users/${PAYER_ID}/credits/shared`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '900' }),
    });
    expect(short.headers.get('location')).toContain('error=');
    expect(await getSharedCreditBalance(env)).toBe(140);

    const editPage = await adminFetch(`/admin/users/${PAYER_ID}/edit`);
    const html = await editPage.text();
    expect(html).toContain('"canShareCredits":true');
    expect(html).toContain(`/admin/users/${PAYER_ID}/credits/shared`);
  });

  it('grants the shared grant to a custom role holding only credits:share, and 403s without it', async () => {
    await seedSharedPool(200);
    await seedNonAdmin(ADMIN_ID, 0, `user${ADMIN_ID}@example.com`, 'supporter');
    await env.DB.prepare("INSERT OR IGNORE INTO roles (name, label, builtin) VALUES ('supporter', 'Supporter', 0)").run();
    await env.DB.prepare("INSERT OR IGNORE INTO role_permissions (role, permission) VALUES ('supporter', 'credits:share')").run();
    clearRolePermissionsCache();

    try {
      // credits:share alone is enough — no users:manage needed for the grant.
      const allowed = await worker.fetch(new Request(`http://localhost/admin/users/${PAYER_ID}/credits/shared`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: await authCookie('supporter'),
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '10.9.0.1',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ amount: '30' }),
      }));
      expect(allowed.status).toBe(302);
      expect(await balance(PAYER_ID)).toBe(30);
      expect(await getSharedCreditBalance(env)).toBe(170);

      await env.DB.prepare("DELETE FROM role_permissions WHERE role = 'supporter'").run();
      clearRolePermissionsCache();
      const denied = await worker.fetch(new Request(`http://localhost/admin/users/${PAYER_ID}/credits/shared`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: await authCookie('supporter,editor'),
          'Sec-Fetch-Site': 'same-origin',
          'CF-Connecting-IP': '10.9.0.2',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ amount: '30' }),
      }));
      expect(denied.status).toBe(403);
      expect(await getSharedCreditBalance(env)).toBe(170);
    } finally {
      await env.DB.prepare("DELETE FROM role_permissions WHERE role = 'supporter'").run();
      await env.DB.prepare("DELETE FROM roles WHERE name = 'supporter'").run();
      await seedNonAdmin(ADMIN_ID, 0, `user${ADMIN_ID}@example.com`, 'admin');
      clearRolePermissionsCache();
    }
  });
});
