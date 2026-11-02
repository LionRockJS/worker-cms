import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { readRolePermissionSnapshot, saveRolePermissions } from '../src/core/auth/role-store';
import { auditEvidence } from '../src/core/db/audit';
import { captureAccessAuthorization } from '../src/core/auth/access-authorization';
import { verifyJWT } from '../src/core/auth/jwt';
import { signJWT } from './auth-fixtures';

describe('role permission persistence', () => {
  it('preserves namespaced plugin permissions containing hyphens', async () => {
    const token = await signJWT({ sub: '91001', email: 'role-operator@example.invalid', name: 'Role operator', role: 'admin', type: 'access', exp: Math.floor(Date.now() / 1000) + 900 }, env.JWT_SECRET);
    const actor = await verifyJWT(token, env.JWT_SECRET);
    if (!actor) throw new Error('Fixture actor unavailable');
    const authorization = await captureAccessAuthorization(env, actor, 'roles:manage');
    const audit = auditEvidence(env, { action: 'role.update', eventClass: 'admin', dataClass: 'none', retentionClass: 'admin_config',
      outcome: 'success', targetType: 'role', targetId: 'viewer', targetIds: null, targetCount: 1,
      containerKey: null, queryFingerprint: null, detail: null }, { userId: actor.sub, roles: actor.role, sessionSid: actor.sid ?? null, via: null });
    const before = await readRolePermissionSnapshot(env, 'viewer');
    await saveRolePermissions(env, 'viewer', 'Viewer', [
      'tcm-ville:play',
      'theme-editor:write-content',
    ], before, audit, authorization);

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
