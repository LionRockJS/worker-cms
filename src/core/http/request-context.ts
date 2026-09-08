// ============================================================
// Per-request context carried via AsyncLocalStorage so deep
// call sites (template rendering) can read request-scoped
// values like the CSP nonce without threading parameters
// through every render function.
// ============================================================

import type { Permission } from '../../types';
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  cspNonce: string;
  rolePermissions?: Map<string, Set<Permission>>;
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
