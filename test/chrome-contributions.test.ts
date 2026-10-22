// The seam that keeps optional features out of the admin chrome
// (src/core/feature.ts + src/features/index.ts).
//
// buildBaseProps() no longer knows what credits are: it merges whatever the
// features in src/features/index.ts return. These tests pin the
// resulting behaviour so the merge cannot silently stop happening — a
// regression that would blank the sidebar balances on every admin page
// without failing any other test.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { features } from '../src/features';
import { installedMenuItems, menuItemFeature, SIDEBAR_MENU_ITEMS, SHOW_CREDITS_SETTING_KEY } from '../src/core/db/settings';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;
let ipCounter = 0;

function layoutData(html: string): Record<string, unknown> {
  const match = html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error('Missing cms-render-payload script');
  return (JSON.parse(match[1]) as { layoutData: Record<string, unknown> }).layoutData;
}

async function adminGet(path: string, init: RequestInit = {}): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  ipCounter += 1;
  return worker.fetch(new IncomingRequest(new URL(path, 'http://localhost'), {
    ...init,
    redirect: 'manual',
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`,
      Cookie: `access_token=${token}`,
    },
  }));
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(SHOW_CREDITS_SETTING_KEY).run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare(
    'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin').run();
  await env.DB.prepare(
    "INSERT INTO credit_wallets (user_id, currency, balance) VALUES (?, 'credit', ?)",
  ).bind(1, 42).run();
});

describe('admin chrome feature contributions', () => {
  it('saves credit visibility and restores balances when credits are shown again', async () => {
    const payload = async (path: string) => {
      const response = await adminGet(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      const match = html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s)!;
      return JSON.parse(match[1]) as {
        layoutData: Record<string, unknown>;
        bodyView: { data: Record<string, unknown> };
      };
    };
    expect((await payload('/admin/settings/system')).bodyView.data).toMatchObject({
      hasCreditsFeature: true, showCredits: true,
    });

    const save = (show?: boolean) => adminGet('/admin/settings/system', {
      method: 'POST',
      body: new URLSearchParams([
        ['visible_items', 'users'], ['visible_items', 'credits'],
        ...(show === undefined ? [] : [['show_credits', String(show)]]),
      ]),
    });
    expect((await save(false)).status).toBe(302);
    // Older forms without the new field must preserve the saved preference.
    expect((await save()).status).toBe(302);
    const settings = await payload('/admin/settings/system');
    expect(settings.bodyView.data.showCredits).toBe(false);
    expect(settings.layoutData.sidebarWallets).toEqual([]);
    expect(settings.layoutData.sidebarSettingsNav).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Users', translationKey: 'nav.users_without_credits' }),
    ]));
    expect(settings.layoutData.sidebarSettingsNav).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/admin/settings/credits' }),
    ]));
    for (const path of ['/admin/profile', '/admin/users', '/admin/users/1/edit']) {
      const data = (await payload(path)).bodyView.data;
      expect(data.showCreditsPanel).toBe(false);
      expect(data.creditWallets).toBeUndefined();
      expect(data.sharedWallets).toBeUndefined();
    }

    expect((await save(true)).status).toBe(302);
    const restored = await payload('/admin/settings/system');
    expect(restored.bodyView.data.showCredits).toBe(true);
    expect(restored.layoutData.sidebarWallets).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: 'credit', userBalance: 42 }),
    ]));
    expect(restored.layoutData.sidebarSettingsNav).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Users & Credits' }),
      expect.objectContaining({ href: '/admin/settings/credits' }),
    ]));
    expect((await payload('/admin/profile')).bodyView.data.showCreditsPanel).toBe(true);
  });

  it('merges the credits contributor into every admin render', async () => {
    const response = await adminGet('/admin/trash');
    expect(response.status).toBe(200);

    // Reaches the sidebar through a route that has nothing to do with
    // credits — which is the whole point of the contribution seam.
    const data = layoutData(await response.text());
    expect(data.sidebarWallets).toEqual([
      expect.objectContaining({ currency: 'credit', userBalance: 42, sharedBalance: expect.any(Number) }),
    ]);
  });

  it('defaults sidebar wallets to an empty list when nothing contributes them', async () => {
    const { layout } = await import('../src/core/render/layout');
    const withoutCredits = await layout(env.VIEWS, {
      title: 'x',
      siteTitle: 'x',
      body: '<p></p>',
      admin: true,
      userName: 'Admin User',
      userRole: 'admin',
    });
    expect(layoutData(withoutCredits).sidebarWallets).toEqual([]);
  });

  it('renders sidebar wallets from contributed rows', async () => {
    const view = await (await env.VIEWS.fetch('https://views.local/layout/default.liquid')).text();
    expect(view).toContain('{% for wallet in sidebarWallets %}');
    expect(view).toContain('{{ wallet.userBalance }}');
    expect(view).toContain('{{ wallet.sharedBalance }}');
    expect(view).toContain('{% if wallet.sharedBalance > 0 %}');
    expect(view).toContain('whitespace-nowrap');
  });

  it('registers each contributor under a cms.features.json id', () => {
    const ids = features.map((feature) => feature.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toContain('credits');
  });
});

// Sidebar entries owned by a feature must disappear from every screen that
// lists them when that feature is not installed — not just from the sidebar.
// The System Settings screen listed SIDEBAR_MENU_ITEMS directly, so a build
// with the features stripped still offered visibility and weight controls for
// Plugins, Credits, Trash, Users and the rest.
//
// Tested through the predicate rather than through a request, because in this
// build every feature IS installed: the only way to observe the filtering is
// to ask what a different profile would show.
describe('sidebar menu items by profile', () => {
  it('offers every entry when all features are installed', () => {
    expect(installedMenuItems(() => true).map((item) => item.key))
      .toEqual(SIDEBAR_MENU_ITEMS.map((item) => item.key));
  });

  it('drops feature-owned entries in a core-only profile', () => {
    // Nothing installed: only entries with no `feature` tag survive.
    const keys = installedMenuItems((feature) => feature === undefined).map((item) => item.key);
    expect(keys).toEqual(['pages', 'tags', 'taxonomies', 'system']);
    for (const key of ['plugins', 'credits', 'trash', 'users', 'roles', 'languages', 'content', 'pageTypes', 'blockTypes']) {
      expect(keys).not.toContain(key);
    }
  });

  it('drops only the entries the dropped feature owns', () => {
    const keys = installedMenuItems((feature) => feature !== 'users-roles').map((item) => item.key);
    expect(keys).not.toContain('users');
    expect(keys).not.toContain('roles');
    expect(keys).toContain('plugins');
    expect(keys).toContain('system');
  });

  it('drives both script lists from one source', async () => {
    // The bootstrap shell and layout/default.liquid used to hold two
    // hand-maintained copies of the same paths; they now come from
    // clientAssets, so a feature's script cannot reach one and miss the other.
    const { CORE_CLIENT_ASSETS } = await import('../src/core/render/layout');
    const html = await (await adminGet('/admin/trash')).text();
    const bootstrap = [...html.matchAll(/<script src="([^"?]+)/g)].map((match) => match[1]);
    const expected = [...CORE_CLIENT_ASSETS, ...features.flatMap((feature) => feature.clientAssets ?? [])];

    expect(layoutData(html).clientAssets).toEqual(expected);
    // The engine and the renderer load first and only here: client-render.js
    // replaces the document with what default.liquid renders.
    expect(bootstrap).toEqual(['/assets/liquid.browser.min.js', '/assets/client-render.js', ...expected]);
  });

  it('ships every declared client asset', async () => {
    // A feature declaring a script the assembler does not place would render a
    // <script> tag pointing at a 404 on every admin page.
    for (const asset of features.flatMap((feature) => feature.clientAssets ?? [])) {
      const response = await env.VIEWS.fetch(`https://views.local${asset}`);
      expect(response.status, `${asset} is declared but not assembled`).toBe(200);
    }
  });

  it('tags every feature-owned entry with an id its feature claims', () => {
    // A typo'd `feature` would silently hide the entry in every profile.
    const owned = new Set(features.flatMap((feature) => feature.navKeys ?? []));
    for (const item of SIDEBAR_MENU_ITEMS) {
      if (menuItemFeature(item)) expect(owned).toContain(item.key);
    }
  });
});
