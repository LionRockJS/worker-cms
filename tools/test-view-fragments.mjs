import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { assembleViews } from './build-views.mjs';

test('publishing controls assemble only into publish-enabled shared screens', async () => {
  const browser = {};
  runInNewContext(assembleViews({}).get('assets/liquid.browser.min.js').toString(), browser);
  const liquid = new browser.liquidjs.Liquid();
  liquid.registerFilter('t', (key) => key);
  const controls = {
    dashboard: ['action="{{ page.publishAction }}"', 'action="{{ page.pullAction }}"', 'value="unpublish"', 'data-live-weight', 'for filter in statusFilters'],
    'advanced-search': ['Live weight is {{ page.liveWeight }}'],
    editor: ['data-publish-schedule-toggle', 'view_strings.sections_editor.save_and_publish', 'view_strings.sections_editor.live'],
    tags: ['/admin/tags/sync-published'],
  };
  for (const publish of [false, true]) {
    const views = assembleViews({ publish, search: true });
    for (const [screen, markers] of Object.entries(controls)) {
      const section = views.get('sections/' + screen + '.liquid').toString();
      assert.ok(!section.includes('feature_fragment'));
      for (const marker of markers) assert.equal(section.includes(marker), publish, marker);
    }
    const layout = views.get('layout/default.liquid').toString();
    assert.equal(layout.includes('[data-weight-drift]'), publish);
    assert.match(layout, /input.value = row.weight/);
    const editor = await liquid.parseAndRender(views.get('sections/editor.liquid').toString(), {
      publishEnabled: publish,
      canPublishPage: true,
      page: { start: '2030-01-01 08:30:59', end: '2030-01-02 12:05:00' },
    });
    assert.equal(editor.includes('value="2030-01-01T08:30"'), publish);
    assert.equal(editor.includes('value="2030-01-02T12:05"'), publish);
    const strings = JSON.parse(views.get('locales/en.json')).view_strings;
    assert.equal('sections_editor.save_and_publish' in strings, publish);
    assert.equal('sections_editor.live' in strings, publish);
    assert.ok(![...views.keys()].some(path => path.startsWith('fragments/')));
  }
});

test('dashboard and editor controls follow the search and media switches independently', async () => {
  const browser = {};
  runInNewContext(assembleViews({}).get('assets/liquid.browser.min.js').toString(), browser);
  const liquid = new browser.liquidjs.Liquid();
  liquid.registerFilter('t', (key) => key);

  for (const search of [false, true]) {
    for (const media of [false, true]) {
      const views = assembleViews({ search, media, publish: true });
      const render = (path, data) => liquid.parseAndRender(views.get(path).toString(), data);
      const dashboard = await render('sections/dashboard.liquid', {
        hasPages: true,
        hasRowControls: true,
        canReorder: true,
        hasSelectablePages: search,
        publishEnabled: true,
        searchAction: '/admin/advanced-search',
        bulkAction: '/admin/advanced-search/bulk',
        pages: [{ id: 1, name: 'Draft page', isSelectable: true, editHref: '/admin/pages/1/edit' }],
      });
      for (const marker of ['id="dashboard_search"', 'data-dashboard-bulk-form', 'data-dashboard-bulk-checkbox', 'value="publish"']) {
        assert.equal(dashboard.includes(marker), search, marker);
      }
      assert.match(dashboard, /data-reorder-handle/);
      assert.match(dashboard, /href="\/admin\/pages\/1\/edit"/);

      const fields = await Promise.all(['picture', 'file'].map(kind => render(`snippets/pagefield/${kind}/basic.liquid`, {
        field: { id: kind, inputName: kind, value: `https://example.com/${kind}` },
      })));
      const editor = await render('sections/editor.liquid', {
        action: '/admin/pages/1',
        isEdit: true,
        structuredBlock: fields.join(''),
      });
      assert.match(editor, /action="\/admin\/pages\/1" data-editor-form/);
      assert.match(editor, /data-picture-preview src="https:\/\/example.com\/picture"/);
      assert.match(editor, /href="https:\/\/example.com\/file"/);
      assert.equal((editor.match(/data-picture-url/g) ?? []).length, 2);
      assert.equal((editor.match(/data-picture-file/g) ?? []).length, media ? 2 : 0);
      assert.equal(views.has('assets/field-upload.js'), media);
      assert.equal(views.has('assets/media-preview.js'), media);
      assert.ok(views.has('assets/picture-field.js'));
    }
  }
});

test('media owns the /media-preview rewrite of picture previews', () => {
  for (const media of [false, true]) {
    const views = assembleViews({ media });
    const core = views.get('assets/picture-field.js').toString();
    assert.doesNotMatch(core, /media-preview/);
    const preview = { dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, removeAttribute() {} };
    const root = {
      dataset: {},
      querySelector: (selector) => ({
        '[data-picture-url]': { value: '/media/pictures/a.png?v=1', addEventListener() {} },
        '[data-picture-preview]': preview,
      })[selector] ?? null,
    };
    const browser = {
      URL,
      location: { origin: 'https://cms.test' },
      document: { querySelectorAll: () => [root] },
    };
    browser.window = browser;
    runInNewContext(core, browser);
    assert.equal(preview.src, 'https://cms.test/media/pictures/a.png?v=1');
    if (media) {
      const asset = views.get('assets/media-preview.js').toString();
      runInNewContext(asset, browser);
      runInNewContext(asset, browser);
      assert.equal(preview.src, '/media-preview/pictures/a.png?v=1');
    }
    assert.equal(preview.dataset.originalSrc, '/media/pictures/a.png?v=1');
  }
});

test('credits owns wallet panels, sidebar balances, and the visibility control', () => {
  for (const credits of [false, true]) {
    const views = assembleViews({ credits });
    const profile = views.get('sections/profile.liquid').toString();
    const layout = views.get('layout/default.liquid').toString();
    const settings = views.get('sections/menu-settings.liquid').toString();
    assert.equal(profile.includes('for wallet in creditWallets'), credits);
    assert.equal(layout.includes('for wallet in sidebarWallets'), credits);
    assert.equal(settings.includes('name="show_credits"'), credits);
    assert.match(profile, /action="\/admin\/profile\/disable"/);
    assert.match(layout, /data-sidebar-footer-controls/);
    assert.match(settings, /name="app_name"/);

    const catalog = JSON.parse(views.get('locales/en.json').toString());
    assert.equal('credits' in catalog.settings, credits);
    assert.equal('shared_pool_balance' in catalog.profile, credits);
    assert.equal('shared' in catalog.shell, credits);
  }
});

test('trash controls follow the trash switch when search is installed', () => {
  for (const trash of [false, true]) {
    const views = assembleViews({ trash, search: true, publish: true });
    const dashboard = views.get('sections/dashboard.liquid').toString();
    const editor = views.get('sections/editor.liquid').toString();
    const search = views.get('sections/advanced-search.liquid').toString();
    assert.equal(dashboard.includes('action="{{ page.deleteAction }}"'), trash);
    assert.equal(editor.includes('data-delete-button'), trash);
    assert.equal(views.has('assets/editor-trash.js'), trash);
    const editorScript = views.get('assets/editor.js').toString();
    assert.doesNotMatch(editorScript, /\[data-delete-button\]/);
    assert.match(editorScript, /\[data-version-delete-button\]/);
    assert.match(editorScript, /\[data-clean-versions-button\]/);
    assert.equal(dashboard.includes('value="delete"'), trash);
    assert.equal(search.includes('value="delete"'), trash);
    assert.match(dashboard, /value="replace_text"/);
    assert.match(editor, /data-editor-form/);
  }
});

test('trash confirms page deletion once and cancels a declined click', () => {
  const asset = assembleViews({ trash: true }).get('assets/editor-trash.js').toString();
  const listeners = [];
  const messages = [];
  let accepted = false;
  let prevented = 0;
  const button = {
    dataset: {},
    getAttribute: () => 'Move this page to trash?',
    addEventListener: (type, listener) => {
      assert.equal(type, 'click');
      listeners.push(listener);
    },
  };
  const browser = {
    document: { querySelector: () => button },
    confirm: (message) => {
      messages.push(message);
      return accepted;
    },
  };
  runInNewContext(asset, browser);
  runInNewContext(asset, browser);
  assert.equal(listeners.length, 1);

  const event = { preventDefault: () => { prevented++; } };
  listeners[0](event);
  accepted = true;
  listeners[0](event);
  assert.deepEqual(messages, ['Move this page to trash?', 'Move this page to trash?']);
  assert.equal(prevented, 1);
});

// The read-only page view and the page-access form used to be HTML built in
// TypeScript. Render the Liquid that replaced them with the browser engine's
// settings (auto-escape on, snippets resolved from the assembled tree).
function browserLiquid(views) {
  const browser = {};
  runInNewContext(views.get('assets/liquid.browser.min.js').toString(), browser);
  const read = (file) => {
    const source = views.get(file.replace(/^\//, ''));
    if (!source) throw new Error('missing view ' + file);
    return source.toString();
  };
  const liquid = new browser.liquidjs.Liquid({
    outputEscape: 'escape', extname: '.liquid', root: ['sections', 'snippets'], relativeReference: false,
    fs: {
      readFileSync: read, readFile: async (file) => read(file),
      existsSync: (file) => views.has(file), exists: async (file) => views.has(file),
      contains: () => true, containsSync: () => true,
      resolve: (_root, file, ext) => (file.endsWith(ext) ? file : file + ext),
    },
  });
  liquid.registerFilter('t', (key) => `[${key}]`);
  return {
    liquid,
    dataLiquid: new browser.liquidjs.Liquid(),
    section: (name) => read('sections/' + name + '.liquid'),
  };
}

test('read view renders nested items, escapes values, and keeps the live badge HTML', async () => {
  const { liquid, section } = browserLiquid(assembleViews({}));
  const field = (label, value, extras = []) => ({ label, value, extras });
  const html = await liquid.parseAndRender(section('read'), {
    pageName: '<About>', backHref: '/admin', editHref: '/admin/pages/1/edit', pageAccessHref: '',
    readBase: '/admin/pages/1/read', versionCreatedAt: '2026-01-01 00:00:00', iconHrefPrefix: '/assets/icons.svg',
    meta: { slug: '/about', type: 'default', weight: '0', parent: '', start: '', end: '', timezone: '', editors: [], modifier: 'Ann' },
    languages: [{ value: 'en', selected: true, href: '/admin/pages/1/read?language=en' }],
    structured: {
      settings: null,
      content: {
        fields: [field('Title', 'Hello <b>', [{ key: 'read.url', value: 'https://x.test' }])],
        groups: [{ name: 'Links', rows: [{ label: 'Row 1', settings: null, content: {
          fields: [field('Name', '')],
          groups: [{ name: 'Nested', rows: [] }],
        } }] }],
      },
      blocks: [],
    },
    tagGroups: [],
    liveBadgeHtml: ' <span class="live">Live</span>',
    versions: [{ label: 'v1', href: '/admin/pages/1/read?version=7', active: true, live: true }],
  });
  assert.match(html, /&lt;About&gt;/);
  assert.match(html, /Hello &lt;b&gt;/);
  assert.match(html, /\[read\.url\]:<\/span> https:\/\/x\.test/);
  assert.match(html, /Row 1[\s\S]*Name[\s\S]*&mdash;[\s\S]*Nested[\s\S]*\[read\.no_items\]/);
  assert.match(html, /version=7[^>]*>v1 <span class="live">Live<\/span><\/a>/);
  assert.match(html, /\[read\.no_blocks\]/);
  assert.match(html, /\[read\.viewing_version_prefix\] 2026-01-01 00:00:00/);
  assert.match(html, /href="\/admin\/pages\/1\/edit"/);
  assert.match(html, /\[view_strings\.sections_editor\.slug\][\s\S]*\/about/);
  assert.doesNotMatch(html, /\[page_access\.title\]/);
});

test('page access form keeps its mode selects, grants, and user search', async () => {
  const views = assembleViews({});
  const { liquid, dataLiquid, section } = browserLiquid(views);
  const data = {
    pageId: 5, title: 'Page access', pageName: 'P&Q', owner: 'Ann', revision: 3, mode: '640',
    action: '/admin/pages/5/access', group: 'editor', roles: ['admin', 'editor'],
    permissions: [{ key: 'owner', digit: '6' }, { key: 'group', digit: '4' }, { key: 'others', digit: '0' }],
    grants: [{ id: 9, name: 'Bo' }], legacyEditors: [{ id: 8, name: 'Cy' }],
  };
  const { header } = JSON.parse(views.get('templates/page-access.json').toString()).sections;
  const description = await dataLiquid.parseAndRender(header.settings.description, data);
  const heading = await liquid.parseAndRender(section(header.type), { section: { settings: { description } } });
  assert.match(heading, />P&amp;Q<\/p>/);

  const enabled = await liquid.parseAndRender(section('page-access'), { ...data, enabled: true });
  assert.match(enabled, /<span[^>]*>640<\/span>/);
  assert.match(enabled, /name="owner">\s*<option value="0">[^<]*<\/option>\s*<option value="4">[^<]*<\/option>\s*<option value="6" selected>/);
  assert.match(enabled, /name="group">\s*<option value="0">[^<]*<\/option>\s*<option value="4" selected>/);
  assert.match(enabled, /<option selected>editor<\/option>/);
  assert.match(enabled, /name="user_id" value="9">\s*<span[^>]*>Bo<\/span>\s*<button[^>]*name="action" value="remove"/);
  assert.match(enabled, /data-access-user-picker data-source="\/admin\/api\/users"/);
  assert.match(enabled, /id="page-access-user"[^>]*role="combobox"[^>]*aria-controls="page-access-user-results"/);
  assert.match(enabled, /id="page-access-user-results" role="listbox"/);
  assert.match(enabled, /name="user_id" value="" data-access-user-id/);
  assert.match(enabled, /name="action" value="add" disabled data-access-user-action/);
  assert.match(enabled, /name="action" value="transfer" disabled data-access-user-action/);
  assert.doesNotMatch(enabled, /legacy_user/);

  const legacy = await liquid.parseAndRender(section('page-access'), { ...data, enabled: false });
  assert.match(legacy, /\[page_access\.legacy\]/);
  assert.match(legacy, /type="checkbox" name="legacy_user" value="8"[^>]*>\s*<span>Cy<\/span>/);
  assert.match(legacy, /name="action" value="mode"\s+title="\[page_access\.enable\]"/);
  assert.match(legacy, /data-empty-text="\[page_access\.no_matching_users\]"/);
  assert.match(legacy, /name="action" value="transfer" disabled data-access-user-action/);
  assert.doesNotMatch(legacy, /name="action" value="add"/);
  assert.doesNotMatch(legacy, /\[page_access\.sharing\]/);
});

test('session keepalive ships as an asset', () => {
  assert.ok(assembleViews({}).has('assets/session-keepalive.js'));
});

test('settings export advances after a download and retries a failed next part', async () => {
  const views = assembleViews({});
  const browser = {};
  runInNewContext(views.get('assets/liquid.browser.min.js').toString(), browser);
  const liquid = new browser.liquidjs.Liquid();
  liquid.registerFilter('t', key => key);
  const html = await liquid.parseAndRender(views.get('sections/config-transfer.liquid').toString(), {
    hasExportSections: true, exportSections: [{ id: 'tags', checked: true, labelKey: 'tags' }],
  });
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const listeners = {};
  const label = { textContent: 'Download settings' };
  const button = { querySelector: () => label, setAttribute() {} };
  const status = {};
  const downloads = [];
  const file = { hidden: true, click() { downloads.push(this.download); } };
  const controls = { button, '[data-export-file]': file, '[data-export-status]': status, '[data-export-label]': label };
  const form = {
    dataset: { next: 'Download next part', complete: 'Export complete' },
    querySelector: key => controls[key], querySelectorAll: () => [],
    addEventListener(event, handler) { listeners[event] = handler; },
  };
  const part = (name, cursor) => new Response('{}', { headers: {
    'Content-Disposition': `attachment; filename="${name}"`, ...(cursor ? { 'X-Next-Cursor': cursor } : {}),
  } });
  const responses = [part('part-001.json', 'next'), new Response('Retry', { status: 503 }), part('part-002.json')];
  const requests = [];
  runInNewContext(script, {
    document: { querySelector: () => form }, FormData: class extends Map { constructor() { super(); } }, URL,
    fetch: async (_, { body }) => { requests.push(body.get('cursor')); return responses.shift(); },
  });
  const click = () => listeners.submit({ preventDefault() {} });
  await click();
  assert.equal(label.textContent, 'Download next part');
  await click();
  assert.equal(status.textContent, 'Retry');
  assert.deepEqual(downloads, ['part-001.json']);
  await click();
  assert.equal(status.textContent, 'Export complete');
  assert.deepEqual(downloads, ['part-001.json', 'part-002.json']);
  assert.deepEqual(requests, [undefined, 'next', 'next']);
  listeners.change();
  assert.equal(file.hidden, true);
});
