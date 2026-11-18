import { USER_ROLES, type Env } from '../../types';
import { recordMetadataReads } from '../http/access-log';
import { ROLE_LABELS } from './roles';

/** All assignable roles (built-in + custom) as { name, label } for pickers. */
export async function allRoleOptions(env: Env): Promise<Array<{ name: string; label: string }>> {
  const custom = await env.DB.prepare('SELECT name, label FROM roles WHERE builtin = 0 ORDER BY label ASC')
    .all<{ name: string; label: string }>();
  recordMetadataReads('role.labels-read', 'roles', custom.results.map(row => row.name));
  return [
    ...USER_ROLES.map((name) => ({ name, label: ROLE_LABELS[name] })),
    ...custom.results,
  ];
}
