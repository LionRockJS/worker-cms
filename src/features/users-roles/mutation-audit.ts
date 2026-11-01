import type { Env } from '../../types';
import type { AppContext } from '../../core/http/context';
import { classFor, resolveDataClasses } from '../../core/db/data-classes';
import { contextActor } from '../../core/db/audit';
import { recordAuditOutage } from '../../core/db/audit-outages';

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
