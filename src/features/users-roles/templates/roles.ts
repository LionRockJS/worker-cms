import { adminLayout, type BaseTemplateProps } from '../../../core/render/layout';
import { renderView } from '../../../core/render/liquid';

export interface RoleListItem {
  name: string;
  label: string;
  labelKey: string;
  badge: string;
  badgeKey: string;
  permissionCount: number;
  editHref: string;
  deleteAction: string;
  canDelete: boolean;
}

export async function rolesPage(views: Fetcher, opts: BaseTemplateProps & {
  roles: RoleListItem[];
}): Promise<string> {
  const { roles } = opts;
  const body = await renderView(views, '/templates/roles.json', {
    hasRoles: roles.length > 0,
    roles,
  });
  return adminLayout(views, opts, { title: 'Roles', body });
}

export interface PermissionGroup {
  /** Literal heading (a plugin's name); used when labelKey is empty. */
  label: string;
  /** Locale key for a heading the CMS owns. */
  labelKey: string;
  options: Array<{ value: string; label: string; checked: boolean }>;
}

export async function roleFormPage(views: Fetcher, opts: BaseTemplateProps & {
  canManageIp?: boolean;
  ipAllowlist?: string;
  isNew: boolean;
  name: string;
  label: string;
  /** built-in roles can't be renamed/deleted; admin is fully locked. */
  builtin: boolean;
  locked: boolean;
  error?: string;
  permissionGroups: PermissionGroup[];
}): Promise<string> {
  const { isNew, name, label, builtin, locked, error, permissionGroups } = opts;
  const heading = isNew ? 'New Role' : locked ? `View Role: ${label}` : `Edit Role: ${label}`;
  const body = await renderView(views, '/templates/role-form.json', {
    canManageIp: !!opts.canManageIp,
    ipAllowlist: opts.ipAllowlist ?? '',
    ipAction: `/admin/roles/${encodeURIComponent(name)}/ip-access`,
    isNew,
    builtin,
    locked,
    heading,
    action: isNew ? '/admin/roles' : `/admin/roles/${name}`,
    deleteAction: `/admin/roles/${name}/delete`,
    canDelete: !isNew && !builtin,
    name,
    label,
    error: error ?? '',
    hasError: !!error,
    permissionGroups,
    hasPluginGroups: permissionGroups.length > 1,
  });
  return adminLayout(views, opts, { title: heading, body });
}
