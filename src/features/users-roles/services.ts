import { EXPORT_READ_BATCH } from '../../core/config-export';
import { buildRolePermissions, ROLE_LABELS } from '../../core/auth/roles';
import { recordMetadataReads } from '../../core/http/access-log';
import type { FeatureServiceEntry } from '../services';
import type { AppContext } from '../../core/http/context';
import { ConfigTransferItemError, isRecord, planChange, skipItem, type ConfigTransferSection } from '../../core/config-transfer';
import { PERMISSIONS, USER_ROLES } from '../../types';
import { safeRoleAuditValue } from '../../core/auth/role-mutation-sql';
import { getRoleForEdit } from './role-store';
import { assignableContributedPermissions, createRole, updateRole } from './role-writes';

const ROLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUILTIN = new Set<string>(USER_ROLES);

async function refusal(response: Response): Promise<never> {
  if (response.status >= 500 || response.headers.get('X-CMS-Error') === 'management-permission-changed') {
    throw new Error(`Role import unavailable (${response.status})`);
  }
  const text = (await response.text().catch(() => '')).slice(0, 200);
  throw new ConfigTransferItemError(`Refused (${response.status})${text ? `: ${text}` : ''}`);
}

async function roleState(c: AppContext, name: string) {
  const role = await getRoleForEdit(c.env, name);
  return role && { label: role.builtin ? '' : role.label, permissions: [...role.permissions].sort() };
}

/** Role definitions and grants. The admin role is locked and never transferred. */
const rolesSection: ConfigTransferSection = {
  id: 'roles',
  labelKey: 'settings.transfer.sections.roles',
  order: 60,
  permission: 'roles:manage',
  async *exportRecords(c, after) {
    const builtin = USER_ROLES.filter(name => name !== 'admin');
    for (;;) {
      const { results: roles } = await c.env.DB.prepare(`SELECT name, label FROM (
        SELECT value AS name, '' AS label FROM json_each(?) WHERE value > ?
        UNION ALL SELECT name, label FROM roles WHERE builtin=0 AND name > ? AND name NOT IN (SELECT value FROM json_each(?))
        AND name <> 'admin') ORDER BY name LIMIT ?`)
        .bind(JSON.stringify(builtin), after, after, JSON.stringify(builtin), EXPORT_READ_BATCH).all<{ name: string; label: string }>();
      if (!roles.length) return;
      const names = roles.map(role => role.name);
      const keys = JSON.stringify(names);
      const [managed, grants] = await c.env.DB.batch([
        c.env.DB.prepare('SELECT name FROM roles WHERE name IN (SELECT value FROM json_each(?))').bind(keys),
        c.env.DB.prepare('SELECT role, permission FROM role_permissions WHERE role IN (SELECT value FROM json_each(?))').bind(keys),
      ]);
      const permissions = buildRolePermissions(managed.results as { name: string }[], grants.results as { role: string; permission: string }[]);
      recordMetadataReads('role.labels-read', 'roles', names);
      recordMetadataReads('role.grants-read', 'role_permissions', names, 'role_permission_set');
      for (const role of roles) {
        after = role.name;
        const builtinRole = BUILTIN.has(role.name);
        yield { key: after, label: role.name, item: { name: role.name, builtin: builtinRole,
          label: builtinRole ? ROLE_LABELS[role.name as keyof typeof ROLE_LABELS] : role.label,
          permissions: [...(permissions.get(role.name) ?? [])].sort() } };
      }
      if (roles.length < EXPORT_READ_BATCH) return;
    }
  },
  async plan(c, items) {
    const assignable = new Set<string>([...PERMISSIONS, ...(await assignableContributedPermissions(c.env)).map((p) => p.value)]);
    const plans = [];
    for (const raw of items) {
      const name = isRecord(raw) && typeof raw.name === 'string' ? raw.name : '';
      if (!isRecord(raw) || !ROLE_NAME.test(name) || !safeRoleAuditValue(name)) { plans.push(skipItem(name || '?', 'Invalid role name.')); continue; }
      if (name === 'admin') { plans.push(skipItem(name, 'The admin role cannot be changed.')); continue; }
      if ((raw.builtin === true) !== BUILTIN.has(name)) { plans.push(skipItem(name, 'Built-in and custom roles cannot replace each other.')); continue; }
      const label = BUILTIN.has(name) ? '' : typeof raw.label === 'string' ? raw.label.trim() : '';
      if (!BUILTIN.has(name) && !label) { plans.push(skipItem(name, 'Name is required.')); continue; }
      const requested = Array.isArray(raw.permissions) ? raw.permissions.filter((p): p is string => typeof p === 'string') : [];
      const permissions = [...new Set(requested.filter((p) => assignable.has(p)))].sort();
      const dropped = requested.length - permissions.length;
      const before = await roleState(c, name);
      const plan = planChange(name, before ?? undefined, { label, permissions }, async () => {
        if (!before) {
          const created = await createRole(c, name, label, permissions);
          if (created instanceof Response) await refusal(created);
          if (typeof created === 'string') throw new ConfigTransferItemError(created);
          return;
        }
        const refused = await updateRole(c, name, label, permissions);
        if (refused) await refusal(refused);
      });
      // Usually a plugin permission whose plugin is not registered or connected here yet.
      if (dropped) plan.note = `${dropped} permission(s) not available on this CMS were left out.`;
      plans.push(plan);
    }
    return plans;
  },
};

export const usersRolesServices: FeatureServiceEntry = {
  id: 'users-roles',
  configTransferSections: [rolesSection],
};
