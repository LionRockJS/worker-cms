import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ejs from 'ejs';
import handlebars from 'handlebars';

const require = createRequire(import.meta.url);
export const sectionExtensions = ['liquid', 'hbs', 'handlebars', 'ejs'];

// Compile into memory first so an invalid or ambiguous section fails before writing assets.
export function compileSectionAssets(files) {
  const types = new Set();
  const compiled = [];
  const assets = new Map();
  for (const [path, source] of files) {
    if (!path.startsWith('sections/')) continue;
    const ext = path.slice(path.lastIndexOf('.') + 1);
    if (!sectionExtensions.includes(ext)) continue;
    const type = path.slice('sections/'.length, -(ext.length + 1));
    if (types.has(type)) throw new Error('Duplicate section type: ' + type);
    types.add(type);
    if (ext === 'liquid') continue;

    const render = ext === 'ejs'
      ? ejs.compile(source.toString(), { client: true, compileDebug: false, filename: path }).toString()
      : 'Handlebars.template(' + handlebars.precompile(source.toString()) + ')';
    assets.set('assets/' + path + '.js', Buffer.from('document.currentScript.renderSection = ' + render + ';\n'));
    compiled.push([type, ext]);
  }
  return { compiled, assets };
}

export function compileSections(files, pluginsEnabled = false) {
  const { compiled, assets } = compileSectionAssets(files);
  for (const [type, ext] of compiled) files.delete('sections/' + type + '.' + ext);
  if (pluginsEnabled || compiled.some(([, ext]) => ext !== 'ejs')) {
    assets.set('assets/handlebars.runtime.min.js', readFileSync(require.resolve('handlebars/dist/handlebars.runtime.min.js')));
  }

  for (const [path, contents] of assets) {
    if (files.has(path)) throw new Error('Generated section asset collides with ' + path);
    files.set(path, contents);
  }

  const renderer = 'assets/client-render.js';
  const marker = '/* compiled section entries */ []';
  const source = files.get(renderer).toString();
  if (!source.includes(marker)) throw new Error('Missing section registry in ' + renderer);
  files.set(renderer, Buffer.from(source.replace(marker, () => JSON.stringify(compiled))));
}
