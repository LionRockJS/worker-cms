// ============================================================
// Exit drill for a D1 export (W10, A.5.23; feeds W11, A.8.13).
//
// An exit plan is only real if the data comes out in a form something other
// than Cloudflare can use. `wrangler d1 export` writes plain SQL; this loads
// that file into a stock SQLite database, checks its integrity and foreign
// keys, compares its schema with a fresh install of the current tree, and
// counts rows per table so the result can be reconciled with the source.
//
// It reads a file and writes nothing. Run the export with the deployment's own
// credentials, keep the file and this output in the restricted evidence system,
// and never commit an export: it holds every row, personal data included.
//
// Usage:
//   npx wrangler d1 export <database> --remote --output <file.sql>
//   node tools/check-export.mjs --file <file.sql> [--db private|published]
// Exit 1 if the file does not load, fails an integrity check, or its schema
// differs from a fresh install.
// ============================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASES, applyFile, compare, filesNow, freshDatabase, isNumbered, snapshot } from './check-upgrade-path.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const args = { file: null, db: 'private' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--db') args.db = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.file) throw new Error('--file <export.sql> is required');
  if (!(args.db in DATABASES)) throw new Error('--db must be private or published');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const restored = freshDatabase();
  applyFile(restored, args.file, readFileSync(args.file, 'utf8'));

  const integrity = restored.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
  const foreignKeys = restored.prepare('PRAGMA foreign_key_check').all();

  const { dir } = DATABASES[args.db];
  const numbered = filesNow(dir).filter(isNumbered);
  const fresh = freshDatabase();
  for (const name of numbered) applyFile(fresh, `${dir}/${name}`, readFileSync(path.join(rootDir, dir, name), 'utf8'));
  const { errors, warnings } = compare(snapshot(restored), snapshot(fresh), 'in the export');

  // An export from an older revision is expected to differ; say why.
  let applied = [];
  try {
    applied = restored.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((row) => row.name);
  } catch { /* exports taken without the migrations table */ }
  const missing = numbered.filter((name) => !applied.includes(name));

  const tables = restored.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name`).all().map((row) => row.name);
  const counts = tables.map((name) => [name, restored.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n]);

  console.log(`Export ${path.basename(args.file)} loaded into SQLite ${restored.prepare('SELECT sqlite_version() AS v').get().v}`);
  console.log(`Integrity: ${integrity.join(', ')}; foreign-key violations: ${foreignKeys.length}`);
  console.log(`Schema: ${errors.length ? `${errors.length} difference(s) from a fresh install` : 'matches a fresh install'}`);
  for (const error of errors) console.log(`  ERROR ${error}`);
  for (const warning of warnings) console.log(`  REVIEW ${warning}`);
  if (missing.length) console.log(`  Numbered migrations not recorded in the export: ${missing.join(', ')}`);
  console.log(`Rows: ${counts.reduce((sum, [, n]) => sum + n, 0)} across ${tables.length} tables`);
  for (const [name, n] of counts) if (n) console.log(`  ${name.padEnd(32)} ${n}`);

  const failed = integrity.join() !== 'ok' || foreignKeys.length > 0 || errors.length > 0;
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
