// ============================================================
// Upgrade and rollback drill for the D1 schemas (W7, A.8.32).
//
// A database deployed at an earlier revision is not upgraded by the regenerated
// baseline: D1 tracks migrations by name, so it only receives numbered files it
// has not applied, plus whichever one-off files under migrations/manual/ an
// operator runs by hand. Nothing checked that this path ends where a fresh
// install does, or told the operator which manual files a given revision needs.
//
// This rebuilds the schema as it stood at --from (every numbered migration at
// that revision, applied to an empty database), then applies the upgrade path
// to it, and compares the result with a fresh install of the current tree:
//
//   1. manual files added after --from, in filename (date) order — they are
//      core upgrades that feature enable migrations may build on;
//   2. numbered files that did not exist at --from, in number order.
//
// It also reports rollback hazards: what the --from code would meet if the
// Worker were rolled back after the upgrade (dropped tables or columns, new
// NOT NULL columns without a default, new triggers on its tables).
//
// Local SQLite (node:sqlite), not D1: it proves the SQL path, not a deployed
// database's actual state. The --from database is assumed to be a fresh install
// of that revision; one that skipped earlier manual files will differ.
//
// Usage:
//   node tools/check-upgrade-path.mjs --from <revision> [--db private|published|both]
// Exit 1 on schema drift or a failed migration. Hazards are reported, not fatal.
// ============================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

const DATABASES = {
  private: { dir: 'migrations', manual: 'migrations/manual' },
  published: { dir: 'migrations/published', manual: null },
};

function parseArgs(argv) {
  const args = { from: null, db: 'both' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--db') args.db = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.from) throw new Error('--from <revision> is required');
  if (!['private', 'published', 'both'].includes(args.db)) throw new Error('--db must be private, published or both');
  return args;
}

function git(...args) {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const isNumbered = (name) => /^\d{4}_.+\.sql$/.test(name);
const isSql = (name) => name.endsWith('.sql');

/** Empty, not an error, when the directory did not exist at that revision. */
function filesAt(revision, dir) {
  const listing = git('ls-tree', '--name-only', revision, `${dir}/`).split('\n').filter(Boolean);
  return listing.map((file) => path.posix.basename(file)).filter(isSql).sort();
}

function filesNow(dir) {
  try { return readdirSync(path.join(rootDir, dir)).filter(isSql).sort(); } catch { return []; }
}

function applyFile(db, label, sql) {
  try {
    db.exec(sql);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

function freshDatabase() {
  const db = new DatabaseSync(':memory:');
  // D1 runs with foreign keys on; a migration that only works without them
  // would pass here and fail there.
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

const normalizeSql = (sql) => String(sql ?? '')
  .replace(/--[^\n]*/g, '')
  .replace(/\bIF NOT EXISTS\b/gi, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([(),])\s*/g, '$1')
  .trim();

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

function snapshot(db) {
  const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name`).all();
  const schema = { tables: new Map(), indexes: new Map(), triggers: new Map(), views: new Map() };
  for (const object of objects) {
    if (object.type === 'table') {
      const columns = new Map(db.prepare(`PRAGMA table_xinfo(${quote(object.name)})`).all()
        .map((c) => [c.name, { type: c.type.toUpperCase(), notnull: c.notnull, dflt: c.dflt_value, pk: c.pk, hidden: c.hidden }]));
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quote(object.name)})`).all()
        .map((f) => `${f.from}->${f.table}(${f.to}) on update ${f.on_update} on delete ${f.on_delete}`).sort();
      schema.tables.set(object.name, { columns, foreignKeys, sql: normalizeSql(object.sql) });
    } else if (object.type === 'index' && object.sql) {
      schema.indexes.set(object.name, { table: object.tbl_name, sql: normalizeSql(object.sql) });
    } else if (object.type === 'trigger') {
      schema.triggers.set(object.name, { table: object.tbl_name, sql: normalizeSql(object.sql) });
    } else if (object.type === 'view') {
      schema.views.set(object.name, { sql: normalizeSql(object.sql) });
    }
  }
  return schema;
}

/** Differences that make the upgraded database something a fresh install is not. */
function compare(upgraded, fresh, where = 'after upgrade') {
  const errors = [];
  const warnings = [];
  for (const [name, table] of fresh.tables) {
    const actual = upgraded.tables.get(name);
    if (!actual) { errors.push(`table ${name} is missing ${where}`); continue; }
    for (const [column, spec] of table.columns) {
      const got = actual.columns.get(column);
      if (!got) errors.push(`column ${name}.${column} is missing ${where}`);
      else if (JSON.stringify(got) !== JSON.stringify(spec)) {
        errors.push(`column ${name}.${column} differs: upgraded ${JSON.stringify(got)}, fresh ${JSON.stringify(spec)}`);
      }
    }
    for (const column of actual.columns.keys()) {
      if (!table.columns.has(column)) errors.push(`column ${name}.${column} exists only ${where}`);
    }
    if (JSON.stringify(actual.foreignKeys) !== JSON.stringify(table.foreignKeys)) {
      errors.push(`foreign keys on ${name} differ: upgraded ${JSON.stringify(actual.foreignKeys)}, fresh ${JSON.stringify(table.foreignKeys)}`);
    }
    // ALTER TABLE ADD COLUMN appends to the stored definition, so a matching
    // column set can still read differently. CHECK constraints live only in
    // this text and cannot be added by ALTER, so a difference needs a person.
    if (actual.sql !== table.sql && !errors.some((e) => e.includes(` ${name}.`) || e.includes(`on ${name} `))) {
      warnings.push(`table ${name} definition text differs (columns match); review CHECK constraints and column order`);
    }
  }
  for (const name of upgraded.tables.keys()) {
    if (!fresh.tables.has(name)) errors.push(`table ${name} exists only ${where}`);
  }
  for (const kind of ['indexes', 'triggers', 'views']) {
    const label = kind === 'indexes' ? 'index' : kind.slice(0, -1);
    for (const [name, spec] of fresh[kind]) {
      const got = upgraded[kind].get(name);
      if (!got) errors.push(`${label} ${name} is missing ${where}`);
      else if (got.sql !== spec.sql) errors.push(`${label} ${name} differs from a fresh install`);
    }
    for (const name of upgraded[kind].keys()) {
      if (!fresh[kind].has(name)) errors.push(`${label} ${name} exists only ${where}`);
    }
  }
  return { errors, warnings };
}

/**
 * What code at --from would meet if it ran against the upgraded schema.
 * Hazards break the older code. Review items are new triggers on its tables:
 * often intended (the plan keeps new default-deny guards through a rollback),
 * but each can refuse a write the older code expects to succeed.
 */
function rollbackFindings(before, after) {
  const hazards = [];
  const reviews = [];
  for (const [name, table] of before.tables) {
    const now = after.tables.get(name);
    if (!now) { hazards.push(`table ${name} no longer exists`); continue; }
    for (const column of table.columns.keys()) {
      if (!now.columns.has(column)) hazards.push(`column ${name}.${column} no longer exists`);
    }
    for (const [column, spec] of now.columns) {
      if (!table.columns.has(column) && spec.notnull && spec.dflt === null && !spec.pk) {
        hazards.push(`new column ${name}.${column} is NOT NULL with no default: inserts by the older code fail`);
      }
    }
  }
  for (const [name, trigger] of after.triggers) {
    if (!before.triggers.has(name) && before.tables.has(trigger.table)) {
      reviews.push(`new trigger ${name} fires on writes to ${trigger.table}`);
    }
  }
  return { hazards, reviews };
}

function drill(kind, from) {
  const { dir, manual } = DATABASES[kind];
  const numberedAt = filesAt(from, dir).filter(isNumbered);
  const numberedNow = filesNow(dir).filter(isNumbered);
  const manualAt = manual ? new Set(filesAt(from, manual)) : new Set();
  const manualNow = manual ? filesNow(manual) : [];

  const before = freshDatabase();
  for (const name of numberedAt) applyFile(before, `${from}:${dir}/${name}`, git('show', `${from}:${dir}/${name}`));
  const beforeSchema = snapshot(before);

  const plan = [
    ...manualNow.filter((name) => !manualAt.has(name)).map((name) => `${manual}/${name}`),
    ...numberedNow.filter((name) => !numberedAt.includes(name)).map((name) => `${dir}/${name}`),
  ];
  for (const file of plan) applyFile(before, file, readFileSync(path.join(rootDir, file), 'utf8'));
  const upgraded = snapshot(before);

  const fresh = freshDatabase();
  for (const name of numberedNow) applyFile(fresh, `${dir}/${name}`, readFileSync(path.join(rootDir, dir, name), 'utf8'));

  return { plan, ...compare(upgraded, snapshot(fresh)), rollback: rollbackFindings(beforeSchema, upgraded) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = git('rev-parse', '--verify', `${args.from}^{commit}`).trim();
  const kinds = args.db === 'both' ? ['private', 'published'] : [args.db];
  let failed = false;
  console.log(`Upgrade drill from ${from.slice(0, 7)} to the working tree`);
  for (const kind of kinds) {
    let result;
    try {
      result = drill(kind, from);
    } catch (error) {
      failed = true;
      console.log(`\n[${kind}] FAILED to apply: ${error.message}`);
      continue;
    }
    console.log(`\n[${kind}] apply, in order:${result.plan.length ? '' : ' nothing'}`);
    for (const file of result.plan) console.log(`  ${file}`);
    console.log(`[${kind}] schema: ${result.errors.length ? `${result.errors.length} difference(s) from a fresh install` : 'matches a fresh install'}`);
    for (const error of result.errors) console.log(`  ERROR ${error}`);
    for (const warning of result.warnings) console.log(`  REVIEW ${warning}`);
    const { hazards, reviews } = result.rollback;
    console.log(`[${kind}] rollback to ${from.slice(0, 7)}: ${hazards.length} hazard(s), ${reviews.length} trigger(s) to review`);
    for (const hazard of hazards) console.log(`  HAZARD ${hazard}`);
    for (const review of reviews) console.log(`  REVIEW ${review}`);
    if (result.errors.length) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

// Shared with tools/check-export.mjs, which compares an exported database
// against the same fresh install.
export { DATABASES, applyFile, compare, filesNow, freshDatabase, isNumbered, snapshot };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
