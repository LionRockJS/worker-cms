import { adminLayout, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';

export interface ProfileIdentity {
  id: string;
  provider: string;
  label: string;
  providerUserId: string;
  disconnectHref: string;
  canDisconnect: boolean;
  connected: boolean;
}

export interface ProfileProvider {
  provider: string;
  label: string;
  connected: boolean;
  connectHref: string;
}

export async function profilePage(views: Fetcher, opts: BaseTemplateProps & {
  email: string;
  name: string;
  roleLabel: string;
  avatarUrl: string;
  hasOwnAvatar: boolean;
  flash?: string;
  error?: string;
  identities: ProfileIdentity[];
  providers: ProfileProvider[];
  uiLocaleOptions: Array<{ code: string; label: string; selected: boolean }>;
  uiLocaleAction: string;
  /**
   * Props for panels contributed by a feature (today, credits). Passed through
   * to the view untouched: the section renders a panel only when the feature
   * that owns it supplied the props, so a build without it shows nothing.
   */
  panels?: Record<string, unknown>;
}): Promise<string> {
  const body = await renderView(views, '/templates/profile.json', {
    name: opts.name,
    email: opts.email,
    roleLabel: opts.roleLabel,
    avatarUrl: opts.avatarUrl,
    flash: opts.flash ?? '',
    error: opts.error ?? '',
    hasFlash: !!opts.flash,
    hasError: !!opts.error,
    hasAvatar: opts.avatarUrl.length > 0,
    hasOwnAvatar: opts.hasOwnAvatar,
    initial: opts.name.trim().charAt(0).toUpperCase() || opts.email.trim().charAt(0).toUpperCase() || '?',
    hasIdentities: opts.identities.length > 0,
    identities: opts.identities,
    hasProviders: opts.providers.length > 0,
    providers: opts.providers,
    ...opts.panels,
    uiLocaleOptions: opts.uiLocaleOptions,
    uiLocaleAction: opts.uiLocaleAction,
  });
  return adminLayout(views, opts, { title: 'Profile', body });
}
