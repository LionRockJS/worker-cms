// Audit events and the audit log reader.
//
// The envelope's whole point is that it can be relied on in an audit, so what
// is covered here is the part that would be embarrassing to get wrong: that
// authentication and refused access actually produce rows, that the screen is
// gated on its own permission and records its own reads, and that no email ever
// reaches the table — an address copied into rows we must retain for years
// cannot be erased on request.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;
let ipCounter = 0;

interface AuditRow {
  action: string;
  outcome: string;
  event_class: string;
  retention_class: string;
  actor_user_id: string | null;
  actor_roles: string | null;
  session_sid: string | null;
  source_ip: string | null;
  user_agent: string | null;
  detail: string | null;
}

/** Leaves `sid` to the fixture, which also stores the revocable session row the
 *  access path validates against — a hand-set sid would have no session. */
async function cookieFor(sub: string, role: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub,
    email: `${role}@example.com`,
    name: `${role} user`,
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}

async function sessionIdFor(userId: number): Promise<string> {
  const row = await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .bind(userId)
    .first<{ id: number }>();
  return String(row?.id ?? '');
}

async function fetchWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.44.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  headers.set('User-Agent', 'audit-test/1.0');
  return worker.fetch(new IncomingRequest(new URL(path, 'http://localhost'), {
    redirect: 'manual',
    ...init,
    headers,
  }));
}

/** The writes land in waitUntil, so every assertion polls rather than racing. */
function latest(action: string) {
  return expect.poll(async () => env.DB.prepare(
    `SELECT action, outcome, event_class, retention_class, actor_user_id, actor_roles,
            session_sid, source_ip, user_agent, detail
       FROM audit_events WHERE action = ? ORDER BY seq DESC LIMIT 1`,
  ).bind(action).first<AuditRow>(), { timeout: 2000 });
}

async function seedEvent(action: string, eventClass: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (event_id, occurred_at, event_class, retention_class, action, outcome)
     VALUES (?, ?, ?, 'none', ?, 'success')`,
  ).bind(crypto.randomUUID(), new Date().toISOString(), eventClass, action).run();
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin'),
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(2, 'eventuai:editor', 'editor@example.com', 'Editor User', '', 'editor'),
  ]);
});

describe('authentication events', () => {
  it('records a refused sign-in with the reason it failed', async () => {
    const response = await fetchWorker('/auth/callback');
    expect(response.headers.get('Location')).toBe('/auth/login?error=missing_params');

    await latest('auth.login').toMatchObject({
      outcome: 'denied',
      event_class: 'auth',
      retention_class: 'auth',
      // Nothing identified an account, so there is no actor — and the attempted
      // address is deliberately not recorded in its place.
      actor_user_id: null,
      detail: JSON.stringify({ reason: 'missing_params' }),
    });
  });

  it('records a sign-out against the session it ended', async () => {
    const cookie = await cookieFor('1', 'admin');
    const sid = await sessionIdFor(1);

    const response = await fetchWorker('/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    expect(response.status).toBe(302);

    await latest('auth.logout').toMatchObject({
      outcome: 'success',
      event_class: 'auth',
      actor_user_id: '1',
      actor_roles: 'admin',
      session_sid: sid,
      user_agent: 'audit-test/1.0',
    });
  });

  it('records a refused capability check with the permission and the path', async () => {
    const response = await fetchWorker('/admin/roles', {
      headers: { Cookie: await cookieFor('2', 'editor') },
    });
    expect(response.status).toBe(403);

    await latest('permission.denied').toMatchObject({
      outcome: 'denied',
      event_class: 'auth',
      actor_user_id: '2',
      actor_roles: 'editor',
      detail: JSON.stringify({ permission: 'roles:manage', path: '/admin/roles' }),
    });
  });
});

describe('the audit log reader', () => {
  it('refuses the screen to a role without audit:read', async () => {
    const response = await fetchWorker('/admin/audit', {
      headers: { Cookie: await cookieFor('2', 'editor') },
    });

    expect(response.status).toBe(403);
    // The refusal is itself an audit event: a denied read of the trail is
    // exactly what a reviewer wants to see.
    await latest('permission.denied').toMatchObject({
      actor_user_id: '2',
      detail: JSON.stringify({ permission: 'audit:read', path: '/admin/audit' }),
    });
  });

  it('serves the screen to an admin and records the read with its filters', async () => {
    const response = await fetchWorker('/admin/audit?class=auth&outcome=denied', {
      headers: { Cookie: await cookieFor('1', 'admin') },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('cms-render-payload');
    await latest('audit.read').toMatchObject({
      // An administrative act, so it keeps the longer retention rather than
      // being swept with ordinary traffic.
      event_class: 'admin',
      retention_class: 'admin_config',
      actor_user_id: '1',
      detail: JSON.stringify({ class: 'auth', outcome: 'denied', results: 0 }),
    });
  });

  it('narrows the list to the chosen event class', async () => {
    await seedEvent('probe.mutation', 'mutation');
    await seedEvent('probe.auth', 'auth');

    const all = await fetchWorker('/admin/audit', { headers: { Cookie: await cookieFor('1', 'admin') } });
    const body = await all.text();
    expect(body).toContain('probe.mutation');
    expect(body).toContain('probe.auth');

    const filtered = await fetchWorker('/admin/audit?class=auth', {
      headers: { Cookie: await cookieFor('1', 'admin') },
    });
    const filteredBody = await filtered.text();
    expect(filteredBody).toContain('probe.auth');
    expect(filteredBody).not.toContain('probe.mutation');
  });

  it('ignores a filter value it does not recognise instead of trusting it', async () => {
    await seedEvent('probe.auth', 'auth');

    // A bad class falls back to "no filter"; a wildcard in the action filter is
    // stripped rather than escaped, so it cannot widen the LIKE.
    const response = await fetchWorker('/admin/audit?class=../../etc&action=%25', {
      headers: { Cookie: await cookieFor('1', 'admin') },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('probe.auth');
  });
});

describe('the audit envelope', () => {
  it('has nowhere to put an email', async () => {
    // The guarantee is structural, not a convention a future call site could
    // forget: there is no column for an address to be written into.
    const columns = await env.DB.prepare('PRAGMA table_info(audit_events)').all<{ name: string }>();
    const names = columns.results.map((column) => column.name);

    expect(names).toContain('actor_user_id');
    expect(names.filter((name) => /mail/i.test(name))).toEqual([]);
  });
});
