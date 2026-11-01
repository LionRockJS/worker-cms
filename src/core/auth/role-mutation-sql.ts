// Shared fixed SQL for the legacy comma-separated user-role representation.
// The user table is always aliased `u`; role values are supplied as parameters.
// json_quote keeps quotes/backslashes valid while json_each preserves token order.
const ROLE_TOKENS = `json_each('[' || replace(json_quote(u.role), ',', '","') || ']')`;

export const USER_HAS_ROLE_SQL = `EXISTS (SELECT 1 FROM ${ROLE_TOKENS} part WHERE trim(part.value) = ?)`;
export const USER_WITHOUT_ROLE_SQL = `COALESCE((SELECT NULLIF(group_concat(token, ','), '') FROM (
  SELECT trim(value) AS token FROM ${ROLE_TOKENS}
  WHERE trim(value) <> ? AND trim(value) <> '' ORDER BY CAST(key AS INTEGER)
)), 'viewer')`;

/** Audit details must not retain email-like, URL-like, control or unbounded
 * legacy role values. Refuse the change for governed cleanup instead. */
export function safeRoleAuditValue(value: string): boolean {
  return new TextEncoder().encode(value).length <= 2048
    && !value.includes('@') && !value.includes('://') && !/[\x00-\x1f\x7f]/.test(value);
}

const UNSAFE_CONTROL_SQL = [...Array.from({ length: 32 }, (_, index) => index), 127]
  .map(code => `instr(u.role, char(${code})) > 0`).join(' OR ');
export const UNSAFE_USER_ROLE_SQL = `(length(CAST(u.role AS BLOB)) > 2048 OR instr(u.role, '@') > 0
  OR instr(u.role, '://') > 0 OR ${UNSAFE_CONTROL_SQL})`;
