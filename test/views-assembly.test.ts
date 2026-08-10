// Guards the view assembler (tools/build-views.mjs):
//
//   views/** + every enabled src/features/<id>/views/**  ->  dist/views/**
//
// The point of the slice is that a feature's screens leave with it. Views are
// flat at runtime (/sections/trash.liquid), so nothing about a reference says
// who owns it and nothing fails when a dropped feature's section keeps
// shipping — which is exactly what used to happen. These assertions are what
// makes that fail.
//
// The assembler runs in Node, so vitest.config.mts assembles both profiles and
// hands the results over as bindings.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/** Views that must appear only when their feature is enabled. */
const FEATURE_VIEWS: Record<string, string[]> = {
  'trash': ['sections/trash.liquid', 'templates/trash.json'],
  'users-roles': ['sections/users.liquid', 'sections/roles.liquid', 'sections/user-form.liquid', 'sections/role-form.liquid'],
  'i18n': ['sections/languages.liquid', 'sections/translations.liquid'],
  'search': ['sections/advanced-search.liquid'],
  'credits': ['sections/credit-summary.liquid'],
  'media': ['sections/content-list.liquid'],
  'runtime-content-types': ['sections/type-list.liquid', 'sections/page-type-form.liquid', 'sections/block-type-form.liquid'],
  'plugins': ['sections/plugins-manage.liquid', 'sections/plugin-form.liquid', 'sections/plugin-credits.liquid'],
};

/** Chrome that must survive every profile: without it nothing renders. */
const CORE_VIEWS = [
  'layout/default.liquid',
  'sections/dashboard.liquid',
  'sections/editor.liquid',
  'sections/login.liquid',
  'sections/error.liquid',
  'snippets/structured-editor.liquid',
  'snippets/structured-item-group.liquid',
  'snippets/structured-item.liquid',
  'snippets/pagefield/text/basic.liquid',
  'snippets/pagefield/text/title.liquid',
  'assets/client-render.js',
  'assets/editor.js',
  'locales/en.json',
];

const full = env.TEST_ASSEMBLED_VIEW_PATHS.split(',').filter(Boolean);
const lean = env.TEST_ASSEMBLED_LEAN_VIEW_PATHS.split(',').filter(Boolean);
const viewFeatures = env.TEST_AVAILABLE_VIEW_FEATURES.split(',').filter(Boolean);

describe('view assembly', () => {
  it('has an entry for every feature shipping views', () => {
    // Keeps this test honest as features gain or lose a views/ directory.
    expect(viewFeatures.slice().sort()).toEqual(Object.keys(FEATURE_VIEWS).sort());
  });

  it('includes every enabled feature in the full profile', () => {
    for (const [feature, views] of Object.entries(FEATURE_VIEWS)) {
      for (const view of views) {
        expect(full, `${feature} is missing ${view}`).toContain(view);
      }
    }
  });

  it('drops every optional feature from a lean profile', () => {
    for (const [feature, views] of Object.entries(FEATURE_VIEWS)) {
      for (const view of views) {
        expect(lean, `${feature} leaked ${view} into the lean profile`).not.toContain(view);
      }
    }
  });

  it('keeps the core chrome in a lean profile', () => {
    for (const view of CORE_VIEWS) expect(lean).toContain(view);
  });

  it('removes the admin flash query parameter without changing the rest of the URL', async () => {
    const layout = await (await env.VIEWS.fetch('https://views.local/layout/default.liquid')).text();
    expect(layout).toContain("url.searchParams.delete('flash')");
    expect(layout).toContain("window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)");
  });

  it('ships scheduled, live, and ended page status labels', async () => {
    const catalog = await (await env.VIEWS.fetch('https://views.local/locales/en.json')).json() as {
      pages: { status: Record<string, string> };
    };
    expect(catalog.pages.status).toMatchObject({ scheduled: 'Scheduled', live: 'Live', ended: 'Ended' });
    const dashboard = await (await env.VIEWS.fetch('https://views.local/sections/dashboard.liquid')).text();
    expect(dashboard).toContain('pages.status.scheduled');
    expect(dashboard).toContain('pages.status.live');
    expect(dashboard).toContain('pages.status.ended');
    expect(dashboard).toContain('bg-blue-100 text-blue-600');
  });

  it('ships a sync action for live content drift', async () => {
    const [icons, dashboard, advancedSearch] = await Promise.all([
      env.VIEWS.fetch('https://views.local/assets/icons.svg').then((response) => response.text()),
      env.VIEWS.fetch('https://views.local/sections/dashboard.liquid').then((response) => response.text()),
      env.VIEWS.fetch('https://views.local/sections/advanced-search.liquid').then((response) => response.text()),
    ]);
    expect(icons).toContain('<symbol id="sync"');
    expect(dashboard).toContain('view_strings.sections_dashboard.live_content_differs_from_draft');
    expect(dashboard).toContain('{{ iconHrefPrefix }}#warning');
    expect(dashboard).toContain('action="{{ page.publishAction }}"');
    expect(dashboard).toContain('{{ iconHrefPrefix }}#sync');
    expect(dashboard).toContain('page.hasLiveWeightDrift');
    expect(dashboard).toContain('view_strings.sections_dashboard.live_weight_differs_from_draft_publish_to_sync');
    expect(advancedSearch).toContain('view_strings.sections_advanced_search.live_content_differs_from_draft');
    expect(advancedSearch).toContain('{{ iconHrefPrefix }}#warning');
    expect(advancedSearch).toContain('action="{{ page.publishAction }}"');
    expect(advancedSearch).toContain('{{ iconHrefPrefix }}#sync');
  });

  it('uses the trash icon for the host page delete action', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    expect(editor).toContain('data-delete-button');
    expect(editor).toContain('{{ iconHrefPrefix }}#trash');
  });

  it('loads page editor behavior from an external core asset', async () => {
    const [editor, editorScript] = await Promise.all([
      env.VIEWS.fetch('https://views.local/sections/editor.liquid').then((response) => response.text()),
      env.VIEWS.fetch('https://views.local/assets/editor.js').then((response) => response.text()),
    ]);
    expect(editor).not.toContain('<script');
    expect(editorScript).toContain('window.WorkerCmsEditor');
    expect(editorScript).not.toMatch(/{{|{%/);
  });

  it('auto-generates tag slugs on new and edit forms while preserving custom slugs', async () => {
    const tagForm = await (await env.VIEWS.fetch('https://views.local/sections/tag-form.liquid')).text();
    expect(tagForm).toContain('function tagSlugForName(name)');
    expect(tagForm).toContain('const initialTagSlugFromName = tagSlugForName(tagNameInput?.value || \'\');');
    expect(tagForm).toContain('initialTagSlug !== \'\' && initialTagSlug !== initialTagSlugFromName');
    expect(tagForm).toContain('tagSlugInput.addEventListener(\'input\', () => { tagSlugEdited = true; });');
    expect(tagForm).toContain('tagNameInput?.addEventListener(\'input\', (event) => autoTagSlug(event.target.value));');
  });

  it('uses the shared text field snippet when a field has no renderer', async () => {
    const renderer = await (await env.VIEWS.fetch('https://views.local/assets/client-render.js')).text();
    expect(renderer).toContain("const templatePath = model.templatePath || '/snippets/pagefield/text/basic.liquid';");
    expect(renderer).toContain('return await renderLiquid(templatePath, model.data);');
  });

  it('aligns multiline field labels to the top while keeping text labels centered', async () => {
    const [textField, textareaField, richtextField] = await Promise.all([
      env.VIEWS.fetch('https://views.local/snippets/pagefield/text/basic.liquid').then((response) => response.text()),
      env.VIEWS.fetch('https://views.local/snippets/pagefield/textarea/basic.liquid').then((response) => response.text()),
      env.VIEWS.fetch('https://views.local/snippets/pagefield/richtext/md.liquid').then((response) => response.text()),
    ]);
    expect(textField).toContain('lg:flex items-center');
    expect(textareaField).toContain('lg:flex items-start');
    expect(richtextField).toContain('flex items-start justify-between');
  });

  it('places the editable page type below the slug as a compact badge', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    expect(editor.indexOf('id="page_type"')).toBeGreaterThan(editor.indexOf('id="slug"'));
    expect(editor).toContain('rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700');
    expect(editor).toContain('sm:text-xs');
  });

  it('shows the publication status after the editable page type', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    const pageType = editor.indexOf('id="page_type"');
    expect(editor.indexOf('publicationStatus == \'scheduled\'')).toBeGreaterThan(pageType);
    expect(editor).toContain('pages.status.scheduled');
    expect(editor).toContain('pages.status.ended');
    expect(editor).toContain('pages.status.live');
    expect(editor).toContain('pages.status.draft');
  });

  it('keeps the editor whitelist control beside the bottom page metadata', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    expect(editor.indexOf('data-editors-combobox')).toBeGreaterThan(editor.indexOf('id="lect_json_details"'));
    expect(editor.indexOf('data-editors-combobox')).toBeGreaterThan(editor.indexOf('view_strings.sections_editor.created_by'));
    expect(editor).toContain('id="editors" name="editors"');
  });

  it('places field copy controls after the bottom page metadata', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    const clipboard = editor.indexOf('data-fields-clipboard');
    expect(clipboard).toBeGreaterThan(editor.indexOf('view_strings.sections_editor.created_by'));
    expect(clipboard).toBeGreaterThan(editor.indexOf('view_strings.sections_editor.last_modified_by'));
    expect(clipboard).toBeGreaterThan(editor.indexOf('data-editors-combobox'));
    expect(editor.indexOf('data-fields-copy')).toBeGreaterThan(clipboard);
    expect(editor.indexOf('data-fields-paste')).toBeGreaterThan(clipboard);
  });

  it('adds a document icon before the structured content label', async () => {
    const structured = await (await env.VIEWS.fetch('https://views.local/snippets/structured-editor.liquid')).text();
    expect(structured).toContain('{{ iconHrefPrefix }}#document');
    expect(structured.indexOf('{{ iconHrefPrefix }}#document')).toBeLessThan(structured.indexOf('view_strings.snippets_structured_editor.content'));
  });

  it('adds a settings icon before the structured settings label', async () => {
    const structured = await (await env.VIEWS.fetch('https://views.local/snippets/structured-editor.liquid')).text();
    expect(structured).toContain('<details data-cms-collapsible data-collapsible-key="root:settings"');
    expect(structured).toContain('data-collapsible-icon');
    expect(structured).toContain('{{ iconHrefPrefix }}#settings');
    expect(structured.indexOf('{{ iconHrefPrefix }}#settings')).toBeLessThan(structured.indexOf('view_strings.snippets_structured_editor.settings'));
  });

  it('adds a blocks icon before structured item group names', async () => {
    const group = await (await env.VIEWS.fetch('https://views.local/snippets/structured-item-group.liquid')).text();
    expect(group).toContain('{{ iconHrefPrefix }}#blocks');
    expect(group.indexOf('{{ iconHrefPrefix }}#blocks')).toBeLessThan(group.indexOf('{{ group.name }}'));
  });

  it('marks page references with a link icon while keeping the full label accessible', async () => {
    const [icons, pageField] = await Promise.all([
      env.VIEWS.fetch('https://views.local/assets/icons.svg').then((response) => response.text()),
      env.VIEWS.fetch('https://views.local/snippets/pagefield/page/basic.liquid').then((response) => response.text()),
    ]);
    expect(icons).toContain('<symbol id="link"');
    expect(pageField).toContain('{{ field.label | remove: " reference" }}');
    expect(pageField).toContain('{{ iconHrefPrefix }}#link');
    expect(pageField).toContain('<span class="sr-only">{{ field.label }}</span>');
  });

  it('makes structured item groups and items collapsible by their summaries', async () => {
    const renderer = await (await env.VIEWS.fetch('https://views.local/assets/client-render.js')).text();
    const structured = await (await env.VIEWS.fetch('https://views.local/snippets/structured-editor.liquid')).text();
    const group = await (await env.VIEWS.fetch('https://views.local/snippets/structured-item-group.liquid')).text();
    const item = await (await env.VIEWS.fetch('https://views.local/snippets/structured-item.liquid')).text();
    expect(group).toContain('<details data-cms-collapsible');
    expect(item).toContain('data-cms-collapsible');
    expect(item).toContain('data-weight-sortable-row');
    expect(structured).toContain('select-none');
    expect(group).toContain('select-none');
    expect(item).toContain('select-none');
    expect(group).toContain('<summary class="');
    expect(item).toContain('<summary class="');
    expect(item).toContain('data-weight-sortable-input');
    expect(renderer).toContain("renderLiquid('/snippets/structured-item-group.liquid'");
    expect(renderer).toContain("renderLiquid('/snippets/structured-item.liquid'");
    expect(renderer).toContain('details[data-cms-collapsible]');
    expect(renderer).toContain('setupCollapsibleDetails();');
    expect(renderer).toContain('cms-editor-structured-collapse:');
    expect(renderer).toContain('window.localStorage.setItem(storageKey');
  });

  it('places raw Lect metadata above the bottom page metadata', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    expect(editor.indexOf('id="lect_json_details"')).toBeLessThan(editor.indexOf('view_strings.sections_editor.created_by'));
  });

  it('places the parent page control below page weight', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    expect(editor.indexOf('data-parent-combobox')).toBeGreaterThan(editor.indexOf('id="weight"'));
    expect(editor.indexOf('data-parent-combobox')).toBeLessThan(editor.indexOf('data-publish-schedule-toggle'));
    expect(editor).toContain('id="page_id" name="page_id"');
    expect(editor).toContain('placeholder="{{ "view_strings.sections_editor.no_parent" | t }}"');
    expect(editor).toContain('data-parent-label=""');
  });

  it('places the page weight control above the publish schedule card', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    expect(editor.indexOf('id="weight"')).toBeGreaterThan(editor.indexOf('<!-- end page edit header -->'));
    expect(editor.indexOf('id="weight"')).toBeLessThan(editor.indexOf('data-publish-schedule-toggle'));
    expect(editor).toContain('id="weight" name="weight"');
  });

  it('stretches the publish schedule card to the page header height', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    expect(editor).toContain('md:flex-row');
    expect(editor).toContain('md:max-w-[25%]');
    expect(editor).toContain('md:border-l md:border-gray-200 md:pl-4');
  });

  it('keeps publish actions inside the publish schedule card', async () => {
    const [editor, editorScript] = await Promise.all([
      env.VIEWS.fetch('https://views.local/sections/editor.liquid').then((response) => response.text()),
      env.VIEWS.fetch('https://views.local/assets/editor.js').then((response) => response.text()),
    ]);
    const schedule = editor.indexOf('view_strings.sections_editor.publish_schedule');
    const publish = editor.indexOf('name="action" value="publish"');
    const unpublish = editor.indexOf('data-unpublish-button');
    const panelEnd = editor.indexOf('<!-- end publish schedule panel -->');
    const structured = editor.indexOf('{{ structuredBlock | raw }}');
    expect(schedule).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(schedule);
    expect(publish).toBeLessThan(structured);
    expect(unpublish).toBeGreaterThan(schedule);
    expect(unpublish).toBeLessThan(structured);
    expect(panelEnd).toBeGreaterThan(unpublish);
    expect(editor).toContain('view_strings.sections_editor.re_publish');
    expect(editor).toContain('data-publish-schedule-toggle');
    expect(editor).toContain('id="publish_schedule_panel"');
    expect(editorScript).toContain('cms-editor-publish-schedule-collapsed');
    expect(editorScript).toContain('window.localStorage');
    expect(editor).toContain('aria-expanded="false"');
    expect(editor).toContain('data-publish-schedule-panel class="min-w-0 flex-1 mt-2" hidden');
    expect(editorScript).toContain('let publishScheduleCollapsed = true;');
  });

  it('offers save and publish beside save for published pages', async () => {
    const editor = await (await env.VIEWS.fetch('https://views.local/sections/editor.liquid')).text();
    const footer = editor.slice(editor.indexOf('<div class="flex min-w-0 flex-col gap-3 sm:flex-row'));
    const save = footer.indexOf('view_strings.sections_editor.save_changes');
    const saveAndPublish = footer.indexOf('view_strings.sections_editor.save_and_publish');
    expect(editor).toContain('{% if isEdit and isPublished %}');
    expect(saveAndPublish).toBeGreaterThan(save);
    expect(footer).toContain('name="action" value="publish"');
  });

  it('flattens feature views into the shared runtime namespace', () => {
    // Ownership lives in the source tree, not the served path: renderView()
    // and the client engine's root list must keep working unchanged.
    for (const path of full) {
      expect(path).not.toContain('features/');
      expect(path).toMatch(/^(layout|sections|templates|snippets|assets|locales)\//);
    }
  });

  it('does not ship source-only locale catalogs', () => {
    expect(full).not.toContain('locales/en.default.json');
    expect(lean).not.toContain('locales/en.default.json');
  });

  it('merges each feature\'s locale fragment into the shared catalog', () => {
    const catalog = JSON.parse(env.TEST_ASSEMBLED_VIEW_LOCALE);
    expect(catalog.trash).toBeDefined();
    expect(catalog.credits).toBeDefined();
    expect(catalog.view_strings['sections_trash.trash']).toBeDefined();
    expect(catalog.view_strings['sections_advanced_search.export']).toBeDefined();
  });

  it('drops a dropped feature\'s translations too', () => {
    // A feature's strings are dead weight in four languages once its screens
    // are gone, and a stale key is how a dropped screen half-comes-back.
    const catalog = JSON.parse(env.TEST_ASSEMBLED_LEAN_VIEW_LOCALE);
    for (const namespace of ['trash', 'credits', 'plugins', 'users', 'roles', 'i18n', 'types']) {
      expect(catalog[namespace], `${namespace} leaked into the lean catalog`).toBeUndefined();
    }
    for (const key of Object.keys(catalog.view_strings)) {
      expect(key).not.toMatch(/^sections_(trash|advanced_search|users|roles|credit_summary|plugin)/);
    }
  });

  it('keeps the core catalog in a lean profile', () => {
    const catalog = JSON.parse(env.TEST_ASSEMBLED_LEAN_VIEW_LOCALE);
    // nav/shell label the chrome itself; the bulk-action strings are shared by
    // the core dashboard and the search screen, so they are core-owned.
    for (const namespace of ['common', 'nav', 'shell', 'login', 'pages', 'read', 'profile', 'settings']) {
      expect(catalog[namespace]).toBeDefined();
    }
    expect(catalog.view_strings['shared_bulk_actions.publish']).toBeDefined();
    expect(catalog.view_strings['sections_dashboard.new_page']).toBeDefined();
  });
});
