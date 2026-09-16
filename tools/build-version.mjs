// ============================================================
// Build revision generator.
//
// Workers Builds exposes the commit being deployed as
// WORKERS_CI_COMMIT_SHA. Keep a short, public-safe form of that hash in the
// Worker bundle so the pre-login page can identify the source revision without
// depending on a runtime environment binding.
//
// Local builds fall back to the checked-out Git commit, then to `dev` when Git
// metadata is unavailable.
// ============================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIfChanged } from './write-if-changed.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const outputFile = path.join(rootDir, 'src', 'generated', 'build-info.ts');

function checkedOutCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const commit = process.env.WORKERS_CI_COMMIT_SHA?.trim() || checkedOutCommit();
const buildVersion = /^[0-9a-f]{7,64}$/i.test(commit) ? commit.slice(0, 7).toLowerCase() : 'dev';
const output = `// GENERATED FILE — do not edit.\n// Written by tools/build-version.mjs from the deployment commit.\nexport const BUILD_VERSION = ${JSON.stringify(buildVersion)};\n`;

if (existsSync(outputFile) && readFileSync(outputFile, 'utf8') === output) process.exit(0);
writeIfChanged(outputFile, output);
console.log(`wrote ${path.relative(rootDir, outputFile)} (${buildVersion})`);
