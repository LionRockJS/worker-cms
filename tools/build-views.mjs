// ============================================================
// View assembler.
//
// src/ is feature-sliced but the view tree was not, so every Liquid section,
// template JSON, snippet and locale string shipped whether or not its feature
// was installed: `rm -rf src/features/trash` left sections/trash.liquid and
// four locales' worth of trash.* keys behind, and nothing failed.
//
// This script gives views the same droppability contract the schema fragments
// already have — and the same shape, deliberately, so the two assemblers read
// alike (compare build-migrations.mjs: src/core/schema.sql + the enabled
// src/features/<id>/schema.sql):
//
//   src/core/views/**                 the core chrome, always included
//   src/features/<id>/views/**        merged in when <id> is enabled
//   -> dist/views/**                  what [assets] points at
//
// Runtime paths do not change. A section still resolves as
// /sections/<name>.liquid, so renderView(), the client engine's root list and
// the plugin fallback chain in features/plugins/views.ts are untouched — only
// the set of files that reaches the bundle is.
//
// Two paths colliding is a build error rather than a last-writer-wins merge:
// two features owning one section, or a feature shadowing a core view, is a
// mistake worth failing on.
//
// locales/<lang>.json is the exception to the plain copy: it is deep-merged
// from the core catalog plus each enabled feature's fragment, so a feature
// carries its own namespace (`trash.*`) and its own view strings
// (`view_strings.sections_trash.*`) and takes them with it when it goes.
//
// dist/views also receives the compiled admin.css, richtext-md.js and yjs.js bundles.
// Those are written by build:css / build:js after this runs, so the assembler
// leaves them alone (see GENERATED) instead of pruning them as strays.
//
// This also emits assets-source/tailwind-sources.css, so the stylesheet prunes
// with the same switch. Tailwind cannot simply scan dist/views: `@source`
// honours .gitignore, and dist/ is ignored, so the assembled tree is invisible
// to it (measured — scanning it yields the base layer and little else). The
// generated file therefore lists the *source* trees of the enabled features,
// which are tracked and so do get scanned.
//
// Usage:
//   node tools/build-views.mjs           # assemble dist/views
//   node tools/build-views.mjs --check   # exit 1 if the outputs are stale
// ============================================================

import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from './build-migrations.mjs';
import { writeIfChanged } from './write-if-changed.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const featuresDir = path.join(rootDir, 'src', 'features');
const coreViewsDir = path.join(rootDir, 'src', 'core', 'views');
const distDir = path.join(rootDir, 'dist', 'views');
const tailwindSources = path.join(rootDir, 'assets-source', 'tailwind-sources.css');
const LOCALES = 'locales';

/**
 * Build outputs that land in dist/views without passing through here:
 * `build:css` compiles assets-source/admin.css, `build:js` bundles
 * assets-source/richtext-md.js and yjs.js. The assembler must not prune them, and
 * --check must not read them as strays.
 */
const GENERATED = new Set(['assets/admin.css', 'assets/richtext-md.js', 'assets/yjs.js']);

/** Files that are never assets, however they got into the source tree. */
function isIgnored(name) {
  return name.startsWith('.');
}

/**
 * Source-only locale catalogs are used by Liquid/static checks but are not
 * runtime view assets. Keep them in the source tree without treating their
 * suffix as a UI language (or shipping them to dist/views).
 */
function isSourceOnlyLocale(rel) {
  return rel.startsWith(`${LOCALES}/`) && rel.endsWith('.default.json');
}

/** Every file under `dir`, as paths relative to it, sorted. */
function walk(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (isIgnored(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** The feature ids enabled in the manifest that ship a views/ directory. */
export function featuresWithViews(features) {
  return Object.entries(features)
    .filter(([id, on]) => on === true && existsSync(path.join(featuresDir, id, 'views')))
    .map(([id]) => id)
    .sort();
}

/** Every feature id with a views/ directory on disk, enabled or not. */
export function availableViewFeatures() {
  if (!existsSync(featuresDir)) return [];
  return readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(featuresDir, entry.name, 'views')))
    .map((entry) => entry.name)
    .sort();
}

/** Recursively sorts object keys so the emitted JSON is byte-stable. */
function sortDeep(value) {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
}

/**
 * Merges a feature catalog into the accumulating one. Collisions are an error
 * at every depth: two owners for one string is the same mistake as two owners
 * for one section, and silently picking a winner is how a dropped feature
 * leaves its strings behind.
 */
function mergeCatalog(into, from, owner, trail = []) {
  for (const [key, value] of Object.entries(from)) {
    const at = [...trail, key];
    const existing = into[key];
    if (existing === undefined) {
      into[key] = value;
      continue;
    }
    const bothObjects = existing && value && typeof existing === 'object' && typeof value === 'object'
      && !Array.isArray(existing) && !Array.isArray(value);
    if (!bothObjects) {
      throw new Error(`locale key "${at.join('.')}" is defined twice; ${owner} may not redefine it`);
    }
    mergeCatalog(existing, value, owner, at);
  }
}

/**
 * The whole assembled tree as `relative path -> Buffer`, without touching the
 * filesystem — so a test can assemble an alternate profile the way the
 * migration tests assemble an alternate baseline.
 */
export function assembleViews(features) {
  const enabled = featuresWithViews(features);
  const files = new Map();
  const owners = new Map();

  const add = (rel, contents, owner) => {
    if (files.has(rel)) {
      throw new Error(`${owner} and ${owners.get(rel)} both provide ${rel}`);
    }
    if (GENERATED.has(rel)) {
      throw new Error(`${owner} provides ${rel}, which is a build output; edit assets-source/ instead`);
    }
    files.set(rel, contents);
    owners.set(rel, owner);
  };

  // Locales are merged rather than copied, so they are collected separately
  // and emitted once at the end.
  const catalogs = new Map();
  const localeOf = (rel) => (rel.startsWith(`${LOCALES}/`) && rel.endsWith('.json') ? rel.slice(LOCALES.length + 1, -'.json'.length) : null);

  for (const rel of walk(coreViewsDir)) {
    if (isSourceOnlyLocale(rel)) continue;
    const lang = localeOf(rel);
    if (lang) {
      catalogs.set(lang, JSON.parse(readFileSync(path.join(coreViewsDir, rel), 'utf8')));
      continue;
    }
    add(rel, readFileSync(path.join(coreViewsDir, rel)), 'core');
  }

  if (catalogs.size === 0) throw new Error('src/core/views/locales holds no catalogs; the core catalog defines the supported languages');

  for (const id of enabled) {
    const dir = path.join(featuresDir, id, 'views');
    const seenLangs = new Set();
    for (const rel of walk(dir)) {
      if (isSourceOnlyLocale(rel)) continue;
      const lang = localeOf(rel);
      if (lang) {
        if (!catalogs.has(lang)) {
          throw new Error(`src/features/${id}/views/${rel} is a language the core catalog does not define`);
        }
        mergeCatalog(catalogs.get(lang), JSON.parse(readFileSync(path.join(dir, rel), 'utf8')), `feature "${id}"`);
        seenLangs.add(lang);
        continue;
      }
      add(rel, readFileSync(path.join(dir, rel)), `feature "${id}"`);
    }
    // A feature that translates one language must translate all of them:
    // otherwise its screens silently fall back to English in the others.
    if (seenLangs.size > 0) {
      const missing = [...catalogs.keys()].filter((lang) => !seenLangs.has(lang)).sort();
      if (missing.length) {
        throw new Error(`feature "${id}" ships locale fragments but not for: ${missing.join(', ')}`);
      }
    }
  }

  for (const [lang, catalog] of catalogs) {
    files.set(`${LOCALES}/${lang}.json`, Buffer.from(`${JSON.stringify(sortDeep(catalog), null, 2)}\n`));
  }

  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The `@source` list admin.css imports: the core tree (chrome, views and the
 * core server-side renderers under core/templates/), the admin routers, and one
 * entry per enabled feature. A feature that is switched off
 * — or deleted — contributes no selectors, so the stylesheet shrinks with the
 * profile instead of carrying utilities only its screens ever used.
 */
export function buildTailwindSources(features) {
  const enabled = Object.entries(features).filter(([, on]) => on === true).map(([id]) => id).sort();
  const lines = [
    '/* GENERATED FILE — do not edit. Written by `npm run build:views` from',
    '   cms.features.json; imported by admin.css.',
    '',
    '   Tailwind scans these paths for class names. They are the *source* trees,',
    '   not the assembled dist/views, because `@source` honours .gitignore and',
    '   dist/ is ignored — Tailwind sees nothing there. Listing the enabled',
    '   features explicitly gets the same pruning by a route Tailwind can walk. */',
    '',
    '@source "../src/core";',
    '@source "../src/routes/**/*.ts";',
  ];
  for (const id of enabled) {
    if (!existsSync(path.join(featuresDir, id))) continue;
    lines.push(`@source "../src/features/${id}";`);
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the tree, pruning anything a previous profile left behind. */
function write(files) {
  mkdirSync(distDir, { recursive: true });

  for (const rel of walk(distDir)) {
    if (files.has(rel) || GENERATED.has(rel)) continue;
    rmSync(path.join(distDir, rel));
  }

  for (const [rel, contents] of files) {
    writeIfChanged(path.join(distDir, rel), contents);
  }

  pruneEmptyDirs(distDir);
}

function pruneEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    pruneEmptyDirs(full);
    if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
  }
}

/** Differences between the assembled tree and what is on disk. */
function staleness(files) {
  if (!existsSync(distDir)) return ['dist/views does not exist'];
  const problems = [];
  const onDisk = new Set(walk(distDir).filter((rel) => !GENERATED.has(rel)));
  for (const [rel, contents] of files) {
    const target = path.join(distDir, rel);
    if (!existsSync(target)) problems.push(`missing: ${rel}`);
    else if (Buffer.compare(readFileSync(target), Buffer.from(contents)) !== 0) problems.push(`differs: ${rel}`);
    onDisk.delete(rel);
  }
  for (const rel of [...onDisk].sort()) problems.push(`stray: ${rel}`);
  return problems;
}

function main() {
  const features = readManifest();
  const files = assembleViews(features);
  const sources = buildTailwindSources(features);

  if (process.argv.includes('--check')) {
    const problems = staleness(files);
    if (!existsSync(tailwindSources) || readFileSync(tailwindSources, 'utf8') !== sources) {
      problems.push('differs: assets-source/tailwind-sources.css');
    }
    if (problems.length) {
      console.error('The assembled views are stale. Run: npm run build:views');
      for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
      if (problems.length > 20) console.error(`  ...and ${problems.length - 20} more`);
      process.exit(1);
    }
    console.log('views up to date');
    return;
  }

  write(files);
  writeIfChanged(tailwindSources, sources);
  const enabled = featuresWithViews(features);
  const dropped = availableViewFeatures().filter((id) => !enabled.includes(id));
  const bytes = [...files.values()].reduce((sum, contents) => sum + Buffer.byteLength(contents), 0);
  console.log(`wrote dist/views (${files.size} files, ${(bytes / 1024).toFixed(0)} kB) from core + ${enabled.length ? enabled.join(', ') : 'no features'}`);
  if (dropped.length) console.log(`  dropped: ${dropped.join(', ')}`);
}

// Only run the CLI when invoked directly; the assembly tests import
// assembleViews to build alternate profiles.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

export { distDir as viewsDistDir, GENERATED as generatedViewAssets };
