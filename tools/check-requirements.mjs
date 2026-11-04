// ============================================================
// Security requirements to regression tests (W14, A.8.25, A.8.29).
//
// compliance/security-requirements.json names, for each security requirement,
// the tests that prove it. This fails when a named test is gone, so renaming
// or deleting one changes the register in the same review, and when a
// requirement cites a control the register does not hold. It reads source;
// whether the tests pass is `vitest run`'s job. It also fails when a workflow
// uses an action by tag rather than a full commit SHA, since a moved tag runs
// code nobody reviewed with CI's token.
//
// Usage: node tools/check-requirements.mjs [--quiet]
// ============================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const quiet = process.argv.includes('--quiet');
const read = (file) => JSON.parse(readFileSync(path.join(rootDir, file), 'utf8'));

/** The literal titles passed to it(), test() and their .each() forms. */
function testTitles(source) {
  const pattern = /\b(?:it|test)(?:\.(?:each\([\s\S]*?\)|skip|only|concurrent))?\(\s*(['"`])((?:\\.|(?!\1).)+)\1/g;
  return new Set([...source.matchAll(pattern)].map((match) => match[2].replace(/\\(.)/g, '$1')));
}

function check() {
  const errors = [];
  const { requirements } = read('compliance/security-requirements.json');
  const controls = new Set(read('compliance/control-register.json').controls.map((control) => control.id));
  const titles = new Map();
  const ids = new Set();
  let tests = 0;
  for (const requirement of requirements) {
    const where = requirement.id ?? '(no id)';
    if (!/^SR-\d{2,}$/.test(requirement.id ?? '')) errors.push(`${where}: id must look like SR-01`);
    if (ids.has(requirement.id)) errors.push(`${where}: duplicate id`);
    ids.add(requirement.id);
    if (!requirement.requirement?.trim()) errors.push(`${where}: no requirement text`);
    if (!requirement.controls?.length) errors.push(`${where}: no controls`);
    for (const control of requirement.controls ?? []) {
      if (!controls.has(control)) errors.push(`${where}: control ${control} is not in compliance/control-register.json`);
    }
    if (!requirement.tests?.length) errors.push(`${where}: no tests`);
    for (const { file, title } of requirement.tests ?? []) {
      tests++;
      if (!titles.has(file)) {
        const full = path.join(rootDir, file ?? '');
        titles.set(file, file?.startsWith('test/') && existsSync(full) ? testTitles(readFileSync(full, 'utf8')) : null);
      }
      const found = titles.get(file);
      if (!found) errors.push(`${where}: test file ${file} does not exist`);
      else if (!found.has(title)) errors.push(`${where}: ${file} has no test titled "${title}"`);
    }
  }
  checkActionPins(errors);
  return { errors, requirements: requirements.length, tests };
}

function checkActionPins(errors) {
  const dir = path.join(rootDir, '.github/workflows');
  const files = existsSync(dir) ? readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)) : [];
  for (const file of files) {
    for (const [index, line] of readFileSync(path.join(dir, file), 'utf8').split('\n').entries()) {
      const use = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
      if (!use || use[1].startsWith('./')) continue;
      if (!/@[0-9a-f]{40}$/.test(use[1])) errors.push(`.github/workflows/${file}:${index + 1}: ${use[1]} is not pinned to a commit SHA`);
    }
  }
}

const { errors, requirements, tests } = check();
for (const error of errors) console.error(`ERROR requirements: ${error}`);
if (!quiet || errors.length) console.log(`Security requirements: ${requirements}, linked to ${tests} tests${errors.length ? `, ${errors.length} problem(s)` : ''}.`);
process.exitCode = errors.length ? 1 : 0;
