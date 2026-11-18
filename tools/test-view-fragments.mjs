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
    dashboard: ['action="{{ page.publishAction }}"', 'action="{{ page.pullAction }}"', 'value="unpublish"', 'data-live-weight'],
    'advanced-search': ['Live weight is {{ page.liveWeight }}'],
    editor: ['data-publish-schedule-toggle', 'view_strings.sections_editor.save_and_publish'],
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
      assert.ok(views.has('assets/picture-field.js'));
    }
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
