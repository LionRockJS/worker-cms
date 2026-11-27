// ============================================================
// Schema check for a site's D1 databases.
//
// Schema changes go into the baseline only (README "Schema changes"), so
// `wrangler d1 migrations apply` cannot bring a database created before a
// change up to date, and the code fails closed (sign-in included) on whatever
// is missing. This reads each database's schema with one read-only query on
// sqlite_master, replays those definitions into a local SQLite database and
// compares that with a fresh install of this clone's baseline.
//
// Usage:
//   npm run check:schema -- [-c wrangler.production.toml] [--local]
//   node tools/check-schema.mjs --file <schema.sql> [--db private|published]
// --file checks a schema dump instead, e.g. `wrangler d1 export --no-data`.
// Exit 1 when a table, column, index, view or trigger the code expects is
// missing or different. Objects only the database has are reported, not fatal.
// ============================================================

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASES, applyFile, compare, filesNow, freshDatabase, isNumbered, snapshot } from './check-upgrade-path.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const BINDINGS = { DB: 'private', PUBLISHED_DB: 'published' };
const SCHEMA_QUERY = `SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL
  AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY rowid`;

function parseArgs(argv) {
  const args = { config: 'wrangler.toml', local: false, file: null, db: 'private' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-c' || argv[i] === '--config') args.config = argv[++i];
    else if (argv[i].startsWith('--config=')) args.config = argv[i].slice('--config='.length);
    else if (argv[i] === '--local') args.local = true;
    else if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--db') args.db = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!(args.db in DATABASES)) throw new Error('--db must be private or published');
  return args;
}

/** The DB and PUBLISHED_DB entries of an uncommented [[d1_databases]] block. */
export function d1Databases(configText) {
  return configText.split(/^\s*\[\[d1_databases\]\]\s*$/m).slice(1).flatMap((block) => {
    const body = block.split(/^\s*\[/m)[0];
    const binding = body.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1];
    const name = body.match(/^\s*database_name\s*=\s*"([^"]+)"/m)?.[1];
    return binding in BINDINGS && name ? [{ binding, name, kind: BINDINGS[binding] }] : [];
  });
}

/** Differences from a fresh install: `problems` break the code, `extra` is only in the database. */
export function checkSchema(kind, schemaSql) {
  const deployed = freshDatabase();
  applyFile(deployed, 'deployed schema', schemaSql);
  const { dir } = DATABASES[kind];
  const fresh = freshDatabase();
  for (const name of filesNow(dir).filter(isNumbered)) {
    applyFile(fresh, `${dir}/${name}`, readFileSync(path.join(rootDir, dir, name), 'utf8'));
  }
  const { errors, warnings } = compare(snapshot(deployed), snapshot(fresh), 'in the database');
  return {
    problems: errors.filter((error) => !error.includes('exists only')),
    extra: errors.filter((error) => error.includes('exists only')),
    warnings,
  };
}

function remoteSchema(args, database) {
  const output = execFileSync('npx', ['wrangler', 'd1', 'execute', database.name, args.local ? '--local' : '--remote',
    '--json', '--command', SCHEMA_QUERY, '-c', args.config], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const rows = JSON.parse(output).flatMap((result) => result.results ?? []);
  return rows.map((row) => `${row.sql};`).join('\n');
}

function report(label, { problems, extra, warnings }) {
  console.log(`\n[${label}] ${problems.length ? `${problems.length} problem(s): the code needs what is missing` : 'matches this clone\'s baseline'}`);
  for (const problem of problems) console.log(`  MISSING/DIFFERENT ${problem}`);
  for (const item of extra) console.log(`  EXTRA ${item}`);
  for (const warning of warnings) console.log(`  REVIEW ${warning}`);
  return problems.length > 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.file) {
    process.exitCode = report(`${args.db} ${path.basename(args.file)}`, checkSchema(args.db, readFileSync(args.file, 'utf8'))) ? 1 : 0;
    return;
  }
  const databases = d1Databases(readFileSync(path.resolve(rootDir, args.config), 'utf8'));
  if (!databases.some((database) => database.binding === 'DB')) throw new Error(`${args.config} declares no DB database`);
  console.log(`Schema check for ${args.config} (${args.local ? 'local' : 'remote'}, read-only)`);
  let failed = false;
  for (const database of databases) {
    if (report(`${database.binding} ${database.name}`, checkSchema(database.kind, remoteSchema(args, database)))) failed = true;
  }
  if (failed) console.log('\nRecreate the database or add what is missing by hand before deploying (README "Schema changes").');
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
