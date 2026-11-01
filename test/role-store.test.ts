import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { readRolePermissionSnapshot, saveRolePermissions } from '../src/core/auth/role-store';
import { auditEvidence } from '../src/core/db/audit';

describe('role permission persistence', () => {
  it('preserves namespaced plugin permissions containing hyphens', async () => {
    const audit = auditEvidence(env, { action: 'role.update', eventClass: 'admin', dataClass: 'none', retentionClass: 'admin_config',
      outcome: 'success', targetType: 'role', targetId: 'viewer', targetIds: null, targetCount: 1,
      containerKey: null, queryFingerprint: null, detail: null }, { userId: null, roles: null, sessionSid: null, via: null });
    const before = await readRolePermissionSnapshot(env, 'viewer');
    await saveRolePermissions(env, 'viewer', 'Viewer', [
      'tcm-ville:play',
      'theme-editor:write-content',
    ], before, audit);

    const grants = await env.DB.prepare(
      'SELECT permission FROM role_permissions WHERE role = ? ORDER BY permission',
    )
      .bind('viewer')
      .all<{ permission: string }>();

    expect(grants.results.map(({ permission }) => permission)).toEqual([
      'tcm-ville:play',
      'theme-editor:write-content',
    ]);
  });
});
