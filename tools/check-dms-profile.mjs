import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(path.join(tmpdir(), 'cms-dms-profile-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  // Build from source in isolation. Keep the active profile and local
  // Wrangler config, secrets, database state, and generated files untouched.
  for (const entry of [
    'assets-source', 'dictionary', 'docs', 'migrations', 'src', 'test', 'tools',
    'cms.features.json', 'package.json', 'tsconfig.json', 'vitest.config.mts',
  ]) {
    cpSync(path.join(root, entry), path.join(fixture, entry), { recursive: true });
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'junction');

  const manifestPath = path.join(fixture, 'cms.features.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const id of ['plugins', 'search', 'jobs', 'trash']) assert.equal(manifest.features[id], true, id);
  manifest.features.publish = false;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const config = readFileSync(path.join(root, 'wrangler.example.toml'), 'utf8').replace(
    /\[\[d1_databases\]\]\nbinding = "PUBLISHED_DB"\n[^]*?(?=\n\n)/,
    '',
  );
  assert.doesNotMatch(config, /^\s*binding\s*=\s*"(?:PUBLISHED_DB|PUBLISH_BUCKET)"\s*$/m);
  writeFileSync(path.join(fixture, 'wrangler.toml'), config);
  rmSync(path.join(fixture, 'migrations/published'), { recursive: true, force: true });

  const run = (args, env = process.env) => execFileSync(npm, args, { cwd: fixture, stdio: 'inherit', env });
  run(['run', 'build']);
  run(['run', 'type-check']);
  run(['run', 'check:boundaries']);
  run(['run', 'check:generated']);
  run(['run', 'db:migrate']);
  assert.equal(existsSync(path.join(fixture, 'migrations/published')), false);

  const worker = await build({
    absWorkingDir: fixture,
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['cloudflare:*'],
    metafile: true,
    write: false,
  });
  for (const input of Object.keys(worker.metafile.inputs)) {
    assert.doesNotMatch(input, /(?:features\/publish\/|plugins\/routes\/publish-api\.ts$)/);
  }
  console.log('DMS bundle excludes the publish implementation and plugin publish API.');
  run(['exec', '--', 'vitest', 'run'], {
    ...process.env,
    CMS_TEST_PROFILE: 'dms',
    CMS_TEST_WRANGLER_CONFIG: './wrangler.toml',
  });

  // A dropped feature has neither source files nor a manifest entry. Keep
  // plugins enabled to catch even type-only imports of the optional provider.
  delete manifest.features.publish;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  rmSync(path.join(fixture, 'src/features/publish'), { recursive: true });
  run(['run', 'build:features']);
  run(['run', 'type-check']);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
