import { safeRoleAuditValue } from './role-mutation-sql';

export interface InitialRoleIdentity {
  provider: string;
  providerUserId: string;
  email: string;
  emailVerified?: boolean;
}

const PROVIDERS = new Set(['eventuai', 'github', 'google', 'microsoft', 'apple']);

/** Deployment-owned grants for account creation only. Never call on login to
 * an existing account: doing so would override later administrator decisions. */
export function initialUserRoles(config: string | undefined, identity: InitialRoleIdentity): string {
  if (!config?.trim()) return 'viewer';
  // Do not include configuration contents (personal identities) in errors.
  const invalid = () => new Error('Invalid INITIAL_USER_ROLES configuration');
  let entries: unknown;
  try { entries = JSON.parse(config); } catch { throw invalid(); }
  if (!Array.isArray(entries)) throw invalid();

  const granted = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some(key => !['provider', 'providerUserId', 'email', 'roles'].includes(key))
      || typeof row.provider !== 'string' || !PROVIDERS.has(row.provider)
      || (row.email === undefined) === (row.providerUserId === undefined)
      || !Array.isArray(row.roles) || !row.roles.length) throw invalid();
    if (row.email !== undefined && (typeof row.email !== 'string'
      || !/^[^\s@*]+@[^\s@*]+$/.test(row.email.trim()))) throw invalid();
    if (row.providerUserId !== undefined && (typeof row.providerUserId !== 'string'
      || !row.providerUserId.trim() || row.providerUserId !== row.providerUserId.trim())) throw invalid();

    const roles: string[] = [];
    for (const role of row.roles) {
      if (typeof role !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role.trim().toLowerCase())) throw invalid();
      roles.push(role.trim().toLowerCase());
    }
    if (!safeRoleAuditValue(roles.join(','))) throw invalid();
    const matches = row.provider === identity.provider && (row.providerUserId !== undefined
      ? row.providerUserId === identity.providerUserId
      : identity.emailVerified === true && (row.email as string).trim().toLowerCase() === identity.email.trim().toLowerCase());
    if (matches) for (const role of roles) granted.add(role);
  }
  const value = [...granted].join(',') || 'viewer';
  if (!safeRoleAuditValue(value)) throw invalid();
  return value;
}
