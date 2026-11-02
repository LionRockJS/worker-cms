// ============================================================
// Asset inventory and control register check (W8, A.5.9).
//
// compliance/asset-inventory.json is only useful while it matches the code.
// This fails when a binding, variable or secret in the Env type, a binding in
// wrangler.example.toml, or a D1 table in either baseline has no inventory
// entry, or when an entry no longer exists in source. It also validates the
// shape of compliance/control-register.json. Adding a resource therefore
// forces the inventory change into the same commit — the update process the
// standard asks to be demonstrated.
//
// With --config <wrangler.toml>, it also reconciles one deployment's config
// against the inventory and prints which bindings that deployment declares.
// It prints names only, never values, and writes nothing: keep the output in
// the deployment's restricted evidence system, not in this repository.
//
// Usage:
//   node tools/check-inventory.mjs [--config <path>] [--quiet]
// ============================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(path.join(rootDir, file), 'utf8');

const ASSET_KINDS = new Set(['d1', 'r2', 'assets', 'version-metadata', 'service', 'images', 'durable-object', 'queue',
  'rate-limiter', 'secret', 'var', 'credential-file', 'table', 'supplier', 'environment']);
const BINDING_KINDS = new Set(['d1', 'r2', 'assets', 'version-metadata', 'service', 'images', 'durable-object', 'queue',
  'rate-limiter', 'secret', 'var']);
const REQUIRED = /^(always|optional|regulated|feature:[a-z-]+)$/;
const SOURCE_STATUS = new Set(['implemented', 'partial', 'supporting', 'gap', 'not-evidenced', 'not-assessed']);
const EXTERNAL_STATUS = new Set(['not-evidenced', 'partial', 'verified']);
const CONTROL_GROUPS = { original: 27, 'repo-led': 13, hybrid: 19 };

function parseArgs(argv) {
  const args = { config: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--quiet') args.quiet = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

/** Field names of `export interface Env { ... }` in src/types.ts. */
function envFields() {
  const source = read('src/types.ts');
  const start = source.indexOf('export interface Env {');
  if (start < 0) throw new Error('src/types.ts: Env interface not found');
  const body = source.slice(start, source.indexOf('\n}', start));
  return new Set([...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\??:/gm)].map((match) => match[1]));
}

/** Binding and [vars] names in a wrangler TOML file, commented examples included when asked. */
function configNames(text, includeCommented) {
  const prefix = includeCommented ? '(?:#\\s*)?' : '';
  // Durable Object and unsafe (rate limiter) bindings use `name =`.
  const bindings = [...text.matchAll(new RegExp(`^${prefix}(?:binding|name)\\s*=\\s*"([A-Z][A-Z0-9_]*)"`, 'gm'))].map((m) => m[1]);
  const vars = [];
  let inVars = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) { inVars = section[1].trim() === 'vars'; continue; }
    if (!inVars) continue;
    const key = new RegExp(`^${prefix}([A-Z][A-Z0-9_]*)\\s*=`).exec(line.trim());
    if (key) vars.push(key[1]);
  }
  return { bindings: new Set(bindings), vars: new Set(vars) };
}

function baselineTables(file) {
  return new Set([...read(file).matchAll(/^CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/gm)].map((m) => m[1]));
}

function checkInventory(errors) {
  const inventory = JSON.parse(read('compliance/asset-inventory.json'));
  const holds = new Set(Object.keys(inventory.holds ?? {}));
  const ids = new Set();
  for (const asset of inventory.assets) {
    const where = asset.id ?? JSON.stringify(asset).slice(0, 60);
    if (!asset.id || ids.has(asset.id)) errors.push(`inventory: missing or duplicate id ${where}`);
    ids.add(asset.id);
    if (!ASSET_KINDS.has(asset.kind)) errors.push(`inventory: ${where} has unknown kind ${asset.kind}`);
    if (!asset.purpose || !asset.lifecycle) errors.push(`inventory: ${where} needs a purpose and a lifecycle`);
    if (!Array.isArray(asset.holds) || asset.holds.some((h) => !holds.has(h))) errors.push(`inventory: ${where} has an unknown holds value`);
    if (!('owner' in asset) || (asset.owner !== null && typeof asset.owner !== 'string')) errors.push(`inventory: ${where} needs an owner (null until assigned)`);
    if (asset.kind !== 'table' && asset.required !== undefined && !REQUIRED.test(asset.required)) errors.push(`inventory: ${where} has an invalid required value`);
  }

  const bindingAssets = new Map(inventory.assets.filter((a) => BINDING_KINDS.has(a.kind)).map((a) => [a.binding, a]));
  const env = envFields();
  for (const name of env) if (!bindingAssets.has(name)) errors.push(`inventory: Env.${name} has no inventory entry`);
  for (const name of bindingAssets.keys()) if (!env.has(name)) errors.push(`inventory: ${name} is inventoried but not in the Env type`);

  const example = configNames(read('wrangler.example.toml'), true);
  for (const name of [...example.bindings, ...example.vars]) {
    if (!bindingAssets.has(name)) errors.push(`inventory: wrangler.example.toml declares ${name} with no inventory entry`);
  }

  for (const [store, file] of [['DB', 'migrations/0001_initial_schema.sql'], ['PUBLISHED_DB', 'migrations/published/0001_published_schema.sql']]) {
    const tables = baselineTables(file);
    const listed = new Set(inventory.assets.filter((a) => a.kind === 'table' && a.store === store).map((a) => a.table));
    for (const table of tables) if (!listed.has(table)) errors.push(`inventory: ${store}.${table} has no inventory entry`);
    for (const table of listed) if (!tables.has(table)) errors.push(`inventory: ${store}.${table} is inventoried but not in ${file}`);
  }
  return { inventory, bindingAssets };
}

function checkRegister(errors) {
  const register = JSON.parse(read('compliance/control-register.json'));
  const seen = new Set();
  const counts = Object.fromEntries(Object.keys(CONTROL_GROUPS).map((group) => [group, 0]));
  for (const control of register.controls) {
    const where = control.id ?? '(no id)';
    if (!/^A\.[5-8]\.\d{1,2}$/.test(control.id ?? '') || seen.has(control.id)) errors.push(`register: invalid or duplicate id ${where}`);
    seen.add(control.id);
    if (!(control.group in CONTROL_GROUPS)) errors.push(`register: ${where} has unknown group ${control.group}`);
    else counts[control.group]++;
    if (!SOURCE_STATUS.has(control.source)) errors.push(`register: ${where} has unknown source status ${control.source}`);
    if (!EXTERNAL_STATUS.has(control.external)) errors.push(`register: ${where} has unknown external status ${control.external}`);
    if (typeof control.effective !== 'boolean') errors.push(`register: ${where} needs effective true or false`);
    // Effectiveness is a reviewed judgment, so it needs both people on record.
    if (control.effective && (!control.owner || !control.reviewer)) errors.push(`register: ${where} is effective without an owner and reviewer`);
    if (control.effective && control.external !== 'verified') errors.push(`register: ${where} is effective without verified external evidence`);
    if (!control.title || !control.closure) errors.push(`register: ${where} needs a title and closure evidence`);
  }
  for (const [group, expected] of Object.entries(CONTROL_GROUPS)) {
    if (counts[group] !== expected) errors.push(`register: expected ${expected} ${group} controls, found ${counts[group]}`);
  }
  return register;
}

function reconcile(configPath, bindingAssets) {
  const config = configNames(readFileSync(configPath, 'utf8'), false);
  const declared = new Set([...config.bindings, ...config.vars]);
  console.log(`\nDeployment config ${path.basename(configPath)} (names only):`);
  const rows = [...bindingAssets.values()].map((asset) => {
    const state = asset.kind === 'secret' ? 'secret: verify with wrangler secret list'
      : declared.has(asset.binding) ? 'declared' : 'not declared';
    return { asset, state };
  });
  for (const { asset, state } of rows) {
    const flag = state !== 'not declared' ? ''
      : asset.required === 'always' ? '  <- required'
      : asset.required === 'regulated' ? '  <- required in regulated mode' : '';
    console.log(`  ${asset.binding.padEnd(30)} ${(asset.required ?? '').padEnd(16)} ${state}${flag}`);
  }
  for (const name of declared) if (!bindingAssets.has(name)) console.log(`  ${name.padEnd(30)} ${'?'.padEnd(16)} declared but not inventoried`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const { inventory, bindingAssets } = checkInventory(errors);
  const register = checkRegister(errors);
  for (const error of errors) console.error(`ERROR ${error}`);
  if (!args.quiet || errors.length) {
    const unowned = inventory.assets.filter((asset) => !asset.owner).length;
    const unassigned = register.controls.filter((control) => !control.owner).length;
    console.log(`Inventory: ${inventory.assets.length} assets, ${unowned} without an owner. Register: ${register.controls.length} controls, ${unassigned} without an owner.`);
  }
  if (args.config) reconcile(args.config, bindingAssets);
  process.exitCode = errors.length ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
