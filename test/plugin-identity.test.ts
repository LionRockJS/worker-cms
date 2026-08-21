// Pinned plugin identity and the plugin permission namespace.
//
// `manifest.id` is asserted by the plugin Worker, and every capability the CMS
// grants — asset/page-type/file-prefix approvals, plugin_state, and the admin
// proxy's permission gate — is keyed by it. These tests cover the two halves of
// making that assertion trustworthy: one manifest id belongs to one registry
// row, and a declared permission can only name the declaring plugin.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __clearInjectedFetchers,
  __injectPluginFetcher,
  allPluginPermissions,
  clearManifestCache,
  getPlugins,
} from '../src/features/plugins/registry';
import { approveAsset, listApprovals } from '../src/features/plugins/assets';
import { getIdentityForRow } from '../src/features/plugins/identity';
import { getPluginState, putPluginState } from '../src/features/plugins/state';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { signJWT } from '../src/core/auth/jwt';
import type { Env } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;

const EVENTS_MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '1.0.0',
  nav: [{ label: 'Events', href: 'dashboard' }],
  assets: [{ path: '/assets/js/kiosk.js' }],
  permissions: [{ value: 'events:manage', label: 'Manage events' }],
};

/** Registers a plugin row pointing at an in-process fetcher serving `manifest`. */
async function register(manifest: unknown, options: { sortOrder?: number } = {}): Promise<{ id: number; url: string }> {
  const url = `https://plugin-identity-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, sort_order) VALUES (?, ?, 1, ?)')
    .bind('Test', url, options.sortOrder ?? 0)
    .run();
  const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(url).first<{ id: number }>();
  serve(url, manifest);
  return { id: row!.id, url };
}

/** Points (or re-points) a registered URL at a fetcher serving `manifest`. */
function serve(url: string, manifest: unknown): void {
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(href).pathname;
      if (path === '/__plugin/manifest') {
        return manifest === null ? new Response('nf', { status: 404 }) : Response.json(manifest);
      }
      if (path === '/assets/js/kiosk.js') return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

function bodyData(html: string): Record<string, unknown> {
  const match = html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error('Missing cms-render-payload script');
  return (JSON.parse(match[1]) as { bodyView?: { data?: Record<string, unknown> } }).bodyView?.data ?? {};
}

function pluginEnv(): Env {
  return { DB: env.DB } as unknown as Env;
}

async function cookieFor(role: string, sub = '1'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub, email: `${role}@example.com`, name: 'Tester', role, type: 'access', exp: now + 900, iat: now,
  }, env.JWT_SECRET);
  return `access_token=${token}`;
}

/** Creates a custom role holding exactly `permissions`. */
async function makeRole(name: string, permissions: string[]): Promise<void> {
  await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind(name, name).run();
  for (const permission of permissions) {
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind(name, permission).run();
  }
  clearRolePermissionsCache();
}

beforeEach(async () => {
  clearManifestCache();
  clearRolePermissionsCache();
  __clearInjectedFetchers();
  // plugin_identity_approvals cascades with the row it pins.
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM plugin_asset_approvals').run();
  await env.DB.prepare('DELETE FROM plugin_state').run();
  await env.DB.prepare('DELETE FROM role_permissions').run();
  await env.DB.prepare('DELETE FROM roles').run();
});

describe('pinned plugin identity', () => {
  it('pins the manifest id a plugin first resolves with', async () => {
    const plugin = await register(EVENTS_MANIFEST);

    expect(await getPlugins(pluginEnv())).toHaveLength(1);
    expect((await getIdentityForRow(env.DB, plugin.id))?.manifest_id).toBe('events');
  });

  it('ignores a second plugin claiming an id another row already owns', async () => {
    const owner = await register(EVENTS_MANIFEST);
    expect(await getPlugins(pluginEnv())).toHaveLength(1);

    // The impostor sorts first, which used to decide pluginById() — the pin,
    // not the sort order, now settles who owns the id.
    const impostor = await register({ ...EVENTS_MANIFEST, name: 'Not Events' }, { sortOrder: -1 });
    clearManifestCache();

    const resolved = await getPlugins(pluginEnv());
    expect(resolved).toHaveLength(1);
    expect(resolved[0].binding).toBe(owner.url);
    expect(await getIdentityForRow(env.DB, impostor.id)).toBeNull();
  });

  it('does not let an impostor inherit the approvals granted to the id', async () => {
    await register(EVENTS_MANIFEST);
    await getPlugins(pluginEnv());
    await approveAsset(env.DB, 'events', '/assets/js/kiosk.js', 'sha384-pinned', 'admin@example.com');

    const impostor = await register({ ...EVENTS_MANIFEST, name: 'Not Events' }, { sortOrder: -1 });
    clearManifestCache();

    // The impostor is not resolved at all, so nothing keyed to "events" — the
    // approved asset, its page types, its file prefixes — is reachable through it.
    const resolved = await getPlugins(pluginEnv());
    expect(resolved.map((entry) => entry.binding)).not.toContain(impostor.url);
    expect(await listApprovals(env.DB, 'events')).toHaveLength(1);
  });

  it('stops resolving a plugin whose manifest id changes under it', async () => {
    const plugin = await register(EVENTS_MANIFEST);
    expect(await getPlugins(pluginEnv())).toHaveLength(1);

    serve(plugin.url, { ...EVENTS_MANIFEST, id: 'events-pro' });
    clearManifestCache();

    expect(await getPlugins(pluginEnv())).toEqual([]);
    // The original pin stands until an admin re-approves.
    expect((await getIdentityForRow(env.DB, plugin.id))?.manifest_id).toBe('events');
  });

  it('re-approving a changed identity re-pins it, revokes its approvals and moves its state', async () => {
    const plugin = await register(EVENTS_MANIFEST);
    await getPlugins(pluginEnv());
    await approveAsset(env.DB, 'events', '/assets/js/kiosk.js', 'sha384-pinned', 'admin@example.com');
    await putPluginState(env.DB, 'events', 'cursor', '{"page":2}');

    serve(plugin.url, { ...EVENTS_MANIFEST, id: 'events-pro' });
    clearManifestCache();

    const response = await worker.fetch(new Request(`http://localhost/admin/plugins-manage/${plugin.id}/identity`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: await cookieFor('admin'), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(302);

    expect((await getIdentityForRow(env.DB, plugin.id))?.manifest_id).toBe('events-pro');
    expect(await getPlugins(pluginEnv())).toHaveLength(1);
    // Privileges do not follow a changed identity; the plugin's own data does.
    expect(await listApprovals(env.DB, 'events')).toEqual([]);
    expect(await listApprovals(env.DB, 'events-pro')).toEqual([]);
    expect((await getPluginState(env.DB, 'events-pro', 'cursor'))?.value).toBe('{"page":2}');
  });

  it('offers the admin a re-approval panel, and flags the row in the plugin list', async () => {
    const plugin = await register(EVENTS_MANIFEST);
    await getPlugins(pluginEnv());
    serve(plugin.url, { ...EVENTS_MANIFEST, id: 'events-pro' });
    clearManifestCache();

    const cookie = await cookieFor('admin');
    const edit = await worker.fetch(new Request(`http://localhost/admin/plugins-manage/${plugin.id}/edit`, {
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    }));
    const editData = bodyData(await edit.text());
    expect(editData.showIdentity).toBe(true);
    expect(editData.identityPinnedId).toBe('events');
    expect(editData.identityServedId).toBe('events-pro');

    // A plugin held back over its identity must not read as merely offline.
    const list = await worker.fetch(new Request('http://localhost/admin/plugins-manage', {
      headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' },
    }));
    const rows = bodyData(await list.text()).plugins as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('identity');
  });

  it('purges the approvals of a deleted plugin even when it is offline', async () => {
    const plugin = await register(EVENTS_MANIFEST);
    await getPlugins(pluginEnv());
    await approveAsset(env.DB, 'events', '/assets/js/kiosk.js', 'sha384-pinned', 'admin@example.com');

    // The usual state when an admin removes a plugin: it no longer answers, so
    // the manifest cannot name the id whose approvals must go. The pin can.
    serve(plugin.url, null);
    clearManifestCache();

    const response = await worker.fetch(new Request(`http://localhost/admin/plugins-manage/${plugin.id}/delete`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: await cookieFor('admin'), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(302);
    expect(await listApprovals(env.DB, 'events')).toEqual([]);

    // With the id released, the same plugin can be registered again — and
    // starts with no inherited approvals.
    const replacement = await register(EVENTS_MANIFEST);
    clearManifestCache();
    expect(await getPlugins(pluginEnv())).toHaveLength(1);
    expect((await getIdentityForRow(env.DB, replacement.id))?.manifest_id).toBe('events');
  });
});

describe('plugin permission namespace', () => {
  const GREEDY_MANIFEST = {
    ...EVENTS_MANIFEST,
    permissions: [
      { value: 'content:write', label: 'View the events calendar' },
      { value: 'checkin:manage', label: 'Manage check-in' },
      { value: 'events:manage', label: 'Manage events' },
    ],
  };

  it('contributes only permissions namespaced to the declaring plugin', async () => {
    await register(GREEDY_MANIFEST);

    // A built-in under a friendly label, and another plugin's permission, are
    // both dropped — only the plugin's own namespace survives.
    expect(await allPluginPermissions(pluginEnv())).toEqual([{ value: 'events:manage', label: 'Manage events' }]);
  });

  it('refuses a role holding another plugin\'s permission, and admits its own', async () => {
    await register(GREEDY_MANIFEST);
    await getPlugins(pluginEnv());

    await makeRole('kiosk-staff', ['plugin:access', 'checkin:manage']);
    const refused = await worker.fetch(new Request('http://localhost/admin/plugins/events/assets/js/kiosk.js', {
      headers: { Cookie: await cookieFor('kiosk-staff', '2'), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(refused.status).toBe(403);

    await makeRole('events-staff', ['plugin:access', 'events:manage']);
    const admitted = await worker.fetch(new Request('http://localhost/admin/plugins/events/assets/js/kiosk.js', {
      headers: { Cookie: await cookieFor('events-staff', '3'), 'Sec-Fetch-Site': 'same-origin' },
    }));
    // Past the permission gate: 404 is "asset not approved", not "forbidden".
    expect(admitted.status).toBe(404);
  });

  it('needs the CMS-side plugin:access grant as well as the plugin\'s own permission', async () => {
    await register(GREEDY_MANIFEST);
    await getPlugins(pluginEnv());

    // Holding only what the plugin declares is not enough: a manifest must not
    // be able to decide, by itself, who reaches CMS-origin admin pages.
    await makeRole('events-half', ['events:manage']);
    const half = await worker.fetch(new Request('http://localhost/admin/plugins/events/assets/js/kiosk.js', {
      headers: { Cookie: await cookieFor('events-half', '5'), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(half.status).toBe(403);

    // And plugin:access on its own does not open a plugin the role holds no
    // permission for.
    await makeRole('plugin-tourist', ['plugin:access']);
    const tourist = await worker.fetch(new Request('http://localhost/admin/plugins/events/assets/js/kiosk.js', {
      headers: { Cookie: await cookieFor('plugin-tourist', '6'), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(tourist.status).toBe(403);
  });

  it('back-fills plugin:access for roles that already had plugin admin access', async () => {
    // The upgrade case: a role granted only a plugin's own permission could
    // reach that plugin's admin before the second key existed, and must not
    // lose access on deploy. Runs the shipped migration's own SQL.
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('legacy-door', 'Door').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('legacy-door', 'checkin:door').run();
    // A role with only built-ins must NOT be widened by the back-fill.
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('legacy-writer', 'Writer').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('legacy-writer', 'content:write').run();

    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === '0004_enable_plugins_access.sql');
    expect(migration).toBeDefined();
    for (const query of migration!.queries) await env.DB.prepare(query).run();

    const granted = await env.DB.prepare('SELECT role FROM role_permissions WHERE permission = ? ORDER BY role')
      .bind('plugin:access')
      .all<{ role: string }>();
    expect(granted.results.map((row) => row.role)).toEqual(['legacy-door']);
  });

  it('does not admit an editor through a built-in permission a manifest declares', async () => {
    await register(GREEDY_MANIFEST);
    await getPlugins(pluginEnv());

    // `content:write` is an editor's own permission, and the manifest asks for
    // it by name — which must not be a way into the plugin's admin routes.
    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/assets/js/kiosk.js', {
      headers: { Cookie: await cookieFor('editor', '4'), 'Sec-Fetch-Site': 'same-origin' },
    }));
    expect(response.status).toBe(403);
  });

  it('keeps a plugin-declared permission out of the role editor when it is not declared', async () => {
    await register(EVENTS_MANIFEST);
    await getPlugins(pluginEnv());

    const response = await worker.fetch(new Request('http://localhost/admin/roles/editor', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: await cookieFor('admin'),
        'Sec-Fetch-Site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'permissions=checkin%3Amanage',
    }));
    expect(response.status).toBe(400);
  });
});
