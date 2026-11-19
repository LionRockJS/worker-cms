// Run on the plugin developer's machine before deploying its views directory.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSectionAssets, sectionExtensions } from './compile-sections.mjs';
import { writeIfChanged } from './write-if-changed.mjs';

export function buildPluginSections(viewsDir) {
  const files = new Map();
  function collect(dir) {
    for (const entry of readdirSync(path.join(viewsDir, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = dir + '/' + entry.name;
      if (entry.isDirectory()) collect(relative);
      else if (entry.isFile() && sectionExtensions.includes(path.extname(relative).slice(1))) {
        files.set(relative, readFileSync(path.join(viewsDir, relative)));
      }
    }
  }
  collect('sections');
  const { assets } = compileSectionAssets(files);
  for (const [relative, bytes] of assets) writeIfChanged(path.join(viewsDir, relative), bytes);
  return [...assets.keys()].sort().map(relative => ({ path: '/' + relative }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('Usage: node tools/build-plugin-sections.mjs <plugin-views-directory>');
  console.log(JSON.stringify(buildPluginSections(process.argv[2]), null, 2));
}
