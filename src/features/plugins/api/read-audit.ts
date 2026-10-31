import type { AppContext } from '../../../core/http/context';
import type { AuditActor } from '../../../core/db/audit';
import { actingUserId } from './create';

/** The user is asserted by the authenticated contributor, not independently authenticated. */
export function pluginReadActor(c: AppContext, pluginId: string): AuditActor {
  const userId = actingUserId(c);
  return { userId: userId === null ? null : String(userId), roles: null, sessionSid: null, via: pluginId };
}
