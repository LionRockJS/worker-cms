/** Host-owned reason vocabulary. Provider errors and credential contents must
 * never become evidence values or dynamically expand the delivery contract. */
export const AUTH_DENIAL_REASONS = {
  'auth.start': ['link_session_expired', 'rate_limited', 'unknown'],
  'auth.login': ['provider_error', 'missing_params', 'missing_state', 'invalid_state', 'state_mismatch',
    'unsupported_provider', 'provider_not_configured', 'token_exchange_failed', 'no_id_token', 'invalid_id_token',
    'no_access_token', 'userinfo_not_configured', 'userinfo_failed', 'invalid_userinfo', 'link_session_mismatch',
    'identity_already_linked', 'email_not_allowed', 'identity_not_linked', 'db_error', 'rate_limited', 'unknown'],
  'auth.refresh': ['no_refresh_token', 'invalid_refresh_token', 'session_revoked', 'user_not_found', 'rate_limited', 'unknown'],
  'auth.access': ['missing_credentials', 'invalid_credentials', 'unknown'],
} as const;
export type AuthDenialAction = keyof typeof AUTH_DENIAL_REASONS | 'permission.denied';
export const PERMISSION_DENIAL_REASONS = [
  'plugin_identity_claimed', 'plugin_identity_required', 'plugin_file_prefix_conflict',
  'locale_protected', 'locale_default_required', 'locale_ui_required', 'locale_fallback_invalid',
  'editor_required', 'target_role_exceeds_authority', 'requested_role_exceeds_authority',
  'grant_exceeds_authority', 'locked_role', 'builtin_role', 'self_deletion', 'last_administrator', 'management_permission_changed', 'unknown'] as const;
export type PermissionDenialReason = typeof PERMISSION_DENIAL_REASONS[number];
export const permissionDenialReason = (value: string) => (PERMISSION_DENIAL_REASONS as readonly string[]).includes(value) ? value : 'unknown';

export function denialReason(action: Exclude<AuthDenialAction, 'permission.denied'>, value: string): string {
  return (AUTH_DENIAL_REASONS[action] as readonly string[]).includes(value) ? value : 'unknown';
}

export const denialPermission = (value: string) => value.length <= 256 && /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/.test(value);
export const denialRoute = (value: string) => value.length <= 256 && /^\/[A-Za-z0-9_/*:.-]*$/.test(value);
const permissionSet = (value: string) => value === 'unrecordable' || (value.length <= 8192 && value.split(',').length <= 32
  && value.split(',').every(denialPermission));

/** Validate persisted receipts before delivery; unknown fields stay pending. */
export function validDenialDetail(action: string, detail: Record<string, unknown>): boolean {
  const optional = ['classification_unavailable', 'roles_unavailable'];
  if (optional.some(key => Object.hasOwn(detail, key) && detail[key] !== true)) return false;
  let required: string[];
  if (action === 'permission.denied') {
    if (typeof detail.path !== 'string' || !denialRoute(detail.path)) return false;
    if (typeof detail.permission === 'string' && (detail.permission === 'unrecordable' || denialPermission(detail.permission))) required = ['permission', 'path'];
    else if (typeof detail.permissions === 'string' && permissionSet(detail.permissions)) required = ['permissions', 'path'];
    else if (typeof detail.reason === 'string' && permissionDenialReason(detail.reason) === detail.reason) required = ['reason', 'path'];
    else return false;
  } else {
    if (!Object.hasOwn(AUTH_DENIAL_REASONS, action) || typeof detail.reason !== 'string'
      || denialReason(action as Exclude<AuthDenialAction, 'permission.denied'>, detail.reason) !== detail.reason) return false;
    required = ['reason'];
  }
  return required.every(key => Object.hasOwn(detail, key)) && Object.keys(detail).every(key => required.includes(key) || optional.includes(key));
}
