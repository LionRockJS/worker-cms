// Write package.json + package-lock.json for the image's runtime stage.
//
// The runtime needs only wrangler (server.mjs runs the bundle through it, and it
// brings miniflare and workerd), but wrangler is a dev dependency, so
// `npm ci --omit=dev` would leave it out. This copies wrangler and everything it
// depends on out of the repo's package-lock.json, keeping the exact versions and
// integrity hashes the project builds and tests with, so the runtime stage can
// `npm ci` without a second lockfile to maintain.
//
//   node docker/runtime-lock.mjs <out-dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['wrangler'];
const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node docker/runtime-lock.mjs <out-dir>');

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const packages = lock.packages;

// npm's lookup: <from>/node_modules/<name>, then each ancestor's node_modules.
function resolve(from, name) {
  for (let dir = from; ; ) {
    const path = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (packages[path]) return path;
    if (!dir) return null;
    const parent = dir.lastIndexOf('/node_modules/');
    dir = parent === -1 ? '' : dir.slice(0, parent);
  }
}

const keep = new Set();
const queue = ROOTS.map((name) => resolve('', name));
while (queue.length) {
  const path = queue.pop();
  if (keep.has(path)) continue;
  keep.add(path);
  const entry = packages[path];
  const required = Object.keys(entry.peerDependencies ?? {})
    .filter((name) => !entry.peerDependenciesMeta?.[name]?.optional);
  for (const name of [...Object.keys(entry.dependencies ?? {}), ...required]) {
    const found = resolve(path, name);
    if (!found) throw new Error(`${path} depends on ${name}, which is not in package-lock.json`);
    queue.push(found);
  }
  // Platform builds (workerd, esbuild, sharp): npm ci installs the one that matches.
  for (const name of Object.keys(entry.optionalDependencies ?? {})) {
    const found = resolve(path, name);
    if (found) queue.push(found);
  }
}

const dependencies = Object.fromEntries(
  ROOTS.map((name) => [name, packages[`node_modules/${name}`].version]),
);
const out = {
  name: 'cms-runtime',
  lockfileVersion: lock.lockfileVersion,
  requires: true,
  packages: { '': { name: 'cms-runtime', dependencies } },
};
for (const path of [...keep].sort()) {
  // These flags described the package's place in the repo's tree, not this one.
  const { dev, devOptional, peer, ...entry } = packages[path];
  if (devOptional) entry.optional = true;
  out.packages[path] = entry;
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ name: 'cms-runtime', private: true, dependencies }, null, 2)}\n`);
writeFileSync(join(outDir, 'package-lock.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`runtime lockfile: ${keep.size} packages for ${ROOTS.join(', ')}`);
