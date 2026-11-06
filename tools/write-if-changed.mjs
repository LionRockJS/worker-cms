// ============================================================
// Write a generated file only when its content actually changed.
//
// Every generator here is deterministic: run twice with the same inputs and it
// produces the same bytes. Writing them anyway still bumps mtime, and that is
// not free — `wrangler dev` re-runs the `[build]` command in wrangler.toml
// whenever anything under its watch_dir (./src) changes, and build:features
// writes src/generated/*.ts. An unconditional write therefore made the dev
// server rebuild forever: build -> touches src/generated -> watcher fires ->
// build.
//
// Skipping the no-op write breaks that loop at the source, so the watcher only
// ever reacts to edits a human made.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes `contents` to `file` unless the file already holds exactly that.
 * Returns true when it wrote. `contents` may be a string or a Buffer.
 */
export function writeIfChanged(file, contents) {
  const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  let current = null;
  try {
    current = readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current && Buffer.compare(current, next) === 0) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
  return true;
}
