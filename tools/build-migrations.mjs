// ============================================================
// Migration assembler.
//
// Wrangler allows exactly one `migrations_dir` per D1 database and has no
// CLI override, so features cannot each own a migrations folder that wrangler
// walks. Instead each feature keeps its SQL *fragment* next to its code, and
// this script concatenates the enabled ones into the flat baseline files
// wrangler already points at:
//
//   src/core/schema.sql + every enabled fragment -> migrations/0001_initial_schema.sql
//   src/core/publish/schema.sql                  -> migrations/published/0001_published_schema.sql
//
// A fragment is any src/**/schema.sql or src/**/*.schema.sql that declares
// `-- feature: <id>` in its header; the id, not the path, is what
// cms.features.json switches on. src/core/schema.sql and src/core/publish/schema.sql
// declare no id and are always included.
//
// The baseline filenames never change. D1 tracks applied migrations by name
// only (see wrangler's getUnappliedMigrationNames), so regenerating a baseline
// that an existing database has already applied is a no-op there — the new
// content only affects fresh installs. To add a feature's tables to a database
// that already ran the baseline, emit an additive migration instead:
//
//   node scripts/build-migrations.mjs --enable <feature>
//
// Fragments are idempotent (CREATE ... IF NOT EXISTS), so an enable migration
// is safe to apply to a database that happens to have the tables already.
//
// Usage:
//   node scripts/build-migrations.mjs            # write the baselines
//   node scripts/build-migrations.mjs --check    # exit 1 if they are stale
//   node scripts/build-migrations.mjs --enable X # additive migration for X
// ============================================================

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIfChanged } from './write-if-changed.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const srcDir = path.join(rootDir, 'src');
const CORE_SCHEMA = path.join(srcDir, 'core', 'schema.sql');
const PUBLISHED_SCHEMA = path.join(srcDir, 'core', 'publish', 'schema.sql');
const manifestPath = path.join(rootDir, 'cms.features.json');

const CMS_BASELINE = path.join(rootDir, 'migrations', '0001_initial_schema.sql');
const PUBLISHED_BASELINE = path.join(rootDir, 'migrations', 'published', '0001_published_schema.sql');

/** Reads the enabled-feature map from cms.features.json. */
export function readManifest() {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const features = raw.features ?? {};
  if (typeof features !== 'object' || Array.isArray(features)) {
    throw new Error('cms.features.json: "features" must be an object of id -> boolean');
  }
  return features;
}

/** Every fragment on disk, as { id -> absolute path }, discovered by header. */
function discoverFragments() {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('schema.sql')) continue;
      if (full === CORE_SCHEMA || full === PUBLISHED_SCHEMA) continue;
      const match = /^--\s*feature:\s*([\w-]+)\s*$/m.exec(readFileSync(full, 'utf8'));
      if (!match) {
        throw new Error(`${path.relative(rootDir, full)} has no "-- feature: <id>" header`);
      }
      const id = match[1];
      if (found.has(id)) {
        throw new Error(`two fragments both declare feature "${id}": ${path.relative(rootDir, found.get(id))} and ${path.relative(rootDir, full)}`);
      }
      found.set(id, full);
    }
  };
  walk(srcDir);
  return found;
}

const fragments = discoverFragments();

/** Every feature fragment that exists on disk, in stable (sorted) order. */
export function availableFeatures() {
  return [...fragments.keys()].sort();
}

function fragmentPath(id) {
  const found = fragments.get(id);
  if (!found) throw new Error(`no schema fragment declares feature "${id}"`);
  return found;
}

/**
 * Feature-level dependencies, declared in the fragment header as
 * `-- requires: a, b`. "core" is implicit and ignored.
 */
export function requiredFeatures(id) {
  const match = /^--\s*requires:\s*(.+)$/m.exec(readFileSync(fragmentPath(id), 'utf8'));
  if (!match) return [];
  return match[1]
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && value !== 'core');
}

/**
 * Enabled features in dependency order: a feature is always emitted after
 * everything it requires. Manifest order breaks ties, so the output is stable.
 */
function resolveOrder(features) {
  const available = availableFeatures();
  // Only ids with a fragment take part in schema assembly; code-only
  // features contribute nothing here.
  const enabled = Object.entries(features)
    .filter(([id, on]) => on === true && available.includes(id))
    .map(([id]) => id);

  // A feature may be schema-only (plugins, jobs), code-only (search,
  // users-roles) or both. Only a name that is neither is a typo.
  for (const id of Object.keys(features)) {
    if (available.includes(id)) continue;
    if (existsSync(path.join(srcDir, 'features', id))) continue;
    throw new Error(`cms.features.json lists "${id}", but there is no schema fragment declaring it and no src/features/${id}/`);
  }
  for (const id of available) {
    if (!(id in features)) {
      throw new Error(`${path.relative(rootDir, fragmentPath(id))} declares feature "${id}", which is not listed in cms.features.json (add it as true or false)`);
    }
  }

  const ordered = [];
  const visiting = new Set();
  const visit = (id, trail) => {
    if (ordered.includes(id)) return;
    if (visiting.has(id)) {
      throw new Error(`circular feature dependency: ${[...trail, id].join(' -> ')}`);
    }
    visiting.add(id);
    for (const dependency of requiredFeatures(id)) {
      if (!enabled.includes(dependency)) {
        throw new Error(`feature "${id}" requires "${dependency}", which is disabled in cms.features.json`);
      }
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    ordered.push(id);
  };
  for (const id of enabled) visit(id, []);
  return ordered;
}

function generatedHeader(title, parts) {
  return [
    '-- ============================================================',
    `-- ${title}`,
    '--',
    '-- GENERATED FILE — do not edit. Edit the schema.sql fragments beside',
    '-- the code they belong to and run `npm run build:migrations`.',
    '--',
    '-- Assembled from:',
    ...parts.map((part) => `--   ${part}`),
    '-- ============================================================',
    '',
  ].join('\n');
}

/** Concatenates fragments, normalizing to exactly one blank line between them. */
function concat(header, fragmentFiles) {
  const bodies = fragmentFiles.map((file) => readFileSync(file, 'utf8').trim());
  return `${header}\n${bodies.join('\n\n')}\n`;
}

export function buildCms(features) {
  const order = resolveOrder(features);
  const files = [CORE_SCHEMA, ...order.map(fragmentPath)];
  const parts = [path.relative(rootDir, CORE_SCHEMA), ...order.map((id) => path.relative(rootDir, fragmentPath(id)))];
  const disabled = Object.entries(features)
    .filter(([id, on]) => on !== true && availableFeatures().includes(id))
    .map(([id]) => id);
  if (disabled.length) parts.push(`(disabled: ${disabled.join(', ')})`);
  return concat(generatedHeader('Initial CMS schema — applied to the private CMS (admin) database.', parts), files);
}

export function buildPublished() {
  return concat(
    generatedHeader('Published content schema — applied to the published-only D1 database.', [path.relative(rootDir, PUBLISHED_SCHEMA)]),
    [PUBLISHED_SCHEMA],
  );
}

/**
 * Writes an additive migration that creates one feature's objects on a
 * database that already applied the baseline. The number is one past the
 * highest existing migration; the name embeds the feature id so it stays
 * unique in the shared d1_migrations table.
 */
function writeEnableMigration(id) {
  const available = availableFeatures();
  if (!available.includes(id)) {
    throw new Error(`unknown feature "${id}". Available: ${available.join(', ')}`);
  }
  const dir = path.join(rootDir, 'migrations');
  const highest = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .reduce((max, name) => Math.max(max, Number.parseInt(name.slice(0, 4), 10) || 0), 0);
  const number = String(highest + 1).padStart(4, '0');
  const target = path.join(dir, `${number}_enable_${id.replaceAll('-', '_')}.sql`);
  const header = [
    '-- ============================================================',
    `-- Enable feature: ${id}`,
    '--',
    '-- GENERATED by `node scripts/build-migrations.mjs --enable`. Creates this',
    "-- feature's objects on a database that already applied the baseline.",
    '-- Idempotent: every statement is CREATE ... IF NOT EXISTS or INSERT OR IGNORE.',
    '-- ============================================================',
    '',
  ].join('\n');
  writeFileSync(target, `${header}\n${readFileSync(fragmentPath(id), 'utf8').trim()}\n`);
  return path.relative(rootDir, target);
}

/** Absolute paths of the generated baselines, for callers that read them back. */
export const baselinePaths = { cms: CMS_BASELINE, published: PUBLISHED_BASELINE };

function main() {
  const args = process.argv.slice(2);
  const enableIndex = args.indexOf('--enable');
  if (enableIndex !== -1) {
    const id = args[enableIndex + 1];
    if (!id) throw new Error('--enable requires a feature id');
    console.log(`wrote ${writeEnableMigration(id)}`);
    console.log(`Set "${id}": true in cms.features.json, then run npm run build:migrations.`);
    return;
  }

  const features = readManifest();
  const outputs = [
    [CMS_BASELINE, buildCms(features)],
    [PUBLISHED_BASELINE, buildPublished()],
  ];

  if (args.includes('--check')) {
    const stale = outputs.filter(([file, content]) => !existsSync(file) || readFileSync(file, 'utf8') !== content);
    if (stale.length) {
      console.error('Generated migrations are stale. Run: npm run build:migrations');
      for (const [file] of stale) console.error(`  ${path.relative(rootDir, file)}`);
      process.exit(1);
    }
    console.log('migrations up to date');
    return;
  }

  for (const [file, content] of outputs) {
    if (writeIfChanged(file, content)) console.log(`wrote ${path.relative(rootDir, file)}`);
  }
}

// Only run the CLI when invoked directly; vitest.config.mts imports the
// builders to assemble alternate profiles for the assembly tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
