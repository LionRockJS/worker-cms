import type { FeatureServiceEntry } from '../services';
import type { AppContext } from '../../core/http/context';
import { ConfigTransferItemError, isRecord, planChange, skipItem, type ConfigTransferSection } from '../../core/config-transfer';
import { PERMISSIONS, USER_ROLES } from '../../types';
import { safeRoleAuditValue } from '../../core/auth/role-mutation-sql';
import { getRoleForEdit, listRolesForAdmin } from './role-store';
import { assignableContributedPermissions, createRole, updateRole } from './role-writes';

const ROLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUILTIN = new Set<string>(USER_ROLES);

async function refusal(response: Response): Promise<never> {
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
  async exportItems(c) {
    const roles = (await listRolesForAdmin(c.env)).filter((role) => !role.locked);
    const items = [];
    for (const role of roles) {
      const state = await roleState(c, role.name);
      if (state) items.push({ name: role.name, builtin: role.builtin, label: role.label, permissions: state.permissions });
    }
    return items;
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
          const created = await createRole(c, name, label);
          if (created instanceof Response) await refusal(created);
          if (typeof created === 'string') throw new ConfigTransferItemError(created);
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
