import { auditUnavailable, flushReadAudit, recordTableReads } from '../../../core/http/access-log';
// User administration — list users and assign their roles. Admin-gated
// (users:manage). Users are created by OAuth login, not here.

import { Hono } from 'hono';
import { usersPage, userFormPage } from '../templates/users';
import type { Env, Variables, User } from '../../../types';
import { mutationAuditEvidence } from '../../../core/db/audit';
import { abortIf } from '../../../core/db/transaction-guard';
import { accessMutationClass, accessMutationUnavailable, unsafeAccessEvidence, authorizeAccessMutation } from '../mutation-audit';
import { safeRoleAuditValue } from '../../../core/auth/role-mutation-sql';
import { requirePermission } from '../../../core/auth/guards';
import { recordPolicyDenial } from '../../../core/auth/denials';
import type { AccessAuthorization } from '../../../core/auth/access-authorization';
import { userCan } from '../../../core/auth/permissions';
import { renderPage } from '../../../core/render/chrome';
import { maskPrivateValue } from '../../../core/render/privacy';
import { allRoleOptions } from '../../../core/auth/role-store';
import { ROLE_LABELS, builtinRoleTranslationKey, effectivePermissions, splitRoles } from '../../../core/auth/roles';
import { featureAdminScreenProps } from '../../services';
import type { AppContext } from '../../../core/http/context';

export const usersRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

usersRoutes.use('/users', requirePermission('users:manage'));
usersRoutes.use('/users/*', requirePermission('users:manage'));

interface UserListRow extends User {
  oauth_id: string;
}

interface UserIdentityProviderRow {
  user_id: number;
  provider: string;
}

function rolesForView(role: string, options: Array<{ name: string; label: string }>): Array<{ label: string; labelKey: string }> {
  const byName = new Map(options.map((option) => [option.name, option.label]));
  return role
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({
      label: byName.get(name) ?? ROLE_LABELS[name as keyof typeof ROLE_LABELS] ?? name,
      labelKey: builtinRoleTranslationKey(name),
    }));
}

function hasAdminRole(role: string): boolean {
  return splitRoles(role).includes('admin');
}

/** A delegated user manager may only manage/assign roles whose effective
 * permissions are a subset of their own. This prevents users:manage from
 * becoming an implicit path to the locked admin role or other stronger roles. */
function canManageRoleValue(authorization: AccessAuthorization, role: string): boolean {
  if (authorization.admin) return true;
  if (hasAdminRole(role)) return false;
  const targetPermissions = effectivePermissions(authorization.roleMap, role);
  return [...targetPermissions].every(permission => authorization.permissions.has(permission));
}

function providerFromOAuthId(oauthId: string): string {
  const index = oauthId.indexOf(':');
  return index === -1 ? 'legacy' : oauthId.slice(0, index);
}

function providerLabel(provider: string): string {
  if (provider === 'eventuai') return 'Eventuai';
  if (provider === 'github') return 'GitHub';
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'apple') return 'Apple';
  if (provider === 'legacy') return 'Legacy';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

usersRoutes.get('/users', async (c) => {
  const currentUserId = Number(c.get('user').sub);
  const [users, identities, options, adminCount, creditPanel] = await Promise.all([
    c.env.DB.prepare('SELECT id, oauth_id, name, email, role FROM users ORDER BY name ASC, email ASC').all<UserListRow>(),
    c.env.DB.prepare(
      `SELECT user_id, provider
         FROM user_oauth_identities
        ORDER BY created_at ASC, id ASC`,
    ).all<UserIdentityProviderRow>(),
    allRoleOptions(c.env),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'")
      .first<{ n: number }>(),
    featureAdminScreenProps(c, { screen: 'users' }),
  ]);
  recordTableReads('user.list', 'users', users.results.map(user => user.id));
  // Names and email addresses are personal data whether or not this screen is
  // the one being audited. Reveal is a deliberate grant; serving the values in
  // clear is recorded as its own disclosure.
  const canRevealPii = await userCan(c, 'pii:reveal');
  if (canRevealPii) recordTableReads('user.pii-reveal', 'users', users.results.map(user => user.id));
  const providersByUser = new Map<number, string[]>();
  for (const identity of identities.results) {
    const providers = providersByUser.get(identity.user_id) ?? [];
    if (!providers.includes(identity.provider)) providers.push(identity.provider);
    providersByUser.set(identity.user_id, providers);
  }

  return renderPage(c, usersPage, {
    canRevealPii,
    users: users.results.map((user) => {
      const providers = [...(providersByUser.get(user.id) ?? [])];
      const fallbackProvider = providerFromOAuthId(user.oauth_id);
      if (fallbackProvider && !providers.includes(fallbackProvider)) providers.push(fallbackProvider);
      return {
        id: user.id,
        name: canRevealPii ? user.name : maskPrivateValue(user.name, 'name'),
        email: canRevealPii ? user.email : maskPrivateValue(user.email, 'email'),
        identityProviders: providers.map((provider) => ({ provider, label: providerLabel(provider) })),
        roles: rolesForView(user.role, options),
        editHref: `/admin/users/${user.id}/edit`,
        deleteAction: `/admin/users/${user.id}/delete`,
        canDelete: user.id !== currentUserId && (!hasAdminRole(user.role) || (adminCount?.n ?? 0) > 1),
      };
    }),
    flash: c.req.query('flash') ?? '',
    error: c.req.query('error') ?? '',
    panels: creditPanel,
  });
});

usersRoutes.get('/users/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const user = await c.env.DB.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
    .bind(id)
    .first<User>();
  if (!user) return c.notFound();
  return userForm(c, user, c.req.query('error') || undefined, c.req.query('flash') || undefined);
});

usersRoutes.post('/users/:id', requirePermission('users:manage'), async (c) => {
  const { authorization, refused } = await authorizeAccessMutation(c, 'users:manage');
  if (refused) return refused;
  const id = parseInt(c.req.param('id'), 10);
  const user = await c.env.DB.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
    .bind(id)
    .first<User>();
  if (!user) return c.notFound();

  const form = await c.req.formData();
  const options = await allRoleOptions(c.env);
  const valid = new Set(options.map((option) => option.name));
  const selected = [...new Set(form.getAll('roles').map(String).filter((role) => valid.has(role)))];
  const nextRole = selected.length ? selected.join(',') : 'viewer';

  if (!canManageRoleValue(authorization, user.role) || !canManageRoleValue(authorization, nextRole)) {
    await recordPolicyDenial(c, !canManageRoleValue(authorization, user.role) ? 'target_role_exceeds_authority' : 'requested_role_exceeds_authority');
    return c.text('Forbidden: cannot assign or modify a more privileged role', 403);
  }

  // Lockout guard: never let the last admin lose the admin role.
  const losesAdmin = hasAdminRole(user.role) && !selected.includes('admin');
  if (losesAdmin) {
    const otherAdmins = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ? AND (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'")
      .bind(id)
      .first<{ n: number }>();
    if ((otherAdmins?.n ?? 0) === 0) {
      await recordPolicyDenial(c, 'last_administrator');
      return userForm(c, user, 'Cannot remove the admin role from the last administrator.');
    }
  }

  if (!safeRoleAuditValue(user.role) || !safeRoleAuditValue(nextRole)) return unsafeAccessEvidence(c);
  const classification = await accessMutationClass(c.env, ['users', 'roles', 'role_permissions']);
  if (classification === null) return auditUnavailable(c);
  const refusedRead = await flushReadAudit(c);
  if (refusedRead) return refusedRead;
  try {
    const evidence = mutationAuditEvidence(c, { action: 'user.roles', entityType: 'user', entityId: id,
      detail: { role_before: user.role, role: nextRole } }, classification.dataClass, { requirePreviousChange: true, policy: classification.policy });
    await c.env.DB.batch([
      authorization.guard(),
      // Recheck the observed target and last-admin guard inside the transaction.
      c.env.DB.prepare(`UPDATE users SET role = ? WHERE id = ? AND role = ?
        AND (? = 0 OR EXISTS (SELECT 1 FROM users WHERE id != ? AND (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'))`)
        .bind(nextRole, id, user.role, losesAdmin ? 1 : 0, id),
      evidence.write,
      evidence.guard,
      abortIf(c.env, 'NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND role = ?)', [id, nextRole]),
    ]);
  } catch {
    return accessMutationUnavailable(c);
  }
  return c.redirect('/admin/users');
});

usersRoutes.post('/users/:id/delete', requirePermission('users:manage'), async (c) => {
  const { authorization, refused } = await authorizeAccessMutation(c, 'users:manage');
  if (refused) return refused;
  const id = parseInt(c.req.param('id'), 10);
  const currentUserId = Number(c.get('user').sub);
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  if (id === currentUserId) {
    await recordPolicyDenial(c, 'self_deletion');
    return c.redirect('/admin/users?error=You+cannot+remove+your+own+user');
  }

  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(id)
    .first<Pick<User, 'id' | 'role'>>();
  if (!user) return c.notFound();

  if (!canManageRoleValue(authorization, user.role)) {
    await recordPolicyDenial(c, 'target_role_exceeds_authority');
    return c.text('Forbidden: cannot remove a more privileged user', 403);
  }

  if (hasAdminRole(user.role)) {
    const otherAdmins = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ? AND (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'")
      .bind(id)
      .first<{ n: number }>();
    if ((otherAdmins?.n ?? 0) === 0) {
      await recordPolicyDenial(c, 'last_administrator');
      return c.redirect('/admin/users?error=Cannot+remove+the+last+administrator');
    }
  }

  if (!safeRoleAuditValue(user.role)) return unsafeAccessEvidence(c);
  const classification = await accessMutationClass(c.env, ['users', 'roles', 'sessions', 'user_oauth_identities']);
  if (classification === null) return auditUnavailable(c);
  const refusedRead = await flushReadAudit(c);
  if (refusedRead) return refusedRead;
  try {
    const sessions = (await c.env.DB.prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY id').bind(id).all<{ id: number }>()).results.map(row => row.id);
    const evidence = mutationAuditEvidence(c, { action: 'user.delete', entityType: 'user', entityId: id,
      detail: { role_before: user.role, ...(sessions.length ? { revoked_session_ids: sessions } : {}) } }, classification.dataClass, { requirePreviousChange: true, policy: classification.policy });
    await c.env.DB.batch([
      authorization.guard(),
      abortIf(c.env, `(SELECT COUNT(*) FROM sessions WHERE user_id = ?) <> ?
        OR EXISTS (SELECT 1 FROM sessions WHERE user_id = ? AND id NOT IN (SELECT value FROM json_each(?)))`,
        [id, sessions.length, id, JSON.stringify(sessions)]),
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM user_oauth_identities WHERE user_id = ?').bind(id),
      // If authorization's observed role or last-admin state changed, a zero
      // row delete makes the required audit abort and restores both child sets.
      c.env.DB.prepare(`DELETE FROM users WHERE id = ? AND role = ?
        AND (? = 0 OR EXISTS (SELECT 1 FROM users WHERE id != ? AND (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'))`)
        .bind(id, user.role, hasAdminRole(user.role) ? 1 : 0, id),
      evidence.write,
      evidence.guard,
      abortIf(c.env, `EXISTS (SELECT 1 FROM users WHERE id = ?)
          OR EXISTS (SELECT 1 FROM sessions WHERE user_id = ?)
          OR EXISTS (SELECT 1 FROM user_oauth_identities WHERE user_id = ?)`, [id, id, id]),
    ]);
  } catch {
    return accessMutationUnavailable(c);
  }
  return c.redirect('/admin/users?flash=User+removed');
});

async function userForm(c: AppContext, user: User, error?: string, flash?: string): Promise<Response> {
  recordTableReads('user.read', 'users', [user.id]);
  const [options, creditPanel] = await Promise.all([
    allRoleOptions(c.env),
    featureAdminScreenProps(c, { screen: 'user', userId: user.id }),
  ]);
  const held = new Set(user.role.split(',').map((role) => role.trim()).filter(Boolean));
  return renderPage(c, userFormPage, {
    id: user.id,
    name: user.name,
    email: user.email,
    error,
    flash,
    roleOptions: options.map((option) => ({
      value: option.name,
      label: option.label,
      labelKey: builtinRoleTranslationKey(option.name),
      checked: held.has(option.name),
    })),
    panels: creditPanel,
  });
}
