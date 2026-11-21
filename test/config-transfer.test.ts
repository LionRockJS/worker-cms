import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { clearManifestCache } from '../src/features/plugins/registry';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { APP_BRANDING_SETTING_KEY, SYSTEM_TIMEZONE_SETTING_KEY } from '../src/core/db/settings';
import { MAX_CHANGES_PER_REQUEST } from '../src/routes/admin/config-transfer';

const TABLES = ['audit_events', 'data_classes', 'plugin_identity_approvals', 'plugins', 'settings', 'sessions', 'user_oauth_identities',
  'users', 'role_permissions', 'roles', 'page_types', 'block_types', 'page_tags', 'tags', 'taxonomies', 'locale_messages'];
let counter = 0;

async function cookieFor(role: string): Promise<string> {
  return `access_token=${await signJWT({ sub: '18000', name: 'Transfer Admin', email: 'transfer@example.invalid', role, type: 'access',
    exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET)}`;
}

async function wipe(): Promise<void> {
  for (const table of TABLES) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM locales WHERE code = 'fr'").run();
  clearConfigCache(); clearManifestCache(); clearRolePermissionsCache();
}

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO taxonomies(slug, name) VALUES ('topic', 'Topics')"),
    env.DB.prepare(`INSERT INTO tags(slug, name, weight, taxonomy_slug, lect)
      VALUES ('news', 'News', 2, 'topic', '{"name":{"en":"News","zh-hant":"新聞"}}')`),
    env.DB.prepare(`INSERT INTO tags(slug, name, weight, taxonomy_slug, parent_tag, lect)
      VALUES ('local-news', 'Local', 4, 'topic', (SELECT id FROM tags WHERE slug = 'news'), '{"name":{"en":"Local"}}')`),
    env.DB.prepare("INSERT INTO block_types(slug, name, blueprint, weight) VALUES ('quote', 'Quote', '[\"text\"]', 3)"),
    env.DB.prepare(`INSERT INTO page_types(slug, name, blueprint, weight, block_lists, taxonomy_lists)
      VALUES ('story', 'Story', '["title","body"]', 7, '["quote"]', '["topic"]')`),
    env.DB.prepare("INSERT INTO roles(name, label, builtin) VALUES ('reviewer', 'Reviewer', 0)"),
    env.DB.prepare("INSERT INTO role_permissions(role, permission) VALUES ('reviewer', 'content:write'), ('reviewer', 'tag:write')"),
    env.DB.prepare(`INSERT INTO locales(code, label, content_enabled, ui_enabled, direction, fallback_code, weight, builtin)
      VALUES ('fr', 'Français', 1, 0, 'ltr', NULL, 40, 0)`),
    env.DB.prepare("INSERT INTO locale_messages(locale_code, message_key, value) VALUES ('fr', 'common.save', 'Enregistrer')"),
    env.DB.prepare('INSERT INTO settings(key, value) VALUES (?, ?), (?, ?)').bind(
      APP_BRANDING_SETTING_KEY, JSON.stringify({ appName: 'Source CMS', appIcon: 'beaker', primaryColor: '#123456', appFont: 'mono' }),
      SYSTEM_TIMEZONE_SETTING_KEY, '+0800'),
    env.DB.prepare(`INSERT INTO plugins(label, url, enabled, config, sort_order, secret)
      VALUES ('Events', 'https://events.example.com', 0, '{"region":"hk","cmsTrustedUi":true}', 4, 'source-secret')`),
  ]);
  clearConfigCache(); clearRolePermissionsCache();
}

async function call(path: string, body: BodyInit, role = 'admin'): Promise<Response> {
  const ctx = createExecutionContext(); counter++;
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`, {
    method: 'POST', body,
    headers: { Cookie: await cookieFor(role), 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `10.97.${Math.floor(counter / 250)}.${counter % 250 + 1}` },
  }), { ...env, REGULATED_MODE: undefined, REGULATED_INVENTORY: undefined }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const ALL = ['plugins', 'taxonomies', 'tags', 'block_types', 'page_types', 'page_type_extensions', 'locales', 'translations', 'roles', 'system_settings'];

async function exportBundle(sections = ALL): Promise<Record<string, any>> {
  const form = new URLSearchParams();
  for (const id of sections) form.append('sections', id);
  const response = await call('/admin/settings/transfer/export', form);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Disposition')).toMatch(/^attachment; filename="cms-settings-\d{4}-\d{2}-\d{2}\.json"$/);
  return response.json();
}

function applyForm(bundle: unknown, sections = ALL): FormData {
  const form = new FormData();
  form.set('bundle_json', JSON.stringify(bundle));
  for (const id of sections) form.append('sections', id);
  return form;
}

async function snapshot() {
  const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;
  return {
    taxonomies: await rows('SELECT slug, name FROM taxonomies ORDER BY slug'),
    tags: (await rows(`SELECT t.slug, t.name, t.weight, t.taxonomy_slug, p.slug AS parent, t.lect
      FROM tags t LEFT JOIN tags p ON p.id = t.parent_tag ORDER BY t.slug`)).map((row) => ({ ...row, lect: JSON.parse(String(row.lect)) })),
    // Imported blueprints are stored pretty-printed; compare their content.
    blocks: (await rows('SELECT slug, name, blueprint, weight FROM block_types ORDER BY slug')).map((row) => ({ ...row, blueprint: JSON.parse(String(row.blueprint)) })),
    pages: await rows('SELECT slug, name, weight, block_lists, taxonomy_lists FROM page_types ORDER BY slug'),
    roles: await rows("SELECT name, label FROM roles WHERE name = 'reviewer'"),
    grants: await rows("SELECT permission FROM role_permissions WHERE role = 'reviewer' ORDER BY permission"),
    locales: await rows("SELECT code, label, content_enabled, ui_enabled, weight FROM locales WHERE code = 'fr'"),
    messages: await rows("SELECT locale_code, message_key, value FROM locale_messages WHERE locale_code = 'fr'"),
    plugins: await rows('SELECT label, url, enabled, sort_order FROM plugins'),
    timezone: await rows(`SELECT value FROM settings WHERE key = '${SYSTEM_TIMEZONE_SETTING_KEY}'`),
  };
}

beforeEach(wipe);
afterEach(wipe);

it('exports settings without plugin secrets or CMS-owned plugin flags, as an export disclosure', async () => {
  await seed();
  // Reads are audited for classified containers only.
  await env.DB.prepare("INSERT INTO data_classes(container_kind, container_key, class) VALUES ('table', 'plugins', 'pii')").run();
  const bundle = await exportBundle();
  expect(bundle).toMatchObject({ format: '0xcms-config', version: 1, source: expect.any(String) });
  expect(bundle.sections.plugins).toEqual([{ url: 'https://events.example.com', label: 'Events', enabled: false, sortOrder: 4, viewSource: 'host', config: { region: 'hk' } }]);
  expect(JSON.stringify(bundle)).not.toContain('source-secret');
  expect(bundle.sections.page_types).toEqual([{ slug: 'story', name: 'Story', blueprint: ['title', 'body'], weight: 7, blockLists: ['quote'], taxonomyLists: ['topic'] }]);
  expect(bundle.sections.tags).toEqual([
    { slug: 'news', name: 'News', weight: 2, taxonomy: 'topic', parent: null, lect: { name: { en: 'News', 'zh-hant': '新聞' } } },
    { slug: 'local-news', name: 'Local', weight: 4, taxonomy: 'topic', parent: 'news', lect: { name: { en: 'Local' } } },
  ]);
  expect(bundle.sections.roles).toContainEqual({ name: 'reviewer', builtin: false, label: 'Reviewer', permissions: ['content:write', 'tag:write'] });
  expect(bundle.sections.roles.some((role: { name: string }) => role.name === 'admin')).toBe(false);
  expect(bundle.sections.translations).toContainEqual({ locale: 'fr', key: 'common.save', value: 'Enregistrer' });
  const exports = (await env.DB.prepare("SELECT target_type, detail FROM audit_events WHERE event_class = 'export'").all<{ target_type: string; detail: string }>()).results;
  expect(exports.map((row) => row.target_type)).toContain('plugins');
  expect(JSON.parse(exports[0].detail)).toMatchObject({ destination: 'download', operation: 'config.export' });
});

it('only exports sections the signed-in user may manage', async () => {
  await seed();
  const form = new URLSearchParams([['sections', 'roles'], ['sections', 'taxonomies']]);
  const response = await call('/admin/settings/transfer/export', form, 'viewer');
  expect(response.status).not.toBe(200);
  expect(response.headers.get('Content-Disposition')).toBeNull();
});

it('recreates exported settings on an empty CMS through the audited save paths, then reports nothing to change', async () => {
  await seed();
  const expected = await snapshot();
  const bundle = await exportBundle();
  await wipe();

  const preview = new FormData();
  preview.set('bundle', new File([JSON.stringify(bundle)], 'cms-settings.json', { type: 'application/json' }));
  const reviewed = await call('/admin/settings/transfer/preview', preview);
  expect(reviewed.status).toBe(200);
  expect(await snapshot()).not.toEqual(expected);

  let applied = 0;
  for (let round = 0; round < 5; round++) {
    const response = await call('/admin/settings/transfer/apply', applyForm(bundle));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('could not be saved');
    applied++;
    if (!html.includes('"remaining":') || html.includes('"remaining":0')) break;
  }
  expect(applied).toBeLessThan(5);
  const restored = await snapshot();
  expect(restored).toEqual(expected);

  const plugin = await env.DB.prepare('SELECT secret, config FROM plugins').first<{ secret: string; config: string }>();
  expect(plugin!.secret).not.toBe('source-secret');
  expect(JSON.parse(plugin!.config)).toEqual({ region: 'hk', cmsTrustedUi: false });
  const actions = (await env.DB.prepare("SELECT action FROM audit_events WHERE event_class = 'admin'").all<{ action: string }>()).results.map((row) => row.action);
  expect(actions).toEqual(expect.arrayContaining(['plugin.create', 'page_type.create', 'block_type.create', 'role.create', 'role.update', 'settings.system.update']));
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'tag.create' AND outcome = 'success'").first<{ n: number }>())!.n).toBe(2);

  const before = (await env.DB.prepare('SELECT COUNT(*) n FROM audit_events WHERE event_class = \'admin\'').first<{ n: number }>())!.n;
  const again = await call('/admin/settings/transfer/apply', applyForm(bundle));
  expect(await again.text()).toContain('"applied":0');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM audit_events WHERE event_class = \'admin\'').first<{ n: number }>())!.n).toBe(before);
});

it('applies at most one batch of changes per request and continues on the next', async () => {
  const taxonomies = Array.from({ length: MAX_CHANGES_PER_REQUEST + 3 }, (_, index) => ({ slug: `t-${index}`, name: `Topic ${index}` }));
  const bundle = { format: '0xcms-config', version: 1, exportedAt: '', source: 'https://source.example.com', sections: { taxonomies } };
  const first = await (await call('/admin/settings/transfer/apply', applyForm(bundle, ['taxonomies']))).text();
  expect(first).toContain(`"applied":${MAX_CHANGES_PER_REQUEST}`);
  expect(first).toContain('"remaining":3');
  const second = await (await call('/admin/settings/transfer/apply', applyForm(bundle, ['taxonomies']))).text();
  expect(second).toContain('"applied":3');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM taxonomies').first<{ n: number }>())!.n).toBe(taxonomies.length);
});

it('imports tags parents first and skips tags whose parent is missing or loops', async () => {
  const bundle = { format: '0xcms-config', version: 1, exportedAt: '', source: '', sections: { tags: [
    { slug: 'child', name: 'Child', weight: 1, taxonomy: null, parent: 'parent', lect: null },
    { slug: 'parent', name: 'Parent', weight: 1, taxonomy: null, parent: null, lect: { name: { 'zh-hant': '父' } } },
    { slug: 'orphan', name: 'Orphan', weight: 1, taxonomy: null, parent: 'nowhere', lect: null },
    { slug: 'loop-a', name: 'A', weight: 1, taxonomy: null, parent: 'loop-b', lect: null },
    { slug: 'loop-b', name: 'B', weight: 1, taxonomy: null, parent: 'loop-a', lect: null },
    { slug: 'Bad Slug', name: 'Bad', weight: 1, taxonomy: null, parent: null, lect: null },
  ] } };
  const html = await (await call('/admin/settings/transfer/apply', applyForm(bundle, ['tags']))).text();
  expect(html).toContain('"applied":2');
  const rows = (await env.DB.prepare(`SELECT t.slug, p.slug AS parent, t.lect FROM tags t LEFT JOIN tags p ON p.id = t.parent_tag ORDER BY t.slug`)
    .all<{ slug: string; parent: string | null; lect: string }>()).results;
  expect(rows.map(({ slug, parent }) => ({ slug, parent }))).toEqual([{ slug: 'child', parent: 'parent' }, { slug: 'parent', parent: null }]);
  expect(JSON.parse(rows[1].lect).name).toEqual({ 'zh-hant': '父' });
  expect((await (await call('/admin/settings/transfer/apply', applyForm(bundle, ['tags']))).text())).toContain('"applied":0');
});

it('skips entries it must not import and leaves this CMS untouched for them', async () => {
  const bundle = { format: '0xcms-config', version: 1, exportedAt: '', source: '', sections: {
    roles: [{ name: 'admin', builtin: true, label: 'Admin', permissions: [] }],
    plugins: [{ url: 'http://10.0.0.5', label: 'Internal', enabled: true, sortOrder: 0, viewSource: 'host', config: {} }],
    system_settings: [{ key: 'plugin.enrollment.events', value: '{}' }, { key: SYSTEM_TIMEZONE_SETTING_KEY, value: 'not-a-zone' }],
    unknown_section: [{}],
  } };
  const response = await call('/admin/settings/transfer/apply', applyForm(bundle, ['roles', 'plugins', 'system_settings']));
  const html = await response.text();
  expect(html).toContain('"applied":0');
  expect(html).toContain('settings.transfer.unavailable.not_installed');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM plugins').first()).toEqual({ n: 0 });
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM settings').first()).toEqual({ n: 0 });
});

it('rejects a file that is not a settings bundle', async () => {
  const form = new FormData();
  form.set('bundle', new File(['{"format":"something-else"}'], 'x.json'));
  expect((await call('/admin/settings/transfer/preview', form)).status).toBe(400);
});
