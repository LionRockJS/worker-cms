import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';
import { clearConfigCache } from '../src/core/db/content-config';
import { __clearInjectedFetchers, __injectPluginFetcher, clearManifestCache } from '../src/features/plugins/registry';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { APP_BRANDING_SETTING_KEY, SYSTEM_TIMEZONE_SETTING_KEY } from '../src/core/db/settings';
import { MAX_CONFIG_BUNDLE_BYTES } from '../src/core/config-transfer';
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

const eventsUrl = 'https://events.example.com';
function eventsManifest(fields?: unknown) {
  __injectPluginFetcher(eventsUrl, { fetch: async () => Response.json({
    id: 'events', name: 'Events', version: '1', portableConfigFields: fields,
  }) } as Fetcher);
}

beforeEach(async () => {
  await wipe();
  eventsManifest(['region']);
});
afterEach(async () => {
  __clearInjectedFetchers();
  await wipe();
});

it('exports settings without plugin secrets or CMS-owned plugin flags, as an export disclosure', async () => {
  await seed();
  // Reads are audited for classified containers only.
  await env.DB.prepare("INSERT INTO data_classes(container_kind, container_key, class) VALUES ('table', 'plugins', 'pii')").run();
  const bundle = await exportBundle();
  expect(bundle).toMatchObject({ format: '0xcms-config', version: 1, source: expect.any(String) });
  expect(bundle.sections.plugins).toEqual([{ url: 'https://events.example.com', label: 'Events', enabled: false, sortOrder: 4, config: { region: 'hk' } }]);
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

it('exports declared keys only and preserves destination config when importing a legacy or edited bundle', async () => {
  await seed();
  const config = { region: 'hk', currency: 'HKD', apiToken: 'source-private', cmsTrustedUi: true, cmsViewSource: 'bucket' };
  await env.DB.prepare('UPDATE plugins SET config=?').bind(JSON.stringify(config)).run();
  eventsManifest(['region', 'currency', 'cmsTrustedUi', 'cmsViewSource', '__proto__', '*']);
  const bundle = await exportBundle(['plugins']);
  const entry = bundle.sections.plugins[0];
  expect(entry.config).toEqual({ region: 'hk', currency: 'HKD' });
  expect(entry).not.toHaveProperty('viewSource');
  expect(JSON.stringify(bundle)).not.toContain('source-private');

  const local = { region: 'uk', timezone: 'Europe/London', currency: 'GBP', apiToken: 'destination-private', branding: { size: 3 },
    cmsTrustedUi: true, cmsViewSource: 'local' };
  await env.DB.prepare('UPDATE plugins SET config=?, secret=?').bind(JSON.stringify(local), 'destination-secret').run();
  eventsManifest(['region', 'timezone']);
  Object.assign(entry, { viewSource: 'host', portableConfigFields: ['apiToken'] });
  Object.assign(entry.config, { apiToken: 'injected', cmsTrustedUi: false, cmsViewSource: 'host' });
  const apply = () => call('/admin/settings/transfer/apply', applyForm(bundle, ['plugins']));
  expect(await (await apply()).text()).toContain('"applied":1');
  const saved = await env.DB.prepare('SELECT config, secret FROM plugins').first<{ config: string; secret: string }>();
  expect(JSON.parse(saved!.config)).toEqual({ ...local, region: 'hk' });
  expect(saved!.secret).toBe('destination-secret');
  expect(await (await apply()).text()).toContain('"applied":0');
});

it.each([undefined, 'region', ['region', 3]])('defaults to empty portable config for declaration %j', async fields => {
  await seed();
  eventsManifest(fields);
  expect((await exportBundle(['plugins'])).sections.plugins[0].config).toEqual({});
});

it('uses the exact UTF-8 file limit and resumes across and within sections', async () => {
  const download = (...ids: string[]) => call('/admin/settings/transfer/export',
    new URLSearchParams(ids.map(id => ['sections', id])));
  const size = (text: string) => new TextEncoder().encode(text).byteLength;
  // Spread the payload over rows so each is comfortably below D1's row limit.
  for (const slug of ['one', 'two', 'three', 'four']) {
    await env.DB.prepare('INSERT INTO taxonomies(slug, name) VALUES (?, ?)').bind(slug, slug + '新'.repeat(150_000)).run();
  }
  const initial = await download('taxonomies');
  expect(initial.status).toBe(200);
  const padding = MAX_CONFIG_BUNDLE_BYTES - size(await initial.text());
  await env.DB.prepare("UPDATE taxonomies SET name = name || ? WHERE slug = 'four'").bind('a'.repeat(padding)).run();
  const exact = await download('taxonomies');
  expect(exact.status).toBe(200);
  const file = new File([await exact.arrayBuffer()], 'settings.json');
  expect(file.size).toBe(MAX_CONFIG_BUNDLE_BYTES);
  const upload = new FormData();
  upload.set('bundle', file);
  expect((await call('/admin/settings/transfer/preview', upload)).status).toBe(200);

  const combined = await download('taxonomies', 'tags');
  expect(combined.status).toBe(200);
  expect((await combined.arrayBuffer()).byteLength).toBe(MAX_CONFIG_BUNDLE_BYTES);
  const resume = (cursor: string) => call('/admin/settings/transfer/export', new URLSearchParams({ cursor }));
  const tail = await resume(combined.headers.get('X-Next-Cursor')!);
  expect(await tail.json()).toMatchObject({ sections: { tags: [] } });
  expect(tail.headers.get('X-Next-Cursor')).toBeNull();

  await env.DB.prepare("UPDATE taxonomies SET name = name || 'x' WHERE slug = 'four'").run();
  const split = await download('taxonomies');
  const head = await split.text();
  const last = await resume(split.headers.get('X-Next-Cursor')!);
  const rest = await last.text();
  expect(Math.max(size(head), size(rest))).toBeLessThanOrEqual(MAX_CONFIG_BUNDLE_BYTES);
  expect([...JSON.parse(head).sections.taxonomies, ...JSON.parse(rest).sections.taxonomies].map(row => row.slug))
    .toEqual(['four', 'one', 'three', 'two']);
  upload.set('bundle', new File([file, ' '], 'oversized.json'));
  expect((await call('/admin/settings/transfer/preview', upload)).status).toBe(400);
});

it('imports numbered parts in order with a parent and child on opposite sides of the cursor', async () => {
  // Insert the child first so insertion order alone cannot satisfy its dependency.
  await env.DB.prepare("INSERT INTO tags(id,slug,name) VALUES (101,'child','Child'),(102,'parent','Parent')").run();
  await env.DB.prepare('UPDATE tags SET parent_tag=102 WHERE id=101').run();
  const sections = ['taxonomies', 'tags'];
  await env.DB.prepare("INSERT INTO taxonomies(slug,name) VALUES ('topic','Topics')").run();
  const description = '新'.repeat(350_000);
  await env.DB.prepare("UPDATE tags SET taxonomy_slug='topic', lect=?").bind(JSON.stringify({ description: { en: description } })).run();
  const first = await call('/admin/settings/transfer/export', new URLSearchParams(sections.map(id => ['sections', id])));
  const cursor = first.headers.get('X-Next-Cursor')!;
  expect(cursor).toBeTruthy();
  expect(first.headers.get('Content-Disposition')).toContain('-part-001.json');
  const resume = (token: string) => call('/admin/settings/transfer/export', new URLSearchParams({ cursor: token }));
  expect((await resume(cursor + 'x')).status).toBe(400);
  const second = await resume(cursor);
  expect(second.headers.get('Content-Disposition')).toContain('-part-002.json');
  expect(second.headers.get('X-Next-Cursor')).toBeNull();
  const parts = [await first.text(), await second.text()];
  expect(await (await resume(cursor)).text()).toBe(parts[1]);
  expect(JSON.parse(parts[0]).sections.tags.map((row: any) => row.slug)).toEqual(['parent']);
  expect(JSON.parse(parts[1]).sections.tags).toMatchObject([{ slug: 'child', parent: 'parent' }]);
  await wipe();
  for (const part of parts) {
    const file = new File([part], 'part.json');
    expect(file.size).toBeLessThanOrEqual(MAX_CONFIG_BUNDLE_BYTES);
    const preview = new FormData();
    preview.set('bundle', file);
    expect((await call('/admin/settings/transfer/preview', preview)).status).toBe(200);
    let remaining = 1;
    for (let batch = 0; remaining && batch < 4; batch++) {
      const applied = await call('/admin/settings/transfer/apply', applyForm(JSON.parse(part), sections));
      expect(applied.status).toBe(200);
      const html = await applied.text();
      expect(html).toContain('"stopped":""');
      remaining = Number(html.match(/"remaining":(\d+)/)![1]);
    }
    expect(remaining).toBe(0);
  }
  const restored = await snapshot();
  expect(restored.taxonomies).toEqual([{ slug: 'topic', name: 'Topics' }]);
  for (const tag of restored.tags) expect(tag.lect.description.en).toBe(description);
  expect(restored.tags).toMatchObject([{ slug: 'child', parent: 'parent' }, { slug: 'parent', parent: null }]);
});

it('names a record that cannot fit alone after JSON escaping', async () => {
  await env.DB.prepare("INSERT INTO taxonomies(slug,name) VALUES ('large-topic',?)").bind('"'.repeat(1_000_000)).run();
  const response = await call('/admin/settings/transfer/export', new URLSearchParams({ sections: 'taxonomies' }));
  expect(response.status).toBe(400);
  expect(response.headers.get('X-Next-Cursor')).toBeNull();
  expect(await response.text()).toContain('"large-topic" in taxonomies');
});

it('pages through the extension setting and preserves its existing normalization', async () => {
  const values = Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
    [`type-${i}`, { blocks: ['text', 1], taxonomies: [] }]));
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('content.page_type_extensions',?)")
    .bind(JSON.stringify({ ...values, constructor: { blocks: ['unsafe'] }, empty: {}, malformed: null })).run();
  const { sections } = await exportBundle(['page_type_extensions']);
  expect(sections.page_type_extensions).toEqual(Object.keys(values).sort().map(slug => ({
    slug, blocks: ['text'], taxonomies: [],
  })));
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
  expect(actions).toEqual(expect.arrayContaining(['plugin.create', 'page_type.create', 'block_type.create', 'role.create', 'settings.system.update']));
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
  expect(first).toContain('"autoContinue":true');
  const second = await (await call('/admin/settings/transfer/apply', applyForm(bundle, ['taxonomies']))).text();
  expect(second).toContain('"applied":3');
  expect(second).toContain('"autoContinue":false');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM taxonomies').first<{ n: number }>())!.n).toBe(taxonomies.length);
});

it('rolls back a role and its grants together, then resumes after the committed import prefix', async () => {
  const bundle = { format: '0xcms-config', version: 1, source: 'source-label', sections: {
    taxonomies: [{ slug: 'import-topic', name: 'Imported topic' }],
    roles: [{ name: 'import-editor', label: 'Imported role', permissions: ['tag:write'] }],
    system_settings: [{ key: SYSTEM_TIMEZONE_SETTING_KEY, value: '+0800' }],
  } };
  const apply = () => call('/admin/settings/transfer/apply', applyForm(bundle));
  await env.DB.prepare(`CREATE TRIGGER import_grant_fault BEFORE INSERT ON role_permissions
    WHEN NEW.role = 'import-editor' BEGIN SELECT RAISE(IGNORE); END`).run();
  try {
    const failed = await (await apply()).text();
    expect(failed).toContain('"applied":1');
    expect(failed).toContain('"autoContinue":false');
    expect(await env.DB.prepare("SELECT name FROM roles WHERE name = 'import-editor'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM audit_events WHERE action = 'role.create' AND target_id = 'import-editor'").first()).toBeNull();
    expect(await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(SYSTEM_TIMEZONE_SETTING_KEY).first()).toBeNull();
  } finally {
    await env.DB.prepare('DROP TRIGGER import_grant_fault').run();
  }

  expect(await (await apply()).text()).toContain('"applied":2');
  expect(await (await apply()).text()).toContain('"applied":0');
  expect(await env.DB.prepare("SELECT permission FROM role_permissions WHERE role = 'import-editor'").first()).toEqual({ permission: 'tag:write' });
  const { results } = await env.DB.prepare(`SELECT action, actor_user_id, detail FROM audit_events
    WHERE json_type(detail, '$.config_import') = 'object' ORDER BY seq`).all<{ action: string; actor_user_id: string; detail: string }>();
  expect(results.map(row => [row.action, row.actor_user_id])).toEqual([
    ['taxonomy.create', '18000'], ['role.create', '18000'], ['settings.system.update', '18000'],
  ]);
  const records = results.map(row => JSON.parse(row.detail));
  expect(records[1].grants).toEqual(['tag:write']);
  expect(records.map(record => [record.config_import.section, record.config_import.item])).toEqual([
    ['taxonomies', 1], ['roles', 1], ['system_settings', 2],
  ]);
  expect(records[0].config_import.attempt_id).not.toBe(records[1].config_import.attempt_id);
  expect(records[1].config_import.attempt_id).toBe(records[2].config_import.attempt_id);
  expect(JSON.stringify(records)).not.toContain('source-label');
});

it('stops subsequent role items after the import actor loses menu management', async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO roles (name, label, builtin) VALUES ('import-operator', 'Import operator', 0)"),
    env.DB.prepare("INSERT INTO role_permissions (role, permission) VALUES ('import-operator', 'menu:manage'), ('import-operator', 'roles:manage')"),
  ]);
  const bundle = { format: '0xcms-config', version: 1, sections: { roles: [
    { name: 'import-operator', label: 'Import operator', permissions: ['roles:manage'] },
    { name: 'new-import-role', label: 'New import role', permissions: [] },
  ] } };
  const response = await call('/admin/settings/transfer/apply', applyForm(bundle, ['roles']), 'import-operator');
  expect(await response.text()).toContain('"applied":1');
  expect(await env.DB.prepare("SELECT name FROM roles WHERE name = 'new-import-role'").first()).toBeNull();
  expect(await env.DB.prepare("SELECT permission FROM role_permissions WHERE role = 'import-operator'").first()).toEqual({ permission: 'roles:manage' });
});

it('keeps the previous section selection and only auto-continues ticked sections that still have changes', async () => {
  const taxonomies = Array.from({ length: MAX_CHANGES_PER_REQUEST + 1 }, (_, index) => ({ slug: `t-${index}`, name: `Topic ${index}` }));
  const tags = [{ slug: 'news', name: 'News', weight: 5, taxonomy: null, parent: null, lect: {} }];
  const bundle = { format: '0xcms-config', version: 1, exportedAt: '', source: 'https://source.example.com', sections: { taxonomies, tags } };
  const preview = await (await call('/admin/settings/transfer/preview', applyForm(bundle, []))).text();
  expect(preview).toContain('"autoContinue":false');
  expect(preview).not.toContain('"checked":false');
  const first = await (await call('/admin/settings/transfer/apply', applyForm(bundle, ['taxonomies']))).text();
  expect(first).toContain('"items":[{"label":"news","action":"create","actionKey":"settings.transfer.actions.create","note":""}],"checked":false');
  expect(first).toContain('"autoContinue":true');
  // Only the unticked section is left: nothing to auto-continue.
  const second = await (await call('/admin/settings/transfer/apply', applyForm(bundle, ['taxonomies']))).text();
  expect(second).toContain('"autoContinue":false');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM tags').first<{ n: number }>())!.n).toBe(0);
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

it('skips a partial import that would place a tag under its existing descendant', async () => {
  await seed(); // local-news already has news as its parent and is absent from the file.
  const before = (await snapshot()).tags;
  const bundle = { format: '0xcms-config', version: 1, sections: { tags: [
    { slug: 'news', name: 'Changed', parent: 'local-news' },
  ] } };
  for (const step of ['preview', 'apply']) {
    const response = await call(`/admin/settings/transfer/${step}`, applyForm(bundle, ['tags']));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('"label":"news","action":"skip"');
    expect(html).toContain('Its parent tags form a loop.');
    if (step === 'apply') expect(html).toContain('"applied":0');
  }
  expect((await snapshot()).tags).toEqual(before);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'tag.update'").first('n')).toBe(0);
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
