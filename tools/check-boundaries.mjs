// ============================================================
// Import-boundary guard for the admin chrome.
//
// utils/admin-render.ts became a god module by accretion: one convenient
// import at a time, until the trash screen transitively depended on the
// billing engine and the search index. Nothing failed when that happened,
// which is why it kept happening.
//
// These rules make it fail. They cover the layering the refactor paid for:
// core/ never depends on a feature, features never depend on each other, the
// chrome reaches feature code only through the manifest registry, and no
// import cycle runs through it.
//
// Usage: node scripts/check-boundaries.mjs [--quiet]
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sectionExtensions } from './compile-sections.mjs';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const quiet = process.argv.includes('--quiet');

const CHROME = 'src/core/render/chrome.ts';
const REGISTRY = 'src/features/index.ts';
const ROUTERS = 'src/features/routers.ts';
const SERVICES = 'src/features/services.ts';

// Feature machinery the chrome must never pull in directly: every admin page
// render would pay for it, and no admin page except one needs it.
const FORBIDDEN_IN_CHROME = [
  'src/core/db/search.ts',
  'src/core/db/chinese.ts',
  'src/features/publish/index.ts',
  'src/features/publish/projection.ts',
  'src/features/search/template.ts',
];

// Paths in FORBIDDEN_IN_CHROME must exist, or the rule silently passes forever.
// They have moved once already (the utils/ dissolution), so this is checked —
// except for a path inside a feature this build does not install, which is
// absent on purpose rather than moved.
const installedFeatures = new Set(Object.entries(
  JSON.parse(readFileSync(path.join(rootDir, 'cms.features.json'), 'utf8')).features ?? {},
).filter(([, on]) => on === true).map(([id]) => id));

/** True when the path belongs to a feature that is not installed. */
function droppedWithItsFeature(file) {
  const owner = (file.match(/^src\/features\/([^/]+)\//) ?? [])[1];
  return Boolean(owner) && !installedFeatures.has(owner);
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) files.push(path.relative(rootDir, full));
  }
})(path.join(rootDir, 'src'));

/**
 * Local imports of a file. `import type` is erased at build time and costs
 * nothing at runtime, so the bundle-shape rules skip it — but it is still a
 * compile-time dependency, so the droppability rules (3, 4) do not: deleting a
 * feature directory has to leave `tsc` green, and a stray `import type` from
 * outside would break it. Pass includeTypes to get both.
 */
function importsOf(file, includeTypes = false) {
  const source = readFileSync(path.join(rootDir, file), 'utf8');
  const out = new Set();
  const pattern = /(^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)from\s+'(\.[^']+)'/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match[2] && !includeTypes) continue;
    const target = path.normalize(path.join(path.dirname(file), match[4]));
    const resolved = [`${target}.ts`, path.join(target, 'index.ts'), target].find((candidate) => files.includes(candidate));
    if (resolved) out.add(resolved);
  }
  return [...out];
}

const graph = new Map(files.map((file) => [file, importsOf(file)]));
/** As `graph`, but counting `import type` too — see importsOf. */
const typeGraph = new Map(files.map((file) => [file, importsOf(file, true)]));

function closure(root, blocked = new Set()) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node) || blocked.has(node)) continue;
    seen.add(node);
    for (const next of graph.get(node) ?? []) if (!blocked.has(next)) stack.push(next);
  }
  return seen;
}

const failures = [];

for (const forbidden of FORBIDDEN_IN_CHROME) {
  if (files.includes(forbidden) || !forbidden.startsWith('src/')) continue;
  if (droppedWithItsFeature(forbidden)) continue;
  failures.push(`FORBIDDEN_IN_CHROME lists ${forbidden}, which no longer exists — the rule would pass by accident`);
}

// 1. The chrome may reach feature code only through the contributor registry.
const withoutRegistry = closure(CHROME, new Set([REGISTRY]));
for (const file of withoutRegistry) {
  if (file.startsWith('src/features/')) {
    failures.push(`${CHROME} reaches ${file} without going through ${REGISTRY}`);
  }
}

// 2. Not even the registry may drag the heavy feature machinery into the chrome.
const full = closure(CHROME);
for (const forbidden of FORBIDDEN_IN_CHROME) {
  if (full.has(forbidden)) failures.push(`${CHROME} reaches ${forbidden}; every admin render would pay for it`);
}

// 3. Nothing outside src/features/ may reach into it — not core, routes or
//    the entrypoint — except the generated registries.
//
//    This is what makes a feature droppable: `rm -rf src/features/<id>` plus
//    its key in cms.features.json has to leave a tree that still compiles.
//    Type-only imports count here, because tsc fails on those too — that is
//    exactly how the plugin platform stayed undroppable while looking clean.
//    Feature-owned runtime behavior goes through features/services.ts, whose
//    implementations are selected by the generated service registry.
const OUTSIDE_FEATURES = (file) => (
  (
    file.startsWith('src/core/')
    || file.startsWith('src/routes/')
    || file === 'src/index.ts'
  )
);
// These registries are the sanctioned doors. They are generated from
// cms.features.json and survive any feature being dropped.
const FEATURE_REGISTRIES = new Set([REGISTRY, ROUTERS, SERVICES]);
for (const file of files.filter(OUTSIDE_FEATURES)) {
  for (const target of typeGraph.get(file) ?? []) {
    if (!target.startsWith('src/features/')) continue;
    if (FEATURE_REGISTRIES.has(target)) continue;
    failures.push(
      `${file} imports ${target}; nothing outside src/features may depend on a feature `
      + `(only the ${REGISTRY} / ${ROUTERS} / ${SERVICES} registries).`,
    );
  }
}

// 4. A feature may not import a sibling feature unless it declares the
//    dependency in its manifest's `requires`. Feature-to-feature calls use the
//    generated service registry; each feature owns its local wire shapes.
//    A genuine dependency should be stated, not implied by an import, so the
//    registry can refuse a profile that breaks it (assertFeatureRegistry) and
//    the reader can see it. As rule 3, type-only imports count: a declared
//    dependency is also a compile-time one, and no feature declares any today
//    — they cooperate through features/services.ts, which is what lets each be
//    dropped on its own.
const declaredRequires = (feature) => {
  const file = path.join(rootDir, 'src', 'features', feature, 'feature.ts');
  if (!files.includes(path.relative(rootDir, file))) return [];
  const block = /requires:\s*\[([^\]]*)\]/.exec(readFileSync(file, 'utf8'));
  return block ? [...block[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]) : [];
};
const featureOf = (file) => (file.match(/^src\/features\/([^/]+)\//) ?? [])[1];
for (const file of files) {
  const owner = featureOf(file);
  if (!owner) continue;
  for (const target of typeGraph.get(file) ?? []) {
    const other = featureOf(target);
    if (!other || other === owner) continue;
    if (!declaredRequires(owner).includes(other)) {
      failures.push(`${file} imports ${target}; add "${other}" to the ${owner} feature's requires, or move the shared code to core/`);
    }
  }
}

// 5. The registry is the one place that names features, so keep it a list of
//    imports and a little validation — heavier logic there would not survive
//    being generated from cms.features.json.
for (const target of graph.get(REGISTRY) ?? []) {
  if (!target.startsWith('src/features/') && !target.startsWith('src/core/') && !target.startsWith('src/generated/')) {
    failures.push(`${REGISTRY} imports ${target}; it should only re-export the generated manifest list`);
  }
}

// 5b. The generated manifest list must not reach a router, or generation would
//     reintroduce the cycle the two-file split exists to prevent.
const GENERATED_MANIFESTS = 'src/generated/manifests.ts';
for (const file of closure(GENERATED_MANIFESTS)) {
  if (/^src\/features\/[^/]+\/routes(\.ts|\/)/.test(file)) {
    failures.push(`${GENERATED_MANIFESTS} reaches ${file}; manifests must not pull in routers`);
  }
}

// 6. Routers and feature services are registered separately precisely so the
//    chrome never sees them: both can reach heavy feature implementation code.
if (full.has(ROUTERS)) {
  failures.push(`${CHROME} reaches ${ROUTERS}; feature routers must stay out of the manifest registry`);
}
if (full.has(SERVICES)) {
  failures.push(`${CHROME} reaches ${SERVICES}; feature services must stay out of the manifest registry`);
}
for (const file of full) {
  if (/^src\/features\/[^/]+\/routes\.ts$/.test(file)) {
    failures.push(`${CHROME} reaches ${file}; only ${ROUTERS} may import feature routers`);
  }
}

// 7. No import cycle may run through the chrome. This is the failure mode the
//    router split exists to prevent, and it is silent until a bundler happens
//    to order the modules badly.
const cycle = (() => {
  const trail = [];
  const onPath = new Set();
  const done = new Set();
  const walk = (node) => {
    if (onPath.has(node)) return [...trail.slice(trail.indexOf(node)), node];
    if (done.has(node)) return null;
    onPath.add(node);
    trail.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    onPath.delete(node);
    done.add(node);
    trail.pop();
    return null;
  };
  return walk(CHROME);
})();
if (cycle) failures.push(`import cycle through the chrome: ${cycle.join(' -> ')}`);

// 8. Every registered router must belong to an installed feature, or the two
//    registries have drifted and a route is mounted for a feature that is
//    supposed to be gone.
const featureIds = [...(readFileSync(path.join(rootDir, REGISTRY), 'utf8').matchAll(/import\s+\{\s*(\w+)\s*\}\s+from\s+'\.\/([\w-]+)\//g))]
  .map((match) => match[2]);
const routerIds = [...(readFileSync(path.join(rootDir, ROUTERS), 'utf8').matchAll(/id:\s*'([\w-]+)'/g))].map((match) => match[1]);
for (const id of routerIds) {
  if (!featureIds.includes(id)) {
    failures.push(`${ROUTERS} mounts a router for "${id}", which is not installed in ${REGISTRY}`);
  }
}

// ── View ownership ───────────────────────────────────────────────────────────
//
// Views are feature-sliced the same way code is (see tools/build-views.mjs),
// and the same accretion applies: nothing fails when a core screen starts
// rendering a feature's section or using its translation key, right up until
// that feature is dropped and the screen 404s or renders a raw key.
//
// Paths are flat at runtime — /sections/trash.liquid, not
// /features/trash/sections/trash.liquid — so ownership is not visible in the
// reference itself. These rules recover it from the assembled tree.

/** Where a slice keeps its views. Core is a slice like any other, so this is
 *  the same shape build-views.mjs assembles from. */
const viewsDirOf = (owner) => (owner === 'core'
  ? path.join(rootDir, 'src', 'core', 'views')
  : path.join(rootDir, 'src', 'features', owner, 'views'));

/** relative view path (e.g. "sections/trash.liquid") -> 'core' | feature id. */
const viewOwners = new Map();
(function collectViews() {
  const record = (owner, prefix = '') => {
    const dir = path.join(viewsDirOf(owner), prefix);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) record(owner, rel);
      else viewOwners.set(rel, owner);
    }
  };
  record('core');
  for (const entry of readdirSync(path.join(rootDir, 'src', 'features'), { withFileTypes: true })) {
    if (entry.isDirectory()) record(entry.name);
  }
})();

/** The feature that owns a source file, or 'core'. */
const ownerOfSource = (file) => featureOf(file) ?? 'core';

// V1. A view path named in TypeScript must belong to the naming file's own
//     slice (or to core, which everything may use). This is rule 3 for views:
//     a core screen that renders a feature's section is a screen that breaks
//     when the feature is dropped, and tsc cannot see it.
const VIEW_PATH = /'(\/(?:templates|sections|snippets)\/[\w\-/.]+\.(?:json|liquid))'/g;
for (const file of files) {
  const caller = ownerOfSource(file);
  for (const [, literal] of readFileSync(path.join(rootDir, file), 'utf8').matchAll(VIEW_PATH)) {
    const owner = viewOwners.get(literal.slice(1));
    if (!owner) {
      failures.push(`${file} names ${literal}, which no views/ directory provides`);
    } else if (owner !== 'core' && owner !== caller) {
      failures.push(`${file} names ${literal}, owned by the "${owner}" feature; move the view or the caller`);
    }
  }
}

// V2. Same rule one level down: a JSON template names section types, and a
//     core template naming a feature's section fails only once that feature is
//     gone.
for (const [rel, owner] of viewOwners) {
  if (!rel.startsWith('templates/') || !rel.endsWith('.json')) continue;
  const source = path.join(viewsDirOf(owner), rel);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(source, 'utf8'));
  } catch (error) {
    failures.push(`${path.relative(rootDir, source)} is not valid JSON: ${error.message}`);
    continue;
  }
  for (const section of Object.values(parsed.sections ?? {})) {
    if (!section?.type) continue;
    const sectionOwner = sectionExtensions.map(ext => viewOwners.get(`sections/${section.type}.${ext}`)).find(Boolean);
    if (!sectionOwner) {
      failures.push(`${path.relative(rootDir, source)} uses section "${section.type}", which no views/ directory provides`);
    } else if (sectionOwner !== 'core' && sectionOwner !== owner) {
      failures.push(`${path.relative(rootDir, source)} uses section "${section.type}", owned by the "${sectionOwner}" feature`);
    }
  }
}

// V3. Translation keys travel with the view that uses them. `view_strings` keys
//     are named after the view file (view_strings.sections_trash.*), so a key
//     used by a feature's section must live in that feature's catalog — and a
//     core template must not reach for a feature's key, which would render as
//     the raw key once the feature is dropped.
const viewStringKey = /view_strings\.([\w]+)\./g;
for (const [rel, owner] of viewOwners) {
  if (!sectionExtensions.some(ext => rel.endsWith('.' + ext))) continue;
  const source = path.join(viewsDirOf(owner), rel);
  const seen = new Set();
  for (const [, key] of readFileSync(source, 'utf8').matchAll(viewStringKey)) {
    if (seen.has(key)) continue;
    seen.add(key);
    // A key names a view file: sections_trash -> sections/trash.liquid.
    const [kind, ...rest] = key.split('_');
    const named = `${kind}/${rest.join('-')}`;
    const keyOwner = sectionExtensions.map(ext => viewOwners.get(named + '.' + ext)).find(Boolean);
    if (keyOwner && keyOwner !== 'core' && keyOwner !== owner) {
      failures.push(`${path.relative(rootDir, source)} uses view_strings.${key}.*, named after a view the "${keyOwner}" feature owns`);
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.length} import-boundary violation(s):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
if (!quiet) {
  const viaRegistry = full.size - withoutRegistry.size;
  console.log(`✓ chrome closure: ${full.size} modules (${withoutRegistry.size} core + ${viaRegistry} via ${REGISTRY})`);
}
