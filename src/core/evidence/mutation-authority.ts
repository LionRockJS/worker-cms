import type { AppContext } from '../http/context';
import { captureAccessAuthorization, captureSelfAuthorization, type AccessAuthorization } from '../auth/access-authorization';

/** Fresh authority and data-class policy for one audited admin change. Throws
 *  into the caller's own "unavailable" path when either is missing. The
 *  regulated-writes check stays with the caller, because whether it runs
 *  inside or outside the caller's try decides how a refusal is reported. */
export async function captureMutationAuthority(c: AppContext, permission: Exclude<AccessAuthorization['capability'], 'authenticated'> | 'self',
  onDenied?: () => Promise<void>) {
  const authority = permission === 'self'
    ? await captureSelfAuthorization(c.env, c.get('user'))
    : await captureAccessAuthorization(c.env, c.get('user'), permission, c.get('configImport') && 'menu:manage');
  if (!authority.allowed) {
    await onDenied?.();
    throw new Error('Mutation authority unavailable');
  }
  // Same snapshot as the authority guard; both are rechecked at commit.
  const policy = authority.policy;
  if (permission !== 'self' && !policy.ok) throw new Error('Mutation classification unavailable');
  return { authority, policy };
}
