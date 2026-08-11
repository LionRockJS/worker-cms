import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { saveRolePermissions } from '../src/core/auth/role-store';

describe('role permission persistence', () => {
  it('preserves namespaced plugin permissions containing hyphens', async () => {
    await saveRolePermissions(env, 'viewer', 'Viewer', [
      'tcm-ville:play',
      'theme-editor:write-content',
    ]);

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
