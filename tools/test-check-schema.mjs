// The schema check's pieces that need no Cloudflare account: reading the
// database names from a config, comparing a schema with the baseline, and
// passing deploy's config option through to the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { checkSchema, d1Databases } from './check-schema.mjs';
import { configArgs } from './deploy.mjs';

const baseline = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
  .map((name) => readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8')).join('\n');

test('reads DB and PUBLISHED_DB from uncommented d1_databases blocks only', () => {
  const config = readFileSync(new URL('../wrangler.example.toml', import.meta.url), 'utf8');
  assert.deepEqual(d1Databases(config), [
    { binding: 'DB', name: 'cms', kind: 'private' },
    { binding: 'PUBLISHED_DB', name: 'cms-published', kind: 'published' },
  ]);
  assert.deepEqual(d1Databases('# [[d1_databases]]\n# binding = "PUBLISHED_DB"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "site"\n[vars]\nX = "1"\n'),
    [{ binding: 'DB', name: 'site', kind: 'private' }]);
});

test('a database built from the baseline matches; a missing column fails and an extra table does not', () => {
  const fresh = baseline('migrations');
  assert.deepEqual(checkSchema('private', fresh).problems, []);
  assert.deepEqual(checkSchema('published', baseline('migrations/published')).problems, []);

  const stale = fresh.replace("    ip_allowlist TEXT NOT NULL DEFAULT '[]',", '') + '\nCREATE TABLE live_pages (id INTEGER);';
  assert.notEqual(stale, fresh);
  const result = checkSchema('private', stale);
  assert.deepEqual(result.problems, ['column roles.ip_allowlist is missing in the database']);
  assert.deepEqual(result.extra, ['table live_pages exists only in the database']);
});

test('deploy hands its wrangler config to the schema check', () => {
  assert.deepEqual(configArgs(['-c', 'wrangler.production.toml', '--dry-run']), ['-c', 'wrangler.production.toml']);
  assert.deepEqual(configArgs(['--config=wrangler.eventuai.toml']), ['-c', 'wrangler.eventuai.toml']);
  assert.deepEqual(configArgs(['--dry-run']), []);
});
