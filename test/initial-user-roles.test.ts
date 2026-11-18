import { expect, it } from 'vitest';
import { initialUserRoles } from '../src/core/auth/initial-user-roles';

const identity = { provider: 'google', providerUserId: 'StableSubject', email: 'person@example.com', emailVerified: true };
const rule = { provider: 'google', email: identity.email, roles: ['editor'] };

it.each([undefined, '', '  ', '[]'])('defaults to viewer for an empty allowlist (%s)', config => {
  expect(initialUserRoles(config, identity)).toBe('viewer');
});

it('merges matching grants, normalizes roles and deduplicates them', () => {
  expect(initialUserRoles(JSON.stringify([
    { ...rule, email: ' Person@Example.COM ', roles: [' Editor ', 'moderator', 'editor'] },
    { provider: 'google', providerUserId: identity.providerUserId, roles: ['initial-reviewer', 'editor'] },
  ]), identity)).toBe('editor,moderator,initial-reviewer');
});

it.each([
  { ...rule, provider: 'eventuai' },
  { ...rule, email: 'another@example.com' },
  { provider: 'google', providerUserId: 'stablesubject', roles: ['admin'] },
])('requires exact provider and identity matches (%j)', entry => {
  expect(initialUserRoles(JSON.stringify([entry]), identity)).toBe('viewer');
});

it.each([false, undefined])('requires affirmative email verification (%s)', emailVerified => {
  expect(initialUserRoles(JSON.stringify([rule]), { ...identity, emailVerified })).toBe('viewer');
  expect(initialUserRoles(JSON.stringify([{ provider: 'google', providerUserId: identity.providerUserId, roles: ['admin'] }]),
    { ...identity, emailVerified })).toBe('admin');
});

it.each([
  null, {}, [null], [false], [[]], [{ ...rule, provider: 'unknown' }],
  [{ ...rule, providerUserId: identity.providerUserId }], [{ provider: 'google', roles: ['admin'] }],
  [{ ...rule, email: '' }], [{ ...rule, email: '*@example.com' }], [{ ...rule, email: 'not-an-email' }],
  [{ provider: 'google', providerUserId: 123, roles: ['admin'] }],
  [{ provider: 'google', providerUserId: ' ', roles: ['admin'] }],
  [{ provider: 'google', providerUserId: ' subject ', roles: ['admin'] }],
  [{ ...rule, roles: 'admin' }], [{ ...rule, roles: [] }], [{ ...rule, roles: [123] }],
  [{ ...rule, roles: ['admin,editor'] }], [{ ...rule, roles: ['person@example.com'] }],
  [{ ...rule, roles: [''] }], [{ ...rule, roles: ['x'.repeat(2049)] }],
  [{ ...rule, typo: true }],
  [rule, { ...rule, roles: [] }],
])('rejects invalid configuration without exposing identities (%j)', config => {
  expect(() => initialUserRoles(JSON.stringify(config), identity)).toThrow('Invalid INITIAL_USER_ROLES configuration');
});
