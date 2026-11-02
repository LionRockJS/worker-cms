import type { Env } from '../../types';
import type { AppContext } from '../../core/http/context';
import { classFor, resolveDataClasses } from '../../core/db/data-classes';
import { contextActor } from '../../core/db/audit';
import { recordAuditOutage } from '../../core/db/audit-outages';
import { captureAccessAuthorization, type AccessAuthorization } from '../../core/auth/access-authorization';
import { recordPolicyDenial } from '../../core/auth/denials';

/** Fresh authority for both the route's decision and the mutation batch. */
export async function authorizeAccessMutation(c: AppContext, permission: 'users:manage' | 'roles:manage'):
Promise<{ authorization: AccessAuthorization; refused?: undefined } | { authorization?: undefined; refused: Response }> {
  let authorization: AccessAuthorization;
  try { authorization = await captureAccessAuthorization(c.env, c.get('user'), permission); }
  catch { return { refused: await accessMutationUnavailable(c) }; }
  if (!authorization.allowed) {
    await recordPolicyDenial(c, 'management_permission_changed');
    return { refused: c.text('Forbidden: access management permission changed', 403) };
  }
  return { authorization };
}

/** The highest classification of the tables whose policy/identifiers change.
 * Null means policy could not be resolved; 'none' is a valid ordinary install. */
export async function accessMutationClass(env: Env, tables: readonly string[]): Promise<'none' | 'pii' | 'phi' | null> {
  const policy = await resolveDataClasses(env, true);
  if (!policy.ok) return null;
  const classes = tables.map(table => classFor(policy, 'table', table));
  return classes.includes('phi') ? 'phi' : classes.includes('pii') ? 'pii' : 'none';
}

/** The failed statement and commit outcome can be unknown after a transport
 * failure. Report only an incomplete coarse health incident, never success. */
export async function accessMutationUnavailable(c: AppContext): Promise<Response> {
  console.error('access policy transaction failed');
  await recordAuditOutage(c.env, 'health', [], contextActor(c), undefined, { captureIncomplete: true });
  return c.json({ error: 'Access policy change unavailable' }, 503, { 'Cache-Control': 'no-store' });
}

/** Invalid/oversized legacy policy metadata requires review before recording. */
export function unsafeAccessEvidence(c: AppContext): Response {
  return c.json({ error: 'Access policy evidence requires review' }, 409, { 'Cache-Control': 'no-store' });
}
