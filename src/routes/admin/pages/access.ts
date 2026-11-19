import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { captureSelfAuthorization } from '../../../core/auth/access-authorization';
import { resolveRolePermissions } from '../../../core/auth/roles';
import { canManagePageAccess, pagePolicy } from '../../../core/auth/page-access';
import { mutationAuditEvidence } from '../../../core/db/audit';
import { resolveDataClasses } from '../../../core/db/data-classes';
import { abortIf } from '../../../core/db/transaction-guard';
import { rejectCrossSiteRequest } from '../../../core/http/headers';
import { renderPage } from '../../../core/render/chrome';
import { uiTranslator } from '../../../core/i18n';
import type { AppContext } from '../../../core/http/context';
import { adminLayout, type BaseTemplateProps } from '../../../core/render/layout';
import { renderView } from '../../../core/render/liquid';
import { fetchEditorUsers } from '../../../core/db/admin-queries';
import { recordPageReads, recordTableReads } from '../../../core/http/access-log';

type Account = { id: number; name: string };
type SearchAccount = Account & { email: string };
export const pageAccessRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function loadPage(c: AppContext) {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const page = await c.env.DB.prepare('SELECT id, uuid, name, page_type, creator, editors FROM pages WHERE id = ?')
    .bind(id).first<{ id: number; uuid: string; name: string; page_type: string | null; creator: number | null; editors: string | null }>();
  if (!page) return null;
  const policy = await pagePolicy(c.env, page.uuid);
  const owner = policy?.owner_id ?? page.creator;
  if (!canManagePageAccess(c.get('user'), owner)) return null;
  return { page, policy, owner };
}

async function renderAccess(views: Fetcher, opts: BaseTemplateProps & {
  pageId: number; title: string; pageName: string; revision: number; enabled: boolean; mode: string;
  owner: string; group: string | null; roles: string[]; grants: Account[];
  legacyEditors: Account[]; accounts: SearchAccount[]; query: string;
}) {
  const { pageId, title, mode } = opts;
  const body = await renderView(views, '/templates/page-access.json', {
    pageId, title, pageName: opts.pageName, owner: opts.owner, revision: opts.revision, enabled: opts.enabled, mode,
    action: `/admin/pages/${pageId}/access`,
    permissions: ['owner', 'group', 'others'].map((key, i) => ({ key, digit: mode[i] })),
    group: opts.group ?? '', roles: opts.roles, grants: opts.grants, legacyEditors: opts.legacyEditors,
    accounts: opts.accounts, query: opts.query,
  });
  return adminLayout(views, opts, { title, body });
}

pageAccessRoutes.get('/pages/:id/access', async c => {
  const target = await loadPage(c);
  if (!target) return c.notFound();
  const { page, policy, owner } = target;
  const query = (c.req.query('q') ?? '').trim().slice(0, 100);
  const [roles, grants, accounts, ownerAccount, legacyEditors] = await Promise.all([
    resolveRolePermissions(c.env),
    c.env.DB.prepare(`SELECT u.id, COALESCE(NULLIF(u.name,''),u.email) name FROM page_edit_grants g
      JOIN users u ON u.id = g.user_id WHERE g.page_uuid = ? ORDER BY name`).bind(page.uuid).all<Account>(),
    query ? c.env.DB.prepare(`SELECT id, COALESCE(NULLIF(name,''),email) name, email FROM users WHERE disabled_at IS NULL
      AND (instr(lower(name),lower(?)) > 0 OR instr(lower(email),lower(?)) > 0) ORDER BY name,id LIMIT 25`)
      .bind(query, query).all<SearchAccount>() : undefined,
    owner === null ? null : c.env.DB.prepare('SELECT COALESCE(NULLIF(name,\'\'),email) name FROM users WHERE id = ? AND disabled_at IS NULL')
      .bind(owner).first<{ name: string }>(),
    !policy?.enabled ? fetchEditorUsers(c.env.DB, page.editors) : [],
  ]);
  recordPageReads('page.access-view', [page]);
  recordTableReads('user.page-access-lookup', 'users',
    [...new Set([...(ownerAccount && owner ? [owner] : []), ...grants.results.map(user => user.id),
      ...legacyEditors.map(user => user.id), ...(accounts?.results ?? []).map(user => user.id)])].map(String));
  const t = await uiTranslator(c);
  return renderPage(c, renderAccess, {
    title: t('page_access.title', 'Page access'), pageId: page.id, pageName: page.name,
    revision: policy?.revision ?? 0, enabled: !!policy?.enabled, mode: String(policy?.mode ?? 600).padStart(3, '0'),
    owner: ownerAccount?.name ?? t('page_access.unassigned', 'Unassigned'), group: policy?.group_role ?? null,
    roles: [...roles.keys()].sort(), grants: grants.results, legacyEditors, accounts: accounts?.results ?? [], query,
  });
});

pageAccessRoutes.post('/pages/:id/access', async c => {
  const rejected = rejectCrossSiteRequest(c.req.raw);
  if (rejected) return rejected;
  const target = await loadPage(c);
  if (!target) return c.notFound();
  const { page, policy } = target;
  const form = await c.req.formData();
  const revision = policy?.revision ?? 0;
  if (form.get('revision') !== String(revision)) return c.text('Page access changed. Reload and try again.', 409);

  const action = form.get('action');
  const enabled = action === 'mode' ? 1 : policy?.enabled ?? 0;
  const userId = Number(form.get('user_id'));
  const group = action === 'mode' ? String(form.get('group_role') ?? '').trim() || null : policy?.group_role ?? null;
  const digits = ['owner', 'group', 'others'].map(key => String(form.get(key) ?? ''));
  const mode = action === 'mode' ? Number(digits.join('')) : policy?.mode ?? 600;
  const owner = action === 'transfer' ? userId : target.owner;
  if (action === 'mode') {
    if (!digits.every(digit => /^[046]$/.test(digit)) || (group === null && digits[1] !== '0')) {
      return c.text('Choose valid permissions and a role for group access.', 400);
    }
  } else if (!['transfer', 'add', 'remove'].includes(String(action)) || (!policy?.enabled && action !== 'transfer') ||
      !Number.isSafeInteger(userId) || userId <= 0) {
    return c.text('Invalid page access change.', 400);
  }
  if (!owner) return c.text('Assign an active owner first.', 400);

  const authority = await captureSelfAuthorization(c.env, c.get('user'));
  if (!authority.allowed) return c.text('Forbidden', 403);
  const dataClasses = await resolveDataClasses(c.env, true);
  if (!dataClasses.ok) return c.text('Page access unavailable', 503);
  const activeAccount = (id: number) => abortIf(c.env, 'NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL)', [id]);
  const grants = action === 'add' ? [userId] : !policy?.enabled && action === 'mode'
    ? [...new Set(form.getAll('legacy_user').map(Number))] : [];
  const legacy = new Set((page.editors ?? '').split(',').map(Number));
  if (grants.length > 100 || grants.some(id => !Number.isSafeInteger(id) || id <= 0 || (action !== 'add' && !legacy.has(id)))) {
    return c.text('Invalid editor selection.', 400);
  }
  const evidence = mutationAuditEvidence(c, {
    action: 'page.access.change', entityType: 'page', entityId: page.uuid,
    detail: { action, owner_id: owner, previous_owner_id: target.owner, enabled: !!enabled,
      group_role: group, mode, ...(grants.length ? { added_users: grants } : {}),
      ...(action === 'remove' ? { removed_user: userId } : {}) },
  }, 'none', { policy: dataClasses });
  const { DB } = c.env;
  const statements = [
    authority.guard(),
    abortIf(c.env, 'NOT EXISTS (SELECT 1 FROM pages WHERE id = ? AND uuid = ? AND creator IS ?)', [page.id, page.uuid, page.creator]),
    abortIf(c.env, 'COALESCE((SELECT revision FROM page_access_policies WHERE page_uuid = ?),0) <> ?', [page.uuid, revision]),
  ];
  if (!policy?.enabled || action === 'transfer') statements.push(activeAccount(owner));
  if (action === 'mode' && group && !authority.roleMap.has(group)) return c.text('Choose a current group role.', 400);
  statements.push(DB.prepare(`INSERT INTO page_access_policies (page_uuid,owner_id,enabled,group_role,mode,revision)
    VALUES (?,?,?,?,?,?) ON CONFLICT(page_uuid) DO UPDATE SET owner_id=excluded.owner_id, enabled=excluded.enabled,
      group_role=excluded.group_role, mode=excluded.mode, revision=excluded.revision`)
    .bind(page.uuid, owner, enabled, group, mode, revision + 1));
  for (const id of grants) {
    statements.push(activeAccount(id), DB.prepare('INSERT OR IGNORE INTO page_edit_grants (page_uuid,user_id) VALUES (?,?)').bind(page.uuid,id));
  }
  if (action === 'remove') statements.push(DB.prepare('DELETE FROM page_edit_grants WHERE page_uuid = ? AND user_id = ?').bind(page.uuid,userId));
  statements.push(evidence.write, evidence.guard, authority.guard(), abortIf(c.env, `NOT EXISTS (SELECT 1 FROM page_access_policies
    WHERE page_uuid = ? AND owner_id = ? AND enabled = ? AND mode = ? AND group_role IS ? AND revision = ?)`,
    [page.uuid, owner, enabled, mode, group, revision + 1]));
  if (grants.length) statements.push(abortIf(c.env, `EXISTS (SELECT 1 FROM json_each(?) selected
    WHERE NOT EXISTS (SELECT 1 FROM page_edit_grants WHERE page_uuid = ? AND user_id = selected.value))`,
    [JSON.stringify(grants), page.uuid]));
  if (action === 'remove') statements.push(abortIf(c.env,
    'EXISTS (SELECT 1 FROM page_edit_grants WHERE page_uuid = ? AND user_id = ?)', [page.uuid, userId]));
  try {
    await DB.batch(statements);
  } catch (error) {
    if (String(error).includes('malformed JSON')) return c.text('Page access or the selected account changed. Reload and try again.', 409);
    throw error;
  }
  c.executionCtx.waitUntil(c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${page.id}`))
    .fetch('https://page-sync/?action=access-changed', { method: 'POST' }).catch(() => {}));
  return c.redirect(action === 'transfer' && String(owner) !== c.get('user').sub && !authority.admin
    ? '/admin' : `/admin/pages/${page.id}/access`, 303);
});
