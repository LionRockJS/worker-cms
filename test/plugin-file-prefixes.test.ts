import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approveFilePrefix,
  FilePrefixConflictError,
  findFilePrefixConflict,
  getFilePrefixApproval,
  listFilePrefixApprovals,
  revokeAllFilePrefixes,
  revokeFilePrefix,
} from '../src/features/plugins/file-prefixes';

const db = env.DB;

beforeEach(async () => {
  await db.prepare('DELETE FROM plugin_file_prefix_approvals').run();
});

afterEach(async () => {
  await db.prepare('DELETE FROM plugin_file_prefix_approvals').run();
});

describe('plugin file-prefix approvals', () => {
  it('approves, lists, and re-approves a declared namespace', async () => {
    await approveFilePrefix(db, 'plugin-a', 'plugin-a/', 'first@example.com');
    expect(await getFilePrefixApproval(db, 'plugin-a', 'plugin-a/')).toMatchObject({
      plugin_id: 'plugin-a',
      prefix: 'plugin-a/',
      approved_by: 'first@example.com',
    });

    await approveFilePrefix(db, 'plugin-a', 'plugin-a/', 'second@example.com');
    expect(await listFilePrefixApprovals(db, 'plugin-a')).toHaveLength(1);
    expect(await getFilePrefixApproval(db, 'plugin-a', 'plugin-a/')).toMatchObject({
      approved_by: 'second@example.com',
    });
  });

  it('rejects exact and nested overlaps owned by another plugin', async () => {
    await approveFilePrefix(db, 'plugin-a', 'themes/', 'admin@example.com');

    await expect(approveFilePrefix(db, 'plugin-b', 'themes/', 'admin@example.com'))
      .rejects.toBeInstanceOf(FilePrefixConflictError);
    await expect(approveFilePrefix(db, 'plugin-b', 'themes/assets/', 'admin@example.com'))
      .rejects.toBeInstanceOf(FilePrefixConflictError);
    await expect(approveFilePrefix(db, 'plugin-b', 'theme/', 'admin@example.com'))
      .resolves.toBeUndefined();

    expect(await findFilePrefixConflict(db, 'plugin-b', 'themes/assets/')).toMatchObject({
      plugin_id: 'plugin-a',
      prefix: 'themes/',
    });
  });

  it('revokes one prefix or all prefixes for a plugin', async () => {
    await approveFilePrefix(db, 'plugin-a', 'one/', 'admin@example.com');
    await approveFilePrefix(db, 'plugin-a', 'two/', 'admin@example.com');
    await revokeFilePrefix(db, 'plugin-a', 'one/');
    expect(await getFilePrefixApproval(db, 'plugin-a', 'one/')).toBeNull();
    expect(await listFilePrefixApprovals(db, 'plugin-a')).toHaveLength(1);

    await revokeAllFilePrefixes(db, 'plugin-a');
    expect(await listFilePrefixApprovals(db, 'plugin-a')).toEqual([]);
  });
});
