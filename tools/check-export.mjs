// ============================================================
// Exit and restore drill for a D1 export (W10, A.5.23; W11, A.8.13, A.5.30).
//
// An exit plan is only real if the data comes out in a form something other
// than Cloudflare can use. `wrangler d1 export` writes plain SQL; this loads
// that file into a stock SQLite database, checks its integrity and foreign
// keys, compares its schema with a fresh install of the current tree, and
// counts rows per table so the result can be reconciled with the source.
//
// A backup is only real if what the database points at came back with it. Given
// a copy of the media bucket, every media_files row must have its object at the
// recorded size. Given a copy of the audit bucket, every audit_seals row must
// have its segment, the segment must hash to the sealed value, and the seals
// must chain end to end. Each step is timed, as evidence for the recovery-time
// objective.
//
// It reads files and writes nothing. Run the export with the deployment's own
// credentials, keep the file and this output in the restricted evidence system,
// and never commit an export: it holds every row, personal data included.
//
// Usage:
//   npx wrangler d1 export <database> --remote --output <file.sql>
//   node tools/check-export.mjs --file <file.sql> [--db private|published]
//                               [--media <dir>] [--audit <dir>]
// <dir> is a local copy of the bucket, one file per object at its key.
// Exit 1 if the file does not load, fails an integrity check, its schema
// differs from a fresh install, or a referenced object is missing or wrong.
// ============================================================

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { DATABASES, applyFile, compare, filesNow, freshDatabase, isNumbered, snapshot } from './check-upgrade-path.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const args = { file: null, db: 'private', media: null, audit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--media') args.media = argv[++i];
    else if (argv[i] === '--audit') args.audit = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.file) throw new Error('--file <export.sql> is required');
  if (!(args.db in DATABASES)) throw new Error('--db must be private or published');
  return args;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** The file holding an object's copy, or null for a key that would escape the copy. */
function objectPath(dir, key) {
  const root = path.resolve(dir);
  const file = path.resolve(root, key);
  return file.startsWith(root + path.sep) ? file : null;
}

function statOrNull(file) {
  try { return statSync(file); } catch { return null; }
}

function listFiles(dir, prefix = '') {
  return readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(dir, key) : [key];
  });
}

/** Every media_files row has its object, at the size recorded on upload. */
function checkMedia(db, dir) {
  const errors = [];
  if (!hasTable(db, 'media_files')) return { errors: ['media_files is not in the export'], checked: 0, unreferenced: [] };
  const rows = db.prepare('SELECT key, size FROM media_files ORDER BY key').all();
  for (const { key, size } of rows) {
    const file = objectPath(dir, key);
    const stat = file && statOrNull(file);
    if (!file) errors.push(`media key ${key} escapes the copy`);
    else if (!stat) errors.push(`media object ${key} is missing`);
    else if (size > 0 && stat.size !== size) errors.push(`media object ${key} is ${stat.size} bytes, recorded as ${size}`);
  }
  // Plugin files and thumbnails live in the same bucket with no row of their
  // own, so an unreferenced object is something to look at, not a failure.
  const referenced = new Set(rows.map((row) => row.key));
  const unreferenced = listFiles(dir).filter((key) => !referenced.has(key));
  return { errors, checked: rows.length, unreferenced };
}

/** Every seal has its segment, the segment hashes to the seal, and the seals chain. */
function checkAudit(db, dir) {
  const errors = [];
  if (!hasTable(db, 'audit_seals')) return { errors: ['audit_seals is not in the export'], checked: 0, events: 0, unsealed: [] };
  const seals = db.prepare(`SELECT first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key
    FROM audit_seals ORDER BY id`).all();
  let previous = null;
  let events = 0;
  for (const seal of seals) {
    const where = `seal ${seal.first_seq}-${seal.last_seq}`;
    if ((seal.prev_hash ?? null) !== (previous?.rolling_hash ?? null)) errors.push(`${where} does not link to the seal before it`);
    if (seal.rolling_hash !== sha256(`${seal.prev_hash ?? ''}${seal.segment_hash}`)) errors.push(`${where} has a wrong rolling hash`);
    if (previous && seal.first_seq !== previous.last_seq + 1) errors.push(`${where} does not follow ${previous.last_seq}: events in between are unaccounted for`);
    previous = seal;

    const file = objectPath(dir, seal.r2_key);
    const stat = file && statOrNull(file);
    if (!stat) { errors.push(`${where}: segment ${seal.r2_key} is missing`); continue; }
    let text;
    try { text = gunzipSync(readFileSync(file)).toString('utf8'); } catch { errors.push(`${where}: segment is not valid gzip`); continue; }
    if (sha256(text) !== seal.segment_hash) errors.push(`${where}: segment does not hash to the sealed value`);
    const lines = text.split('\n').filter(Boolean).length;
    if (lines !== seal.event_count) errors.push(`${where}: segment holds ${lines} events, sealed as ${seal.event_count}`);
    events += lines;
  }
  // A sweep that wrote its object but never sealed it leaves one behind, which
  // the next run reconciles; a backup taken in between holds it too.
  const sealed = new Set(seals.map((seal) => seal.r2_key));
  const unsealed = listFiles(dir).filter((key) => !sealed.has(key));
  return { errors, checked: seals.length, events, unsealed };
}

function review(keys, why) {
  for (const key of keys.slice(0, 10)) console.log(`  REVIEW ${key} ${why}`);
  if (keys.length > 10) console.log(`  REVIEW ...and ${keys.length - 10} more`);
}

function timed(timings, label, work) {
  const started = performance.now();
  const result = work();
  timings.push([label, performance.now() - started]);
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const timings = [];
  const restored = freshDatabase();
  timed(timings, 'load export', () => applyFile(restored, args.file, readFileSync(args.file, 'utf8')));

  const integrity = restored.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
  const foreignKeys = restored.prepare('PRAGMA foreign_key_check').all();

  const { dir } = DATABASES[args.db];
  const numbered = filesNow(dir).filter(isNumbered);
  const fresh = freshDatabase();
  for (const name of numbered) applyFile(fresh, `${dir}/${name}`, readFileSync(path.join(rootDir, dir, name), 'utf8'));
  const { errors, warnings } = timed(timings, 'integrity and schema', () => compare(snapshot(restored), snapshot(fresh), 'in the export'));

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

  let objectErrors = 0;
  if (args.media) {
    const media = timed(timings, 'media objects', () => checkMedia(restored, args.media));
    console.log(`Media: ${media.checked} referenced object(s), ${media.errors.length} problem(s), ${media.unreferenced.length} unreferenced`);
    for (const error of media.errors) console.log(`  ERROR ${error}`);
    review(media.unreferenced, 'has no media_files row');
    objectErrors += media.errors.length;
  }
  if (args.audit) {
    const audit = timed(timings, 'audit archive', () => checkAudit(restored, args.audit));
    console.log(`Audit archive: ${audit.checked} seal(s), ${audit.events} archived event(s), ${audit.errors.length} problem(s), ${audit.unsealed.length} unsealed`);
    for (const error of audit.errors) console.log(`  ERROR ${error}`);
    review(audit.unsealed, 'has no audit_seals row');
    objectErrors += audit.errors.length;
  }
  console.log(`Timings: ${timings.map(([label, ms]) => `${label} ${Math.round(ms)} ms`).join('; ')}`);

  const failed = integrity.join() !== 'ok' || foreignKeys.length > 0 || errors.length > 0 || objectErrors > 0;
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
