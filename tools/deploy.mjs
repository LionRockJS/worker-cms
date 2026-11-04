// ============================================================
// Gated deployment (W14, A.8.32, A.8.29).
//
// `npm run deploy` used to build and upload whatever was on disk. This deploys
// only a committed, pushed revision that passes the same checks as CI, and
// tags the Worker version with that commit so the deployed revision can be
// read back (`wrangler versions list`) and rolled back to by id.
//
// Usage: npm run deploy -- [wrangler deploy options, e.g. -c wrangler.production.toml]
//        npm run deploy -- --dry-run      (all gates, then wrangler's own dry run)
//
// There is no flag to skip a gate. A deployment that has to bypass it runs
// `npx wrangler deploy` directly, and is recorded as an exception (W14 record).
// Files marked skip-worktree, such as a site's real wrangler.toml, are not seen
// by `git status`: the configuration deployed is whatever is on disk.
// ============================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const passthrough = process.argv.slice(2);

const git = (...args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function run(command, args) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: rootDir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed; nothing was deployed`);
}

/** Every reason this checkout is not a releasable revision. */
export function releaseRefusals(status, upstream, pushed) {
  const refusals = [];
  if (status) refusals.push('the working tree has uncommitted changes, so the deployed code would match no commit');
  if (!upstream) refusals.push('the branch has no upstream, so CI and review cannot have seen this commit');
  else if (!pushed) refusals.push(`HEAD is not on ${upstream}; push it so CI runs on what is deployed`);
  return refusals;
}

function main() {
  const status = git('status', '--porcelain');
  let upstream = null;
  try { upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'); } catch { /* No upstream. */ }
  let pushed = false;
  if (upstream) {
    try { git('merge-base', '--is-ancestor', 'HEAD', upstream); pushed = true; } catch { /* Not an ancestor. */ }
  }
  const refusals = releaseRefusals(status, upstream, pushed);
  if (refusals.length) throw new Error(`Refusing to deploy:\n  - ${refusals.join('\n  - ')}`);

  const commit = git('rev-parse', '--short=12', 'HEAD');
  const subject = git('log', '-1', '--format=%s').slice(0, 100);
  console.log(`Releasing ${commit} (${subject}) from ${upstream}`);

  // npm test runs the build (pretest), then the profile, boundary, generated,
  // inventory and requirements checks, then the whole suite. The build stamps
  // src/generated/build-info.ts with this commit; that is the one file it may change.
  run('npm', ['run', 'type-check']);
  run('npm', ['test']);

  run('npx', ['wrangler', 'deploy', '--tag', commit, '--message', `${commit} ${subject}`, ...passthrough]);
  console.log(`\nDeployed ${commit}. Record it with the approval for this release; roll back with \`npx wrangler rollback <version-id>\`.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(`\n${error.message}`); process.exitCode = 1; }
}
