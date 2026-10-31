import type { AppContext } from '../../core/http/context';
import { contextActor, type AuditActor } from '../../core/db/audit';
import type { Env } from '../../types';
import { auditReads, auditUnavailable } from '../../core/http/access-log';
import { auditOutboundIntent } from '../../core/http/outbound-audit';

/** All authenticated plugin UI dispatches forward a user summary, including
 * client-view files and empty/new-page render contexts. */
export async function auditPluginDisclosure(
  c: AppContext, pluginId: string, operation: string, action: string,
): Promise<Response | null> {
  const actor = contextActor(c, pluginId);
  const detail = { destination: pluginId, operation, delivery_id: crypto.randomUUID(), phase: 'intent' };
  try {
    await auditReads(c, [{ action, kind: 'plugin', key: pluginId,
      targetType: 'plugin', ids: [pluginId], count: 1, actor, detail, eventClass: 'export',
    }, { action: 'user.plugin-disclosure', kind: 'table', key: 'users', targetType: 'users',
      ids: [c.get('user').sub], count: 1, actor, detail, eventClass: 'export',
    }], true);
    return null;
  } catch (error) {
    console.error('plugin disclosure audit unavailable', error);
    return auditUnavailable(c);
  }
}

/** No user summary is forwarded by management/enrollment. Record the actual
 * initiating actor and credential/configuration exchange without its values. */
export function auditPluginManagement(env: Env, pluginId: string, operation: string, actor: AuditActor,
  containment = false,
): Promise<boolean> {
  return auditOutboundIntent(env, { action: 'plugin.management-intent', destination: pluginId, operation,
    targetType: 'plugin_management', ids: [pluginId], actor, containment,
    reads: async () => {
      const row = await env.DB.prepare(`SELECT p.id FROM plugins p JOIN plugin_identity_approvals a ON a.plugin_row_id = p.id
        WHERE a.manifest_id = ?`).bind(pluginId).first<{ id: number }>();
      if (!row) throw new Error('Management source identity unavailable');
      return [{ action: 'plugin.management-disclosure', kind: 'plugin', key: pluginId, targetType: 'plugin', ids: [pluginId], count: 1 },
        { action: 'plugin.management-disclosure', kind: 'table', key: 'plugins', targetType: 'plugins', ids: [String(row.id)], count: 1 }];
    },
  });
}
