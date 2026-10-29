import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { availableFeatures, baselinePaths, buildCms, readManifest } from './tools/build-migrations.mjs';
import { assembleViews, availableViewFeatures } from './tools/build-views.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// The migration assembler runs in Node, but the assembly tests run inside
// workerd where there is no filesystem — so the SQL it produces is handed over
// as bindings. TEST_ASSEMBLED_* let the tests check the committed baseline
// against a fresh assembly, and check that a lean profile really does drop
// the disabled features' objects.
const leanProfile = Object.fromEntries(availableFeatures().map((id) => [id, false]));

// The view assembler is the same story: it runs in Node, so the assembled file
// lists cross into workerd as bindings. A lean profile must leave no
// feature-owned section, template or locale key behind.
const viewLeanProfile = Object.fromEntries(availableViewFeatures().map((id) => [id, false]));
const viewPaths = (features: Record<string, boolean>) => [...assembleViews(features).keys()].join(',');
const assembledLocale = (features: Record<string, boolean>) =>
  new TextDecoder().decode(assembleViews(features).get('locales/en.json'));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // AUDIT_BUCKET is commented out in wrangler.toml, because the bucket
        // has to be created per deployment and the sweep is inert without it.
        // The tests still have to exercise the enabled path, so the harness
        // provides it; the disabled path is covered by passing it as undefined.
        r2Buckets: ['AUDIT_BUCKET'],
        bindings: {
          JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
          ENABLED_PROVIDERS: 'eventuai,github,google,microsoft,apple',
          EVENTUAI_CLIENT_ID: 'test-eventuai-client',
          EVENTUAI_CLIENT_SECRET: 'test-eventuai-secret',
          GITHUB_CLIENT_ID: 'test-github-client',
          GITHUB_CLIENT_SECRET: 'test-github-secret',
          GOOGLE_CLIENT_ID: 'test-google-client',
          GOOGLE_CLIENT_SECRET: 'test-google-secret',
          MICROSOFT_CLIENT_ID: 'test-microsoft-client',
          MICROSOFT_CLIENT_SECRET: 'test-microsoft-secret',
          APPLE_CLIENT_ID: 'test.apple.client',
          APPLE_CLIENT_SECRET: 'test-apple-secret',
          OAUTH_REDIRECT_URI: 'https://cms.example.com/auth/callback',
          CANONICAL_ORIGIN: 'https://cms.example.com',
          SITE_TITLE: '0xCMS',
          TEST_MIGRATIONS: await readD1Migrations(path.join(rootDir, 'migrations')),
          TEST_PUBLISHED_MIGRATIONS: await readD1Migrations(path.join(rootDir, 'migrations/published')),
          TEST_COMMITTED_BASELINE: readFileSync(baselinePaths.cms, 'utf8'),
          TEST_ASSEMBLED_BASELINE: buildCms(readManifest()),
          TEST_ASSEMBLED_LEAN_BASELINE: buildCms(leanProfile),
          TEST_AVAILABLE_FEATURES: availableFeatures().join(','),
          TEST_AVAILABLE_VIEW_FEATURES: availableViewFeatures().join(','),
          TEST_ASSEMBLED_VIEW_PATHS: viewPaths(readManifest()),
          TEST_ASSEMBLED_LEAN_VIEW_PATHS: viewPaths(viewLeanProfile),
          TEST_ASSEMBLED_VIEW_LOCALE: assembledLocale(readManifest()),
          TEST_ASSEMBLED_LEAN_VIEW_LOCALE: assembledLocale(viewLeanProfile),
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
