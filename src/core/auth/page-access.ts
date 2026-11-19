// Page permissions live in page_access_policies / page_edit_grants, never in
// lect: version restores and content writers must not change access. See
// docs/page-access.md.
import type { Env, JWTPayload } from '../../types';
import { abortIf } from '../db/transaction-guard';
import type { AppContext } from '../http/context';
import { effectivePermissions, resolveRolePermissions, splitRoles } from './roles';

export interface PageAccessPolicy {
  owner_id: number;
  enabled: 0 | 1;
  group_role: string | null;
  mode: number;
  revision: number;
}

export interface PageAccessFilter {
  sql: string;
  args: Array<string | number>;
}

type PageAccessAction = 'read' | 'write';
type PageActor = Pick<JWTPayload, 'sub' | 'role'>;

/** Correlated SQL used both before pagination and inside mutation batches. */
export function pageAccessFilter(
  actor: PageActor,
  action: PageAccessAction,
  uuid: string,
  legacyAllowed: boolean,
): PageAccessFilter {
  const roles = splitRoles(actor.role);
  if (roles.includes('admin')) return { sql: '1', args: [] };
  const digit = action === 'read' ? 4 : 6;
  return {
    sql: `COALESCE((SELECT (
      CASE WHEN acl.owner_id = CAST(? AS INTEGER) THEN acl.mode / 100
        WHEN acl.group_role IN (SELECT value FROM json_each(?)) THEN acl.mode / 10 % 10
        ELSE acl.mode % 10 END >= ${digit}
      OR EXISTS (SELECT 1 FROM page_edit_grants g WHERE g.page_uuid = acl.page_uuid AND g.user_id = CAST(? AS INTEGER))
    ) FROM page_access_policies acl WHERE acl.page_uuid = ${uuid} AND acl.enabled = 1), ${legacyAllowed ? 1 : 0})`,
    args: [actor.sub, JSON.stringify(roles), actor.sub],
  };
}

export function legacyPageFilter(uuid: string): string {
  return `NOT EXISTS (SELECT 1 FROM page_access_policies acl WHERE acl.page_uuid = ${uuid} AND acl.enabled = 1)`;
}

export async function requestPageFilter(
  c: AppContext, action: PageAccessAction, uuid: string, legacyPermission = `content:${action}` as const,
): Promise<PageAccessFilter> {
  const actor = c.get('user');
  const permissions = effectivePermissions(await resolveRolePermissions(c.env), actor.role);
  return pageAccessFilter(actor, action, uuid, permissions.has(legacyPermission));
}

export async function pageAllowed(
  env: Env, actor: PageActor, pageId: number | string, action: PageAccessAction, legacyAllowed: boolean,
): Promise<boolean> {
  if (!Number.isSafeInteger(Number(pageId)) || Number(pageId) < 1) return false;
  const filter = pageAccessFilter(actor, action, 'p.uuid', legacyAllowed);
  return !!await env.DB.prepare(`SELECT 1 FROM pages p WHERE p.id = ? AND ${filter.sql}`)
    .bind(pageId, ...filter.args).first();
}

export async function requestPageAllowed(
  c: AppContext, pageId: number, action: PageAccessAction, legacyAllowed?: boolean,
): Promise<boolean> {
  const actor = c.get('user');
  const permissions = await resolveRolePermissions(c.env);
  return pageAllowed(c.env, actor, pageId, action,
    legacyAllowed ?? effectivePermissions(permissions, actor.role).has(`content:${action}`));
}

export function pageAccessGuard(env: Env, actor: PageActor, uuids: string[], legacyAllowed: boolean) {
  const filter = pageAccessFilter(actor, 'write', 'target.value', legacyAllowed);
  return abortIf(env, `EXISTS (SELECT 1 FROM json_each(?) target WHERE NOT (${filter.sql}))`,
    [JSON.stringify(uuids), ...filter.args]);
}

export function pagePolicy(env: Env, uuid: string) {
  return env.DB.prepare('SELECT owner_id, enabled, group_role, mode, revision FROM page_access_policies WHERE page_uuid = ?')
    .bind(uuid).first<PageAccessPolicy>();
}

export function canManagePageAccess(actor: PageActor, owner: number | null): boolean {
  return splitRoles(actor.role).includes('admin') || (owner !== null && String(owner) === actor.sub);
}

export async function hasReadablePage(c: AppContext): Promise<boolean> {
  const access = await requestPageFilter(c, 'read', 'p.uuid');
  return !!await c.env.DB.prepare(`SELECT 1 FROM pages p WHERE ${access.sql} LIMIT 1`)
    .bind(...access.args).first();
}
