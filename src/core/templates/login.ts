import { assetRevisionQuery, layout } from '../render/layout';
import { renderView } from '../render/liquid';

function providerLabel(provider: string): string {
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'apple') return 'Apple';
  if (provider === 'eventuai') return 'Eventuai';
  return 'GitHub';
}

function providerIcon(provider: string, revisionQuery: string): string {
  const sprite = `/assets/icons.svg${revisionQuery}`;
  if (provider === 'google') {
    return `<svg class="w-5 h-5" viewBox="0 0 24 24"><use href="${sprite}#google"></use></svg>`;
  }
  if (provider === 'microsoft') {
    return `<svg class="w-5 h-5" viewBox="0 0 24 24"><use href="${sprite}#microsoft"></use></svg>`;
  }
  if (provider === 'apple') {
    return `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><use href="${sprite}#apple"></use></svg>`;
  }
  if (provider === 'eventuai') {
    return `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><use href="${sprite}#key"></use></svg>`;
  }
  return `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><use href="${sprite}#github"></use></svg>`;
}

export async function loginPage(views: Fetcher, opts: {
  siteTitle: string;
  appIcon: string;
  appPrimaryColor: string;
  appFont: string;
  providers: string[];
  error?: string;
  viewRevision?: string;
  uiLocale: string;
  uiDirection: 'ltr' | 'rtl';
  catalogHref: string;
}): Promise<string> {
  const { siteTitle, providers, error } = opts;
  const revisionQuery = assetRevisionQuery(opts.viewRevision);

  const body = await renderView(views, '/templates/login.json', {
    siteTitle,
    appIcon: opts.appIcon,
    error,
    isForbidden: error === 'forbidden',
    providers: providers.map((provider) => {
      const isPrimary = provider === 'eventuai';
      return {
        name: provider,
        href: `/auth/start?provider=${encodeURIComponent(provider)}`,
        label: providerLabel(provider),
        icon: providerIcon(provider, revisionQuery),
        buttonClass: isPrimary
          ? 'border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700'
          : 'border-gray-200 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50',
        iconClass: isPrimary ? 'text-white' : 'text-gray-600 group-hover:text-indigo-600',
      };
    }),
  });

  return layout(views, {
    title: 'Sign In',
    siteTitle,
    appIcon: opts.appIcon,
    appPrimaryColor: opts.appPrimaryColor,
    appFont: opts.appFont,
    body,
    viewRevision: opts.viewRevision,
    uiLocale: opts.uiLocale,
    uiDirection: opts.uiDirection,
    catalogHref: opts.catalogHref,
  });
}
