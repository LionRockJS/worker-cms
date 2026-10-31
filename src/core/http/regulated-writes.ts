import type { Env } from '../../types';

/** W4b is not implemented yet. Regulated admission permits protected reads,
 * never an operator flag that bypasses durable business/policy receipts. */
export function regulatedWritesBlocked(env: Pick<Env, 'REGULATED_MODE'>): boolean {
  return Boolean(env.REGULATED_MODE && env.REGULATED_MODE !== 'false');
}

export class RegulatedWritesUnavailableError extends Error {
  constructor() { super('Regulated writes require durable mutation evidence'); }
}

export function assertRegulatedWritesAllowed(env: Pick<Env, 'REGULATED_MODE'>): void {
  if (regulatedWritesBlocked(env)) throw new RegulatedWritesUnavailableError();
}

/** Exact host read/containment operations only. New mutation routes are denied
 * by default; query strings and caller headers cannot opt a write into reads. */
export function regulatedRequestWriteBlocked(env: Pick<Env, 'REGULATED_MODE'>, request: Request): boolean {
  if (!regulatedWritesBlocked(env)) return false;
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false;
  if (request.method !== 'POST') return true;
  const path = new URL(request.url).pathname;
  if (['/auth/callback', '/auth/refresh', '/auth/logout', '/admin/profile/locale', '/__cms/pages/list-batch', '/__cms/pages/search'].includes(path)) return false;
  return ![
    /^\/admin\/pages\/\d+\/unpublish$/,
    /^\/admin\/plugins-manage\/\d+\/disconnect$/,
    /^\/admin\/plugins-manage\/\d+\/(?:assets|files|page-types)\/revoke$/,
    /^\/admin\/profile\/identities\/\d+\/disconnect$/,
    /^\/admin\/audit\/outages\/[^/]+\/reconcile$/,
  ].some(pattern => pattern.test(path));
}
