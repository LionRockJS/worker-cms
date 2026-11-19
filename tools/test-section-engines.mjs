import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginSections } from './build-plugin-sections.mjs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { compileSections } from './compile-sections.mjs';

const asset = name => readFileSync(new URL('../src/core/views/assets/' + name, import.meta.url));

test('JSON renders ordered mixed sections and lazily loads each required script once', async () => {
  const files = new Map([
    ['assets/client-render.js', asset('client-render.js')],
    ['assets/liquid.browser.min.js', asset('liquid.browser.min.js')],
    ['sections/card.ejs', '<b><%= title %></b>'],
    ['sections/list.hbs', '{{#each section.blocks}}<i>{{settings.label}}</i>{{/each}}'],
    ['sections/footer.liquid', '<em>{{ title }}</em>'],
  ]);
  compileSections(files);
  const sections = {
    card: { type: 'card' },
    list: { type: 'list', blocks: { first: { settings: { label: '{{ title }}' } } }, block_order: ['first'] },
    footer: { type: 'footer' },
  };
  const requests = [];
  const document = {
    getElementById: () => null,
    createElement: () => ({}),
    head: { appendChild(script) {
      requests.push(script.src);
      document.currentScript = script;
      runInContext(files.get(script.src.slice(1)).toString(), context);
      document.currentScript = null;
      script.onload();
    } },
  };
  const context = createContext({ document, console, fetch: async url => {
    return new Response(files.get(url.slice('/admin/views/'.length)));
  } }, { codeGeneration: { strings: false, wasm: false } });
  context.window = context;
  const renderer = files.get('assets/client-render.js').toString();
  runInContext(renderer.replace('  main();', '  globalThis.render = renderView;'), context);
  async function render(order) {
    files.set('templates/' + order.join('-') + '.json', JSON.stringify({ sections, order }));
    return context.render('/templates/' + order.join('-') + '.json', { title: 'A & B', sectionComments: false });
  }

  assert.deepEqual(requests, []);
  assert.equal(await render(['card']), '<b>A &amp; B</b>');
  assert.deepEqual(requests, ['/assets/sections/card.ejs.js']);
  assert.equal(await render(['list', 'footer', 'card']), '<i>A &amp; B</i>\n<em>A &amp; B</em>\n<b>A &amp; B</b>');
  assert.deepEqual(requests, [
    '/assets/sections/card.ejs.js', '/assets/liquid.browser.min.js',
    '/assets/handlebars.runtime.min.js', '/assets/sections/list.hbs.js',
  ]);
});

test('assembly rejects ambiguous section types across extensions', () => {
  assert.throws(() => compileSections(new Map([
    ['sections/title.liquid', ''], ['sections/title.handlebars', ''],
  ])), /Duplicate section type: title/);
});

test('plugin JSON loads only its own approved section assets on first use', async t => {
  const viewsDir = mkdtempSync(join(tmpdir(), 'cms-plugin-sections-'));
  t.after(() => rmSync(viewsDir, { recursive: true, force: true }));
  mkdirSync(join(viewsDir, 'sections'));
  writeFileSync(join(viewsDir, 'sections/card.ejs'), '<b><%= title %></b>');
  writeFileSync(join(viewsDir, 'sections/list.handlebars'), '<i>{{section.settings.label}}</i>');
  writeFileSync(join(viewsDir, 'sections/footer.liquid'), '<em>{{title}}</em>');
  const declarations = buildPluginSections(viewsDir);
  assert.deepEqual(declarations.map(a => a.path), ['/assets/sections/card.ejs.js', '/assets/sections/list.handlebars.js']);
  const digest = bytes => 'sha384-' + createHash('sha384').update(bytes).digest('base64');
  const prefix = '/admin/plugins/example';
  const host = new Map([
    ['assets/client-render.js', asset('client-render.js')],
    ['assets/liquid.browser.min.js', asset('liquid.browser.min.js')],
  ]);
  compileSections(host, true);
  const approvals = declarations.map(({ path }) => ({
    path, revision: 'plugin1', integrity: digest(readFileSync(join(viewsDir, path))),
  }));
  const payload = {
    bodyView: { plugin: true, viewBasePath: prefix + '/views',
      sectionAssets: [...declarations.map(a => a.path), '/assets/sections/other.ejs.js'],
    },
    approvedPluginAssets: {
      example: approvals,
      other: [{ ...approvals[0], path: '/assets/sections/other.ejs.js' }],
    },
    nonce: 'page-nonce', viewRevision: 'host1',
  };
  const scripts = [];
  let order = [];
  const sections = {
    card: { type: 'card' }, second: { type: 'card' },
    list: { type: 'list', settings: { label: '{{title}}' } },
    footer: { type: 'footer' }, other: { type: 'other' },
  };
  const document = {
    getElementById: () => ({ textContent: JSON.stringify(payload) }),
    createElement: () => ({}),
    head: { appendChild(script) {
      scripts.push(script);
      const { pathname } = new URL(script.src, 'https://cms.example');
      const bytes = pathname.startsWith(prefix + '/assets/')
        ? readFileSync(join(viewsDir, pathname.slice(prefix.length)))
        : host.get(pathname.slice(1));
      if (script.integrity && script.integrity !== digest(bytes)) return script.onerror();
      document.currentScript = script;
      runInContext(bytes.toString(), context);
      document.currentScript = null;
      script.onload();
    } },
  };
  const context = createContext({ document, console, URLSearchParams, fetch: async url => {
    const { pathname } = new URL(url, 'https://cms.example');
    let body;
    if (pathname.startsWith(prefix + '/views/templates/')) body = JSON.stringify({ sections, order });
    if (pathname === prefix + '/views/sections/footer.liquid') body = readFileSync(join(viewsDir, 'sections/footer.liquid'));
    return new Response(body, { status: body ? 200 : 404, headers: { 'x-cms-view-source': 'plugin' } });
  } }, { codeGeneration: { strings: false, wasm: false } });
  context.window = context;
  const renderer = host.get('assets/client-render.js').toString();
  runInContext(renderer.replace('  main();', '  globalThis.render = path => withViewBasePath(payload.bodyView.viewBasePath, () => renderView(path, {title: "A & B", sectionComments: false}));'), context);
  async function render(keys) {
    order = keys;
    return context.render('/templates/' + keys.join('-') + '.json');
  }

  assert.equal(await render(['card', 'second']), '<b>A &amp; B</b>\n<b>A &amp; B</b>');
  assert.deepEqual(scripts.map(s => s.src), [prefix + approvals[0].path + '?r=plugin1']);
  // The approved URL can fail to load, e.g. when a plugin redeploy changes its bytes.
  writeFileSync(join(viewsDir, approvals[1].path), '// changed');
  await assert.rejects(render(['list']), /Unable to load/);
  buildPluginSections(viewsDir);
  assert.equal(await render(['list', 'footer', 'card']), '<i>A &amp; B</i>\n<em>A &amp; B</em>\n<b>A &amp; B</b>');
  assert.deepEqual(scripts.map(s => s.src), [
    prefix + approvals[0].path + '?r=plugin1', '/assets/liquid.browser.min.js?r=host1',
    '/assets/handlebars.runtime.min.js?r=host1', prefix + approvals[1].path + '?r=plugin1',
    prefix + approvals[1].path + '?r=plugin1',
  ]);
  assert.deepEqual(scripts.filter(s => s.integrity).map(s => s.integrity), [approvals[0].integrity, approvals[1].integrity, approvals[1].integrity]);
  assert.ok(scripts.every(s => s.nonce === payload.nonce));
  await assert.rejects(render(['other']), /requires asset approval/);
  assert.equal(scripts.length, 5);
});
