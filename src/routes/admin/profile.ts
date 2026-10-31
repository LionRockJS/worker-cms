import { Hono } from 'hono';
import { profilePage } from '../../core/templates/profile';
import type { Env, Variables, User } from '../../types';
import { renderPage } from '../../core/render/chrome';
import { ROLE_LABELS } from '../../core/auth/roles';
import { allRoleOptions } from '../../core/auth/role-store';
import { featureAdminScreenProps } from '../../features/services';
import { localeRegistry, resolveUiLocale, setUiLocaleCookie } from '../../core/i18n';
import { appendQuery, safeAdminReturnPath, str } from '../../core/http/forms';
import { logAudit } from '../../core/db/audit';
import { recordTableReads } from '../../core/http/access-log';


export const profileRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();


interface OAuthIdentityRow {
  id: number;
  provider: string;
  provider_user_id: string;
  oauth_id: string;
}

const KNOWN_PROVIDERS = ['eventuai', 'github', 'google', 'microsoft', 'apple'] as const;

function providerLabel(provider: string): string {
  if (provider === 'eventuai') return 'Eventuai';
  if (provider === 'github') return 'GitHub';
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'apple') return 'Apple';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function enabledProviders(env: Env): string[] {
  const known = new Set<string>(KNOWN_PROVIDERS);
  return (env.ENABLED_PROVIDERS ?? '')
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider) => known.has(provider));
}

function splitOAuthId(oauthId: string): { provider: string; providerUserId: string } {
  const index = oauthId.indexOf(':');
  if (index === -1) return { provider: 'legacy', providerUserId: oauthId };
  return { provider: oauthId.slice(0, index), providerUserId: oauthId.slice(index + 1) };
}

function roleLabel(role: string, options: Array<{ name: string; label: string }>): string {
  const byName = new Map(options.map((option) => [option.name, option.label]));
  return role
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => byName.get(name) ?? ROLE_LABELS[name as keyof typeof ROLE_LABELS] ?? name)
    .join(', ');
}

profileRoutes.get('/profile', async (c) => {
  const userId = Number(c.get('user').sub);
  const flash = c.req.query('flash') ?? '';
  const error = c.req.query('error') ?? '';
  const [user, identityRows, roleOptions, creditPanel, registry, currentUiLocale] = await Promise.all([
    c.env.DB.prepare('SELECT id, oauth_id, email, name, avatar_url, role FROM users WHERE id = ?')
      .bind(userId)
      .first<User>(),
    c.env.DB.prepare(
      `SELECT id, provider, provider_user_id, oauth_id
         FROM user_oauth_identities
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
      .bind(userId)
      .all<OAuthIdentityRow>(),
    allRoleOptions(c.env),
    featureAdminScreenProps(c, { screen: 'profile' }),
    localeRegistry(c.env),
    resolveUiLocale(c),
  ]);
  if (!user) return c.notFound();
  // The user's own row is announced by the common authenticated chrome.
  recordTableReads('identity.profile-read', 'user_oauth_identities', identityRows.results.map(row => row.id));

  const byOAuthId = new Map<string, OAuthIdentityRow>();
  for (const identity of identityRows.results) {
    byOAuthId.set(identity.oauth_id, identity);
  }
  if (user.oauth_id && !byOAuthId.has(user.oauth_id)) {
    const fallback = splitOAuthId(user.oauth_id);
    byOAuthId.set(user.oauth_id, {
      id: 0,
      provider: fallback.provider,
      provider_user_id: fallback.providerUserId,
      oauth_id: user.oauth_id,
    });
  }

  const identityCount = byOAuthId.size;
  const identities = Array.from(byOAuthId.values()).map((identity) => ({
    id: String(identity.id),
    provider: identity.provider,
    label: providerLabel(identity.provider),
    providerUserId: identity.provider_user_id,
    disconnectHref: `/admin/profile/identities/${identity.id}/disconnect`,
    canDisconnect: identity.id > 0 && identityCount > 1,
    connected: true,
  }));
  const connected = new Set(identities.map((identity) => identity.provider));
  const providers = enabledProviders(c.env).map((provider) => ({
    provider,
    label: providerLabel(provider),
    connected: connected.has(provider),
    connectHref: `/auth/start?provider=${encodeURIComponent(provider)}&link=1`,
  }));

  return renderPage(c, profilePage, {
    name: user.name,
    email: user.email,
    roleLabel: roleLabel(user.role, roleOptions),
    avatarUrl: user.avatar_url ?? '',
    flash,
    error,
    identities,
    providers,
    // Panels contributed by a feature (today, the credits card).
    panels: creditPanel,
    uiLocaleOptions: registry.uiLocales.map((locale) => ({
      code: locale.code,
      label: locale.label,
      selected: locale.code === currentUiLocale.code,
    })),
    uiLocaleAction: '/admin/profile/locale',
  });
});

profileRoutes.post('/profile', async (c) => {
  const userId = Number(c.get('user').sub);
  const form = await c.req.formData();
  const name = str(form.get('name'));
  if (!name || name.length > 100) {
    return c.redirect('/admin/profile?error=profile.invalid_name', 303);
  }

  await c.env.DB.prepare('UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(name, userId)
    .run();
  logAudit(c, 'profile.update', 'user', userId);
  return c.redirect('/admin/profile?flash=profile.name_saved', 303);
});

profileRoutes.post('/profile/locale', async (c) => {
  const form = await c.req.formData();
  const back = safeAdminReturnPath(form.get('return_to'), '/admin/profile');
  const requested = String(form.get('locale') ?? '');
  const { uiLocales } = await localeRegistry(c.env);
  if (!uiLocales.some((locale) => locale.code === requested)) {
    return c.redirect(appendQuery(back, 'error=profile.language_not_enabled'), 303);
  }
  setUiLocaleCookie(c, requested);
  return c.redirect(appendQuery(back, 'flash=profile.language_saved'), 303);
});

profileRoutes.post('/profile/identities/:id/disconnect', async (c) => {
  const userId = Number(c.get('user').sub);
  const identityId = Number(c.req.param('id'));
  if (!Number.isInteger(identityId) || identityId <= 0) {
    return c.redirect('/admin/profile?error=Invalid+identity');
  }

  const identity = await c.env.DB.prepare(
    'SELECT id, user_id, oauth_id FROM user_oauth_identities WHERE id = ? AND user_id = ?',
  )
    .bind(identityId, userId)
    .first<{ id: number; user_id: number; oauth_id: string }>();
  if (!identity) {
    return c.redirect('/admin/profile?error=Identity+not+found');
  }

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM user_oauth_identities WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) <= 1) {
    return c.redirect('/admin/profile?error=At+least+one+sign-in+method+is+required');
  }

  const user = await c.env.DB.prepare('SELECT oauth_id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ oauth_id: string }>();
  if (user?.oauth_id === identity.oauth_id) {
    const replacement = await c.env.DB.prepare(
      `SELECT oauth_id
         FROM user_oauth_identities
        WHERE user_id = ? AND id != ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
    )
      .bind(userId, identityId)
      .first<{ oauth_id: string }>();
    if (!replacement) {
      return c.redirect('/admin/profile?error=At+least+one+sign-in+method+is+required');
    }
    await c.env.DB.prepare('UPDATE users SET oauth_id = ? WHERE id = ?')
      .bind(replacement.oauth_id, userId)
      .run();
  }

  await c.env.DB.prepare('DELETE FROM user_oauth_identities WHERE id = ? AND user_id = ?')
    .bind(identityId, userId)
    .run();

  return c.redirect('/admin/profile?flash=Sign-in+method+disconnected');
});
