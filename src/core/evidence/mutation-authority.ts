import type { AppContext } from '../http/context';
import { captureAccessAuthorization, type AccessAuthorization } from '../auth/access-authorization';
import { resolveDataClasses } from '../db/data-classes';

/** Fresh authority and data-class policy for one audited admin change. Throws
 *  into the caller's own "unavailable" path when either is missing. The
 *  regulated-writes check stays with the caller, because whether it runs
 *  inside or outside the caller's try decides how a refusal is reported. */
export async function captureMutationAuthority(c: AppContext, permission: Exclude<AccessAuthorization['capability'], 'authenticated'>) {
  const authority = await captureAccessAuthorization(c.env, c.get('user'), permission, c.get('configImport') && 'menu:manage');
  if (!authority.allowed) throw new Error('Mutation authority unavailable');
  const policy = await resolveDataClasses(c.env, true);
  if (!policy.ok) throw new Error('Mutation classification unavailable');
  return { authority, policy };
}
