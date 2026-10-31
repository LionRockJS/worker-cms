import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Env, Variables } from '../src/types';
import { accessLog } from '../src/core/http/access-log';
import { requestContext } from '../src/core/http/request-context';
import { getSetting } from '../src/core/db/settings';
import { clearConfigCache, resolveCmsConfig } from '../src/core/db/content-config';
import { countPageMetadata } from '../src/core/db/count-metadata';
import { countTrashMetadataByType } from '../src/features/trash/queries';
import { readD1PageSource } from '../src/core/publish/d1';
import { auditLiveReads } from '../src/core/publish/read-audit';
import { allRoleOptions, getRoleForEdit, listRolesForAdmin } from '../src/core/auth/role-store';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { listLocales, listLocaleMessages } from '../src/core/i18n';

const testEnv = env as unknown as Env;
const actor = { userId: 'metadata-user', roles: null, sessionSid: null, via: 'metadata-contributor' };

beforeEach(async () => {
  clearConfigCache(); clearRolePermissionsCache();
  await env.DB.prepare('DROP TRIGGER IF EXISTS metadata_audit_fail').run();
  for (const table of ['audit_events', 'data_classes', 'pages', 'trash_pages', 'settings', 'role_permissions', 'roles', 'page_types', 'block_types', 'locale_messages']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('private.setting', 'private-setting-value')").run();
  await env.DB.prepare("INSERT INTO roles (name, label, builtin) VALUES ('private-role', 'Private role label', 0)").run();
  await env.DB.prepare("INSERT INTO role_permissions (role, permission) VALUES ('private-role', 'content:read')").run();
  await env.DB.prepare("INSERT INTO locale_messages (locale_code, message_key, value) VALUES ('en', 'private.message', 'Private translation value')").run();
  await env.DB.prepare("INSERT INTO page_types (id, slug, name, blueprint) VALUES (8101, 'private-type', 'Private schema', '[\"name\"]')").run();
  await env.DB.prepare("INSERT INTO block_types (id, slug, name, blueprint) VALUES (8102, 'private-block', 'Private block', '[\"secret\"]')").run();
  await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
  await env.PUBLISHED_DB.prepare('DELETE FROM tags').run();
});
afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS metadata_audit_fail').run();
  clearConfigCache(); clearRolePermissionsCache();
});

async function classify(kind: string, key: string) {
  await env.DB.prepare("INSERT INTO data_classes (container_kind, container_key, class) VALUES (?, ?, 'phi')").bind(kind, key).run();
}
async function failAudit() {
  await env.DB.prepare("CREATE TRIGGER metadata_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
}
function request(load: () => Promise<unknown>, user = actor) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (_, next) => { await requestContext.run({ cspNonce: '', readActor: user }, () => next()); });
  app.use('*', accessLog);
  app.get('/', async c => c.json({ value: await load() }));
  return app.request('http://localhost/', {}, testEnv);
}

const loaders = [
  ['settings', 'settings.read', 'private.setting', () => getSetting(testEnv, 'private.setting')],
  ['roles', 'role.labels-read', 'private-role', () => allRoleOptions(testEnv)],
  ['roles', 'role.labels-read', 'private-role', () => getRoleForEdit(testEnv, 'private-role')],
  ['role_permissions', 'role.grants-read', 'private-role', () => listRolesForAdmin(testEnv)],
  ['locales', 'locale.read', 'en', () => listLocales(testEnv)],
  ['locale_messages', 'translation.read', 'en:private.message', () => listLocaleMessages(testEnv, 'en')],
] as const;

it.each(loaders)('protects shared %s metadata through %s', async (table, action, id, load) => {
  await classify('table', table);
  expect((await request(load)).status).toBe(200);
  const row = await env.DB.prepare('SELECT target_id, target_ids, actor_user_id, acting_via, detail FROM audit_events WHERE action = ?').bind(action)
    .first<{ target_id: string; target_ids: string; actor_user_id: string; acting_via: string; detail: string | null }>();
  expect(row).toMatchObject({ actor_user_id: actor.userId, acting_via: actor.via, detail: null });
  expect([row?.target_id, ...JSON.parse(row?.target_ids ?? '[]')]).toContain(id);
  expect(JSON.stringify(row)).not.toMatch(/private-setting-value|Private role label|Private translation value/);
  await failAudit();
  const response = await request(load);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(/private-setting-value|Private role label|Private translation value/);
});

it('merges repeated shared-loader announcements without duplicating their identifiers', async () => {
  await classify('table', 'settings');
  expect((await request(async () => [await getSetting(testEnv, 'private.setting'), await getSetting(testEnv, 'private.setting')])).status).toBe(200);
  expect((await env.DB.prepare("SELECT target_id, target_count FROM audit_events WHERE action = 'settings.read'").all()).results)
    .toEqual([{ target_id: 'private.setting', target_count: 1 }]);
});

it.each(['page_types', 'block_types', 'locales', 'settings'])('retains %s provenance on a warm configuration cache without caching actors', async table => {
  // Warm outside HTTP, when source loaders have no request audit buffer.
  await resolveCmsConfig(testEnv);
  await classify('table', table);
  for (const userId of ['first-user', 'second-user']) {
    expect((await request(() => resolveCmsConfig(testEnv), { ...actor, userId })).status).toBe(200);
  }
  const rows = (await env.DB.prepare("SELECT actor_user_id, acting_via, target_ids, target_id FROM audit_events WHERE event_class = 'read' AND container_key = ? ORDER BY seq")
    .bind(table).all()).results;
  expect(rows.map(row => row.actor_user_id)).toEqual(['first-user', 'second-user']);
  expect(rows.every(row => row.acting_via === actor.via)).toBe(true);
  await failAudit();
  expect((await request(() => resolveCmsConfig(testEnv))).status).toBe(503);
});

it('keeps unclassified shared metadata on its ordinary response path', async () => {
  const response = await request(async () => ({ setting: await getSetting(testEnv, 'private.setting'), config: await resolveCmsConfig(testEnv) }));
  expect(response.status).toBe(200);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_class = 'read'").first())?.n).toBe(0);
});

it('merges cold configuration and shared-loader evidence for the same source', async () => {
  await classify('table', 'locales'); await classify('table', 'settings');
  expect((await request(() => resolveCmsConfig(testEnv))).status).toBe(200);
  const rows = (await env.DB.prepare("SELECT container_key, COUNT(*) AS n FROM audit_events WHERE event_class = 'read' GROUP BY container_key ORDER BY container_key").all()).results;
  expect(rows).toEqual([{ container_key: 'locales', n: 1 }, { container_key: 'settings', n: 1 }]);
});

it.each([false, true])('captures private count sensitivity before source removal (zero-result probe: %s)', async zero => {
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (8110, 'private-count-source', 'Private', 'private', 'article', '{}')").run();
  await env.DB.prepare("INSERT INTO page_sensitivity_floors (uuid, level) VALUES ('private-count-source', 2)").run();
  const response = await request(async () => {
    const total = await countPageMetadata(env.DB, 'p.name = ?', [zero ? 'unmatched-private-term' : 'Private'], { types: ['article'] });
    await env.DB.prepare('DELETE FROM pages WHERE id = 8110').run();
    return total;
  });
  expect(response.status).toBe(200);
  const row = await env.DB.prepare("SELECT data_class, target_count, query_fingerprint, actor_user_id, acting_via, detail FROM audit_events WHERE action = 'page.count'").first();
  expect(row).toMatchObject({ data_class: 'phi', target_count: zero ? 0 : 1, actor_user_id: actor.userId, acting_via: actor.via, detail: null });
  expect(row?.query_fingerprint).toMatch(/^[a-f0-9]{24}$/);
  expect(JSON.stringify(row)).not.toContain('unmatched-private-term');
});

it('withholds captured private count metadata after deletion when evidence cannot persist', async () => {
  await env.DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (8110, 'private-count-source', 'Private', 'private', 'article', '{}')").run();
  await env.DB.prepare("INSERT INTO page_sensitivity_floors (uuid, level) VALUES ('private-count-source', 2)").run();
  const response = await request(async () => {
    const total = await countPageMetadata(env.DB, '1', [], { types: ['article'] });
    await env.DB.prepare('DELETE FROM pages WHERE id = 8110').run();
    await failAudit();
    return total;
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('"value"');
});

it.each(['total', 'recent', 'summary'])('captures trash %s sensitivity before its source is purged', async kind => {
  await env.DB.prepare("INSERT INTO trash_pages (id, uuid, name, slug, page_type, lect) VALUES (8120, 'private-trash-count', 'Private trash', 'private-trash-count', 'article', '{}')").run();
  await env.DB.prepare("INSERT INTO page_sensitivity_floors (uuid, level) VALUES ('private-trash-count', 2)").run();
  const response = await request(async () => {
    const value = kind === 'summary' ? await countTrashMetadataByType(env.DB)
      : await countPageMetadata(env.DB, kind === 'recent' ? "p.created_at >= datetime('now', '-1 hour')" : '1', [],
        { source: 'trash_pages', types: ['article'], action: kind === 'recent' ? 'page.trash-recent-count' : 'page.trash-count' });
    await env.DB.prepare('DELETE FROM trash_pages').run();
    return value;
  });
  expect(response.status).toBe(200);
  expect(await env.DB.prepare("SELECT data_class, target_count, actor_user_id FROM audit_events WHERE event_class = 'read'").first())
    .toEqual({ data_class: 'phi', target_count: 1, actor_user_id: actor.userId });
});

it('withholds a purged trash summary when its captured evidence fails', async () => {
  await env.DB.prepare("INSERT INTO trash_pages (id, uuid, name, slug, page_type, lect) VALUES (8120, 'private-trash-count', 'Private trash', 'private-trash-count', 'article', '{}')").run();
  await env.DB.prepare("INSERT INTO page_sensitivity_floors (uuid, level) VALUES ('private-trash-count', 2)").run();
  const response = await request(async () => {
    const summary = await countTrashMetadataByType(env.DB);
    await env.DB.prepare('DELETE FROM trash_pages').run();
    await failAudit();
    return summary;
  });
  expect(response.status).toBe(503);
});

const sourceCases = (['identity', 'full'] as const).flatMap(projection => (['retag', 'delete'] as const)
  .flatMap(change => [false, true].map(failure => [projection, change, failure] as const)));

it.each(sourceCases)('retains published %s provenance through %s (audit failure: %s)', async (projection, change, failure) => {
  // This UUID never existed in the CMS: only the captured source taxonomy can protect it.
  await env.PUBLISHED_DB.prepare("INSERT INTO pages (id, uuid, name, slug, page_type, lect) VALUES (8130, 'source-only-snapshot', 'Private live', 'private-live', 'article', '{\"secret\":\"private-live-body\"}')").run();
  await env.PUBLISHED_DB.prepare("INSERT INTO tags (id, name, slug, taxonomy_slug) VALUES (8131, 'Private diagnosis', 'private-diagnosis', 'clinical')").run();
  await env.PUBLISHED_DB.prepare('INSERT INTO page_tags (page_id, tag_id) VALUES (8130, 8131)').run();
  await classify('taxonomy', 'clinical');
  const response = await request(async () => {
    const source = await readD1PageSource<{ uuid: string; page_type: string | null }>(env.PUBLISHED_DB, projection, '1', []);
    expect(JSON.stringify(source.rows)).not.toMatch(/taxonomy_json|taxonomy_slugs/);
    expect(source.provenance).toEqual([{ uuid: 'source-only-snapshot', page_type: 'article', taxonomy_slugs: ['clinical'] }]);
    if (change === 'retag') await env.PUBLISHED_DB.prepare("UPDATE tags SET taxonomy_slug = 'public-labels'").run();
    else await env.PUBLISHED_DB.prepare('DELETE FROM pages').run();
    await auditLiveReads(testEnv, { id: 'd1' }, source.provenance, undefined, 'page.live-status');
    if (failure) await failAudit();
    return source.rows;
  });
  expect(response.status).toBe(failure ? 503 : 200);
  if (failure) expect(await response.text()).not.toContain('private-live-body');
  else expect(await env.DB.prepare("SELECT data_class, container_key, target_id FROM audit_events WHERE action = 'page.live-status'").first())
    .toEqual({ data_class: 'phi', container_key: 'clinical', target_id: 'source-only-snapshot' });
});
