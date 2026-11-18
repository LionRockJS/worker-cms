// ============================================================
// Feature registry generator.
//
// cms.features.json is the single switch per feature. This script turns it
// into the code registries, so enabling or dropping a feature is one JSON
// edit instead of three files kept in step by hand:
//
//   src/generated/manifests.ts   the CmsFeature list (read by the chrome)
//   src/generated/routers.ts     the routers (read by the route tables)
//   src/generated/services.ts    runtime service adapters
//
// They live outside src/features because they are build output, not a feature:
// a directory there is a slice that cms.features.json can switch off.
//
// They stay separate on purpose. Routers and runtime services import their
// implementations and may reach back into the chrome, so a single registry
// would drag all of that into the chrome's import graph and make it cyclic —
// see tools/check-boundaries.mjs rules 6 and 7.
//
// Discovery is by convention, so a new slice needs no wiring here:
//   src/features/<id>/feature.ts          exports one `const <name>: CmsFeature`
//   src/features/<id>/routes.ts           exports `const <name>Routes`
//   src/features/<id>/routes/<file>.ts    likewise; `public.ts` mounts at the
//                                         worker root instead of under /admin
//   src/features/<id>/services.ts         exports one FeatureServiceEntry
//
// A feature listed in cms.features.json with no src/features/<id>/ directory
// is schema-only (plugins, jobs) and simply contributes nothing here.
//
// Usage:
//   node scripts/build-features.mjs           # write the registries
//   node scripts/build-features.mjs --check   # exit 1 if they are stale
// ============================================================

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIfChanged } from './write-if-changed.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const featuresDir = path.join(rootDir, 'src', 'features');
const outDir = path.join(rootDir, 'src', 'generated');
const MANIFESTS = path.join(outDir, 'manifests.ts');
const ROUTERS = path.join(outDir, 'routers.ts');
const SERVICES = path.join(outDir, 'services.ts');

function enabledFeatures() {
  const raw = JSON.parse(readFileSync(path.join(rootDir, 'cms.features.json'), 'utf8'));
  return Object.entries(raw.features ?? {})
    .filter(([, on]) => on === true)
    .map(([id]) => id)
    .sort();
}

/** The single `CmsFeature` a slice's feature.ts exports. */
function manifestExport(id) {
  const file = path.join(featuresDir, id, 'feature.ts');
  if (!existsSync(file)) return null;
  const names = [...readFileSync(file, 'utf8').matchAll(/^export const (\w+)\s*:\s*CmsFeature\b/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`src/features/${id}/feature.ts exports no CmsFeature`);
  if (names.length > 1) throw new Error(`src/features/${id}/feature.ts exports ${names.length} CmsFeature values; expected one`);
  return names[0];
}

/** The optional FeatureServiceEntry a slice's services.ts exports. */
function serviceExport(id) {
  const file = path.join(featuresDir, id, 'services.ts');
  if (!existsSync(file)) return null;
  const names = [...readFileSync(file, 'utf8').matchAll(/^export const (\w+)\s*:\s*FeatureServiceEntry\b/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`src/features/${id}/services.ts exports no FeatureServiceEntry`);
  if (names.length > 1) throw new Error(`src/features/${id}/services.ts exports ${names.length} FeatureServiceEntry values; expected one`);
  return names[0];
}

/** Every `*Routes` a slice exports, as { specifier, names, isPublic }. */
function routerExports(id, installed) {
  const dir = path.join(featuresDir, id);
  const candidates = [];
  const single = path.join(dir, 'routes.ts');
  if (existsSync(single)) candidates.push([`../features/${id}/routes`, single, false]);
  const routesDir = path.join(dir, 'routes');
  if (existsSync(routesDir)) {
    for (const name of readdirSync(routesDir).filter((n) => n.endsWith('.ts')).sort()) {
      const base = name.slice(0, -3);
      candidates.push([`../features/${id}/routes/${base}`, path.join(routesDir, name), base === 'public']);
    }
  }
  const out = [];
  for (const [specifier, file, isPublic] of candidates) {
    const source = readFileSync(file, 'utf8');
    // An integration router can require a second optional feature without
    // making its owning feature require that feature.
    const requires = /^export const requiresFeature = '([^']+)'/m.exec(source)?.[1];
    if (requires && !installed.has(requires)) continue;
    const names = [...source.matchAll(/^export (?:const |\{[^}]*\bas\s+)(\w*Routes)\b/gm)].map((m) => m[1]).sort();
    // A routes file may declare its own mount prefix (e.g. /__cms); doing so
    // also takes it out of the admin stack.
    const base = /^export const basePath = '([^']+)'/m.exec(source)?.[1];
    if (names.length) out.push({ specifier, names, isPublic: isPublic || Boolean(base), basePath: base });
  }
  return out;
}

const BANNER = [
  '// GENERATED FILE — do not edit.',
  '//',
  '// Written by tools/build-features.mjs from cms.features.json.',
  '// To add or drop a feature, edit that file and run `npm run build:features`.',
  '',
].join('\n');

function buildManifests(ids) {
  const entries = ids.map((id) => [id, manifestExport(id)]).filter(([, name]) => name);
  const imports = entries.map(([id, name]) => `import { ${name} } from '../features/${id}/feature';`);
  return `${BANNER}
import type { CmsFeature } from '../core/feature';
${imports.join('\n')}

/** Installed features, in cms.features.json order. */
export const featureManifests: readonly CmsFeature[] = [
${entries.map(([, name]) => `  ${name},`).join('\n')}
];
`;
}

function buildRouters(ids) {
  const imports = [];
  const admin = [];
  const publics = [];
  const installed = new Set(ids);
  for (const id of ids) {
    for (const { specifier, names, isPublic, basePath } of routerExports(id, installed)) {
      imports.push(`import { ${names.join(', ')} } from '${specifier}';`);
      const suffix = basePath ? `, basePath: '${basePath}'` : '';
      for (const name of names) {
        (isPublic ? publics : admin).push(`  { id: '${id}', router: ${name}${suffix} },`);
      }
    }
  }
  return `${BANNER}
import type { FeatureRouterEntry } from '../features/routers';
${imports.join('\n')}

/** Mounted under /admin, in registry order. */
export const adminRouterEntries: readonly FeatureRouterEntry[] = [
${admin.join('\n')}
];

/** Mounted at the worker root, outside the auth stack. */
export const publicRouterEntries: readonly FeatureRouterEntry[] = [
${publics.join('\n')}
];
`;
}

function buildServices(ids) {
  const entries = ids.map((id) => [id, serviceExport(id)]).filter(([, name]) => name);
  const imports = entries.map(([id, name]) => `import { ${name} } from '../features/${id}/services';`);
  return `${BANNER}
import type { FeatureServiceEntry } from '../features/services';
${imports.join('\n')}

/** Runtime services contributed by installed features. */
export const featureServiceEntries: readonly FeatureServiceEntry[] = [
${entries.map(([, name]) => `  ${name},`).join('\n')}
];
`;
}

/**
 * A feature whose dependency is switched off produces a build that compiles
 * and deploys, then throws on the first request when assertFeatureRegistry
 * runs. Catching it here turns that into a build failure with the fix in it.
 */
function assertProfile(ids) {
  const installed = new Set(ids);
  for (const id of ids) {
    const file = path.join(featuresDir, id, 'feature.ts');
    if (!existsSync(file)) continue;
    const block = /requires:\s*\[([^\]]*)\]/.exec(readFileSync(file, 'utf8'));
    if (!block) continue;
    for (const dependency of [...block[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1])) {
      if (!installed.has(dependency)) {
        throw new Error(
          `cms.features.json enables "${id}", which requires "${dependency}" — but "${dependency}" is off. `
          + `Enable it, or turn "${id}" off too.`,
        );
      }
    }
  }
}

function main() {
  const ids = enabledFeatures();
  assertProfile(ids);
  const outputs = [
    [MANIFESTS, buildManifests(ids)],
    [ROUTERS, buildRouters(ids)],
    [SERVICES, buildServices(ids)],
  ];

  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([file, content]) => !existsSync(file) || readFileSync(file, 'utf8') !== content);
    if (stale.length) {
      console.error('Generated feature registries are stale. Run: npm run build:features');
      for (const [file] of stale) console.error(`  ${path.relative(rootDir, file)}`);
      process.exit(1);
    }
    console.log('feature registries up to date');
    return;
  }

  mkdirSync(outDir, { recursive: true });
  for (const [file, content] of outputs) {
    // Unchanged output is left alone: these land in src/, which wrangler dev
    // watches to decide when to re-run the build. See tools/write-if-changed.mjs.
    if (writeIfChanged(file, content)) console.log(`wrote ${path.relative(rootDir, file)}`);
  }
}

main();
