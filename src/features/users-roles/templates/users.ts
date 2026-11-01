import { adminLayout, type BaseTemplateProps } from '../../../core/render/layout';
import { renderView } from '../../../core/render/liquid';

export async function usersPage(views: Fetcher, opts: BaseTemplateProps & {
  users: Array<{
    id: number;
    name: string;
    email: string;
    identityProviders: Array<{ provider: string; label: string }>;
    roles: Array<{ label: string; labelKey: string }>;
    editHref: string;
    deleteAction: string;
    canDelete: boolean;
  }>;
  flash?: string;
  error?: string;
  /** Whether this viewer holds `pii:reveal`. Without it the names and email
   *  addresses arrive already masked and carry no reveal affordance. */
  canRevealPii?: boolean;
  /** Props for panels contributed by another feature (today, the shared
   *  credit pool). Passed through untouched; the section renders a panel only
   *  when its owner supplied the props. */
  panels?: Record<string, unknown>;
}): Promise<string> {
  const { users } = opts;
  const body = await renderView(views, '/templates/users.json', {
    flash: opts.flash ?? '',
    error: opts.error ?? '',
    hasFlash: !!opts.flash,
    hasError: !!opts.error,
    hasUsers: users.length > 0,
    canRevealPii: !!opts.canRevealPii,
    users,
    ...opts.panels,
  });
  return adminLayout(views, opts, { title: 'Users', body });
}

export async function userFormPage(views: Fetcher, opts: BaseTemplateProps & {
  id: number;
  name: string;
  email: string;
  error?: string;
  flash?: string;
  roleOptions: Array<{ value: string; label: string; labelKey: string; checked: boolean }>;
  /** As usersPage.panels — today, this user's credit balance and ledger. */
  panels?: Record<string, unknown>;
}): Promise<string> {
  const { id, name, email, error, flash, roleOptions } = opts;
  const body = await renderView(views, '/templates/user-form.json', {
    action: `/admin/users/${id}`,
    name,
    email,
    error: error ?? '',
    hasError: !!error,
    flash: flash ?? '',
    hasFlash: !!flash,
    roleOptions,
    ...opts.panels,
  });
  return adminLayout(views, opts, { title: `Edit ${name || email}`, body });
}
