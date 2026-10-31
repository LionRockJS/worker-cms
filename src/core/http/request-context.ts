// ============================================================
// Per-request context carried via AsyncLocalStorage so deep
// call sites (template rendering) can read request-scoped
// values like the CSP nonce without threading parameters
// through every render function.
// ============================================================

import type { Permission } from '../../types';
import type { DataClassMap } from '../db/data-classes';
import type { PendingRead } from './access-log';
import type { AuditActor } from '../db/audit';
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  cspNonce: string;
  rolePermissions?: Map<string, Set<Permission>>;
  /** Container classifications, resolved once per request. */
  dataClasses?: DataClassMap;
  /** Reads this request performed, drained and written once by the access-log
   *  middleware. Buffered rather than written at the call site so a list view
   *  costs one row instead of one per result. */
  pendingReads?: PendingRead[];
  /** Set only after contributor authentication; delegated user remains an assertion. */
  readActor?: AuditActor;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
}

/** The CSP nonce for the current request ('' outside a request context). */
export function currentCspNonce(): string {
  return requestContext.getStore()?.cspNonce ?? '';
}
