(function () {
  'use strict';

  class TemplateNotFoundError extends Error {}

  const payloadEl = document.getElementById('cms-render-payload');
  const payload = payloadEl ? JSON.parse(payloadEl.textContent || '{}') : {};
  const templateCache = new Map();
  const templateSource = new Map();
  const pluginOutputCache = new Map();
  let translations = {};
  const missingTranslations = new Set();
  let activeViewBasePath = null;
  const engineOptions = {
    cache: true,
    extname: '.liquid',
    root: ['layout', 'templates', 'sections', 'snippets'],
    relativeReference: false,
    fs: {
      readFileSync(file) {
        throw new Error('Synchronous template reads are not supported: ' + file);
      },
      readFile(file) {
        return loadTemplate(file);
      },
      existsSync() {
        return false;
      },
      exists(file) {
        return templateExists(file);
      },
      contains() {
        return true;
      },
      containsSync() {
        return true;
      },
      resolve(root, file, ext) {
        const fileKey = file.endsWith(ext) ? file : file + ext;
        const folder = String(root).split('/').pop();
        if ((folder === 'sections' || folder === 'snippets') && !fileKey.startsWith(folder + '/')) {
          return folder + '/' + fileKey;
        }
        return fileKey;
      },
    },
  };
  // Template renders HTML-escape every output by default (fail-safe); templates
  // opt out per-output with `| raw` for pre-rendered, server-sanitized HTML.
  const engine = new liquidjs.Liquid({ ...engineOptions, outputEscape: 'escape' });
  // JSON-template settings interpolation produces DATA (fed back into template
  // renders, which escape on output) — escaping here would double-escape it.
  const dataEngine = new liquidjs.Liquid(engineOptions);

  registerCustomFilters(engine);
  registerCustomFilters(dataEngine);

  function registerCustomFilters(target) {
    target.registerFilter('t', function (key, fallback) {
      return translate(key, fallback);
    });

    target.registerFilter('l10n_number', function (value, options) {
      const number = Number(value);
      if (!Number.isFinite(number)) return String(value == null ? '' : value);
      const format = options && typeof options === 'object' ? options : {};
      return new Intl.NumberFormat(payload.layoutData && payload.layoutData.uiLocale || 'en', format).format(number);
    });

    target.registerFilter('l10n_date', function (value, options) {
      var input = value;
      if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(input)) {
        input = input.replace(' ', 'T') + 'Z';
      }
      let date = value instanceof Date ? value : new Date(input);
      if (Number.isNaN(date.getTime())) return String(value == null ? '' : value);
      const format = options && typeof options === 'object'
        ? { ...options }
        : { dateStyle: 'medium', timeStyle: 'short' };
      if (!format.timeZone) {
        const configuredTimezone = payload.layoutData && payload.layoutData.systemTimezone || '+0000';
        const fixedOffset = /^([+-])(\d{2})(\d{2})$/.exec(configuredTimezone);
        if (fixedOffset) {
          const offsetMinutes = (fixedOffset[1] === '-' ? -1 : 1)
            * (Number(fixedOffset[2]) * 60 + Number(fixedOffset[3]));
          date = new Date(date.getTime() + offsetMinutes * 60 * 1000);
          format.timeZone = 'UTC';
        } else {
          format.timeZone = configuredTimezone;
        }
      }
      return new Intl.DateTimeFormat(payload.layoutData && payload.layoutData.uiLocale || 'en', format).format(date);
    });
  }

  function translate(key, fallback) {
    const normalized = String(key == null ? '' : key);
    if (Object.prototype.hasOwnProperty.call(translations, normalized)) return translations[normalized];
    if (!missingTranslations.has(normalized)) {
      missingTranslations.add(normalized);
      console.warn('Missing translation:', normalized);
    }
    return fallback == null ? normalized : String(fallback);
  }

  async function loadTranslations() {
    if (!payload.catalogHref) return;
    const pluginTranslations = {};
    const bodyView = payload.bodyView || {};
    // Locale catalogs are opt-in (manifest `i18n: true`): plugins that do not
    // ship them are never probed, so their views cost no 404 round-trips.
    if (bodyView.plugin && bodyView.i18n && bodyView.viewBasePath) {
      const locale = payload.layoutData && payload.layoutData.uiLocale || 'en';
      const localePaths = Array.from(new Set(['en', locale]));
      for (const code of localePaths) {
        const response = await fetch(withRevision(bodyView.viewBasePath + '/locales/' + encodeURIComponent(code) + '.json', bodyView.viewRevision), {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) continue;
        Object.assign(pluginTranslations, flattenTranslations(await response.json()));
      }
    }
    const response = await fetch(payload.catalogHref, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Unable to load translation catalog');
    const catalog = await response.json();
    translations = {
      ...pluginTranslations,
      ...(catalog && typeof catalog === 'object' ? catalog : {}),
    };
  }

  function flattenTranslations(value, prefix, output) {
    prefix = prefix || '';
    output = output || {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
    Object.keys(value).forEach(function (key) {
      const path = prefix ? prefix + '.' + key : key;
      const child = value[key];
      if (typeof child === 'string') output[path] = child;
      else flattenTranslations(child, path, output);
    });
    return output;
  }

  function normalizePath(path) {
    return path.startsWith('/') ? path : '/' + path;
  }

  function withRevision(url, revision) {
    revision = revision || payload.viewRevision;
    if (!revision) return url;
    const hashIndex = url.indexOf('#');
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const queryIndex = base.indexOf('?');
    const path = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
    const params = new URLSearchParams(queryIndex >= 0 ? base.slice(queryIndex + 1) : '');
    params.set('r', revision);
    return path + '?' + params.toString() + hash;
  }

  function revisionForBasePath(basePath) {
    const bodyView = payload.bodyView || {};
    if (bodyView.plugin && bodyView.viewBasePath === basePath && bodyView.viewRevision) {
      return bodyView.viewRevision;
    }
    return payload.viewRevision;
  }

  function pluginIdForBasePath(basePath) {
    const match = /^\/admin\/plugins\/([^/]+)\/views$/.exec(basePath || '');
    return match ? match[1] : null;
  }

  function approvedAssetsForPlugin(pluginId) {
    if (!pluginId) return [];
    const list = (payload.approvedPluginAssets || {})[pluginId];
    return Array.isArray(list) ? list : [];
  }

  function renderGlobals(basePath) {
    const revision = revisionForBasePath(basePath) || '';
    const viewRevisionQuery = revision ? '?r=' + encodeURIComponent(revision) : '';
    const cmsRevision = payload.viewRevision || '';
    const cmsRevisionQuery = cmsRevision ? '?r=' + encodeURIComponent(cmsRevision) : '';
    const pluginId = pluginIdForBasePath(basePath);
    const approvedAssets = approvedAssetsForPlugin(pluginId);
    const assetRevisionQueries = {};
    approvedAssets.forEach((asset) => {
      if (!asset || !asset.path || !asset.revision) return;
      const query = '?r=' + encodeURIComponent(asset.revision);
      assetRevisionQueries[asset.path] = query;
      assetRevisionQueries['/admin/plugins/' + pluginId + asset.path] = query;
    });
    const firstPluginAssetQuery = approvedAssets.length && approvedAssets[0].revision
      ? '?r=' + encodeURIComponent(approvedAssets[0].revision)
      : '';
    const assetRevisionQuery = firstPluginAssetQuery || viewRevisionQuery;
    return {
      nonce: payload.nonce,
      uiLocale: payload.layoutData && payload.layoutData.uiLocale || 'en',
      uiDirection: payload.layoutData && payload.layoutData.uiDirection || 'ltr',
      viewRevision: revision,
      viewRevisionQuery,
      assetRevisionQuery,
      pluginAssetRevisionQuery: firstPluginAssetQuery,
      assetRevisionQueries,
      pluginAssetRevisionQueries: assetRevisionQueries,
      iconHrefPrefix: '/assets/icons.svg' + cmsRevisionQuery,
    };
  }

  function sharedCmsTemplatePath(path) {
    const normalized = path ? normalizePath(path) : '';
    if (normalized.startsWith('/snippets/pagefield/')) return normalized;
    if (normalized === '/snippets/color-tag-picker.liquid'
      || normalized === '/sections/color-tag-picker.liquid'
      || normalized === '/color-tag-picker.liquid') {
      return '/snippets/color-tag-picker.liquid';
    }
    return '';
  }

  function currentViewBasePath(path) {
    if (sharedCmsTemplatePath(path)) return payload.viewBasePath || '/admin/views';
    return activeViewBasePath || payload.viewBasePath || '/admin/views';
  }

  function templateKey(basePath, normalizedPath) {
    return basePath + ' ' + normalizedPath;
  }

  async function loadTemplate(path) {
    const normalized = sharedCmsTemplatePath(path) || normalizePath(path);
    const basePath = currentViewBasePath(normalized);
    const key = templateKey(basePath, normalized);
    if (templateCache.has(key)) return templateCache.get(key);

    const promise = fetch(withRevision(basePath + normalized, revisionForBasePath(basePath)), {
      credentials: 'same-origin',
      headers: { Accept: normalized.endsWith('.json') ? 'application/json' : 'text/plain' },
    }).then(async (response) => {
      if (!response.ok) {
        templateCache.delete(key);
        templateSource.delete(key);
        throw new TemplateNotFoundError('View file not found: ' + normalized);
      }
      templateSource.set(key, response.headers.get('x-cms-view-source') === 'plugin' ? 'plugin' : 'core');
      return response.text();
    });
    templateCache.set(key, promise);
    return promise;
  }

  async function withViewBasePath(basePath, callback) {
    const previous = activeViewBasePath;
    activeViewBasePath = basePath || previous;
    try {
      return await callback();
    } finally {
      activeViewBasePath = previous;
    }
  }

  async function templateExists(path) {
    try {
      await loadTemplate(path);
      return true;
    } catch (error) {
      if (error instanceof TemplateNotFoundError) return false;
      throw error;
    }
  }

  async function renderView(viewPath, data) {
    if (viewPath.endsWith('.json')) return renderJsonTemplate(viewPath, data);
    if (viewPath.endsWith('.liquid')) return renderLiquid(viewPath, data);

    const liquidPath = viewPath + '.liquid';
    if (await templateExists(liquidPath)) return renderLiquid(liquidPath, data);

    const jsonPath = viewPath + '.json';
    if (await templateExists(jsonPath)) return renderJsonTemplate(jsonPath, data);

    throw new TemplateNotFoundError('View file not found: ' + viewPath);
  }

  async function renderLiquid(templatePath, data) {
    const normalized = normalizePath(templatePath);
    const basePath = currentViewBasePath(normalized);
    const template = await loadTemplate(normalized);
    const html = String(await engine.parseAndRender(template, { ...data, ...renderGlobals(basePath) }));
    return isPluginTemplate(normalized) ? sanitizePluginHtml(html) : html;
  }

  async function renderJsonTemplate(templatePath, data) {
    const rawTemplate = await loadTemplate(templatePath);
    const jsonTemplate = JSON.parse(rawTemplate);
    if (!jsonTemplate.order || !jsonTemplate.order.length) return '';

    const basePath = currentViewBasePath(normalizePath(templatePath));
    const renderData = await prepareRenderData(templatePath, { meta: {}, ...data, ...renderGlobals(basePath) });
    const renders = {};

    for (const key of jsonTemplate.order) {
      const sourceSection = jsonTemplate.sections && jsonTemplate.sections[key];
      if (!sourceSection) continue;
      const section = clone(sourceSection);
      section.id = key;

      if (typeof section.type === 'string' && section.type.startsWith('#')) {
        mergeMetaSection(renderData, section);
        continue;
      }

      await parseSettings(section, renderData);
      normalizeBlocks(section);
      if (Array.isArray(section.blocks)) {
        await Promise.all(section.blocks.map((block) => parseSettings(block, renderData)));
      }

      const sectionHtml = await renderLiquid('/sections/' + section.type + '.liquid', {
        ...renderData,
        section,
      });
      renders[key] = addSectionComments(key, section, sectionHtml, renderData);
    }

    let result = jsonTemplate.order.map((key) => renders[key]).filter(Boolean).join('\n');
    if (jsonTemplate.wrapper) {
      throw new Error('JSON template wrappers are not supported by the browser renderer: ' + templatePath);
    }
    if (isPluginTemplate(templatePath)) result = sanitizePluginHtml(result);
    if (renderData.debug === true) {
      return '<!-- begin json template: ' + escapeComment(templatePath) + ' -->\n' +
        result +
        '\n<!-- end json template: ' + escapeComment(templatePath) + ' -->';
    }
    return result;
  }

  async function parseSettings(node, data) {
    if (typeof node.type === 'string' && hasLiquidSyntax(node.type)) {
      node.type = await renderString(node.type, data);
    }

    const settings = node.settings || {};
    for (const key of Object.keys(settings)) {
      const value = settings[key];
      if (typeof value !== 'string' || !hasLiquidSyntax(value)) continue;
      settings[key] = await renderString(value, data, true);
    }
  }

  async function renderString(value, data, secondPass) {
    let text = String(await dataEngine.parseAndRender(value, data));
    if (secondPass && hasLiquidSyntax(text)) {
      text = String(await dataEngine.parseAndRender(text, data));
    }
    return text;
  }

  function normalizeBlocks(section) {
    if (!section.block_order || !section.block_order.length || !section.blocks || Array.isArray(section.blocks)) return;
    section.blocks = section.block_order.map((key) => section.blocks[key]).filter(Boolean);
  }

  function mergeMetaSection(data, section) {
    const metaKey = String(section.type || '').replace(/^#/, '');
    const meta = data.meta && typeof data.meta === 'object' ? data.meta : {};
    const existing = meta[metaKey];
    const settings = section.settings || {};
    const value = settings.value;

    if (Array.isArray(value)) {
      const set = existing instanceof Set ? existing : new Set();
      value.forEach((item) => set.add(item));
      meta[metaKey] = set;
    } else if (value && typeof value === 'object') {
      meta[metaKey] = {
        ...(existing && typeof existing === 'object' && !(existing instanceof Set) ? existing : {}),
        ...value,
      };
    }
    data.meta = meta;
  }

  function addSectionComments(key, section, html, data) {
    if (data.sectionComments === false) return html;
    const label = key + ': ' + section.type;
    return '<!-- begin section: ' + escapeComment(label) + ' -->\n' +
      html +
      '\n<!-- end section: ' + escapeComment(label) + ' -->';
  }

  async function prepareRenderData(_templatePath, data) {
    if (data.structuredModel) {
      data.structuredBlock = await renderStructuredEditor(data.structuredModel);
    }
    return data;
  }

  async function renderStructuredEditor(model) {
    const prepared = {
      ...model,
      settingsHtml: await renderFieldSet(model.settingsFields, model.itemGroups, false, 'root:settings'),
      contentHtml: await renderFieldSet(model.contentFields, model.itemGroups, true, 'root:content'),
      blocks: await Promise.all((model.blocks || []).map(async (block) => ({
        ...block,
        settingsHtml: await renderFieldSet(block.settingsFields, block.itemGroups, false, 'block:' + block.index + ':settings'),
        contentHtml: await renderFieldSet(block.contentFields, block.itemGroups, true, 'block:' + block.index + ':content'),
      }))),
    };
    return renderLiquid('/snippets/structured-editor.liquid', prepared);
  }

  async function renderFieldSet(fields, itemGroups, includeItems, scopeKey = 'root') {
    const fieldHtml = await renderFieldGrid(await renderFields(fields || []));
    if (!includeItems) return fieldHtml;
    const groups = await Promise.all((itemGroups || []).map((group, index) => renderItemGroup(group, scopeKey + ':group:' + index)));
    return fieldHtml + groups.join('');
  }

  async function renderFields(fields) {
    return (await Promise.all(fields.map((field) => renderPageField(field)))).join('');
  }

  async function renderPageField(model) {
    const templatePath = model.templatePath || '/snippets/pagefield/text/basic.liquid';
    try {
      return await renderLiquid(templatePath, model.data);
    } catch (error) {
      if (!(error instanceof TemplateNotFoundError)) console.error(error);
    }
    return renderInput(model.inputName, model.label, model.value, model.type, model.placeholder);
  }

  async function renderFieldGrid(fieldsHtml) {
    if (!fieldsHtml.trim()) return '';
    return '\n    <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">\n      ' +
      fieldsHtml +
      '\n    </div>';
  }

  async function renderItemGroup(group, scopeKey) {
    const groupKey = scopeKey + ':' + group.addAction;
    const rows = group.rows && group.rows.length
      ? (await Promise.all(group.rows.map((row) => renderItemRow(row, groupKey + ':item:' + row.weightInputName)))).join('')
      : '';

    return renderLiquid('/snippets/structured-item-group.liquid', {
      group,
      groupKey,
      rowsHtml: rows,
      hasRows: Boolean(group.rows && group.rows.length),
    });
  }

  async function renderItemRow(row, scopeKey) {
    const settingsHtml = await renderFieldSet(row.settingsFields, row.itemGroups, false, scopeKey + ':settings');
    const contentHtml = await renderFieldSet(row.contentFields, row.itemGroups, true, scopeKey + ':content');
    const dragToReorder = translate('view_strings.sections_tags.drag_to_reorder', 'Drag to reorder');
    return renderLiquid('/snippets/structured-item.liquid', {
      row,
      scopeKey,
      settingsHtml,
      contentHtml,
      weightInputId: fieldId(row.weightInputName),
      dragToReorder,
    });
  }

  // Item groups can appear at the page root, inside a block, and nested inside
  // another item. Keep each group as an independent drag surface and update the
  // ordinary _weight inputs so the existing form save persists the order.
  function setupWeightSortables() {
    let dragRow = null;
    let dragScope = null;
    let dragHandle = null;
    let dragChanged = false;

    function rows(scope) {
      return Array.from(scope.querySelectorAll('[data-weight-sortable-row]'))
        .filter((row) => row.parentElement === scope);
    }

    function markRows() {
      document.querySelectorAll('[data-weight-sortable]').forEach((scope) => {
        rows(scope).forEach((row) => row.setAttribute('draggable', 'true'));
      });
    }

    function syncWeights(scope) {
      rows(scope).forEach((row, index) => {
        const input = row.querySelector('[data-weight-sortable-input]');
        if (!input) return;
        input.value = String(index);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    markRows();

    document.addEventListener('mousedown', (event) => {
      dragHandle = event.target.closest && event.target.closest('[data-weight-sortable-handle]');
    });

    document.addEventListener('dragstart', (event) => {
      const row = event.target.closest && event.target.closest('[data-weight-sortable-row]');
      const scope = row && row.parentElement;
      if (!row || !scope || !scope.matches('[data-weight-sortable]')) return;
      if (!dragHandle || !row.contains(dragHandle)) {
        event.preventDefault();
        return;
      }
      dragRow = row;
      dragScope = scope;
      dragChanged = false;
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('opacity-40');
    });

    document.addEventListener('dragover', (event) => {
      if (!dragRow || !dragScope) return;
      const row = event.target.closest && event.target.closest('[data-weight-sortable-row]');
      if (!row || row === dragRow || row.parentElement !== dragScope) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const reference = event.clientY > rect.top + rect.height / 2 ? row.nextSibling : row;
      if (reference !== dragRow && reference !== dragRow.nextSibling) {
        dragScope.insertBefore(dragRow, reference);
        dragChanged = true;
      }
    });

    document.addEventListener('drop', (event) => {
      if (dragRow) event.preventDefault();
    });

    document.addEventListener('dragend', () => {
      if (!dragRow) return;
      dragRow.classList.remove('opacity-40');
      if (dragChanged) syncWeights(dragScope);
      dragRow = null;
      dragScope = null;
      dragHandle = null;
      dragChanged = false;
    });
  }

  function setupCollapsibleDetails() {
    const storageKey = 'cms-editor-structured-collapse:' + window.location.pathname;
    let storedState = {};
    try {
      const rawState = window.localStorage.getItem(storageKey);
      const parsedState = rawState ? JSON.parse(rawState) : null;
      if (parsedState && typeof parsedState === 'object' && !Array.isArray(parsedState)) storedState = parsedState;
    } catch (_error) {
      storedState = {};
    }

    function persistState() {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(storedState));
      } catch (_error) {
        // Ignore browsers that block localStorage or have reached its quota.
      }
    }

    document.querySelectorAll('details[data-cms-collapsible]').forEach((details) => {
      const key = details.getAttribute('data-collapsible-key');
      const summary = details.querySelector(':scope > summary');
      const icon = summary && summary.querySelector('[data-collapsible-icon]');
      if (!key || !icon) return;
      if (typeof storedState[key] === 'boolean') details.open = storedState[key];
      const updateIcon = () => {
        icon.style.transform = details.open ? 'rotate(90deg)' : 'rotate(0deg)';
      };
      details.addEventListener('toggle', () => {
        updateIcon();
        storedState[key] = details.open;
        persistState();
      });
      updateIcon();
    });
  }

  function renderInput(name, label, value, type, placeholder) {
    const isLong = String(type).includes('textarea') || label === 'body' || label === 'description';
    const inputType = type === 'date' || type === 'number' ? type : 'text';
    const id = fieldId(name);
    const input = isLong
      ? '<textarea id="' + escapeHtml(id) + '" name="' + escapeHtml(name) + '" rows="4"\n' +
        '                 placeholder="' + escapeHtml(placeholder || '') + '"\n' +
        '                 class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">' + escapeHtml(value ?? '') + '</textarea>'
      : '<input id="' + escapeHtml(id) + '" type="' + escapeHtml(inputType) + '" name="' + escapeHtml(name) + '"\n' +
        '              value="' + escapeHtml(value ?? '') + '"\n' +
        '              placeholder="' + escapeHtml(placeholder || '') + '"\n' +
        '              class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">';

    return '<label for="' + escapeHtml(id) + '" class="' + (isLong ? 'sm:col-span-2 ' : '') + 'min-w-0 block">\n' +
      '            <span class="block text-sm font-medium text-gray-700 mb-1">' + escapeHtml(label) + '</span>\n' +
      input +
      '\n          </label>';
  }

  function fieldId(name) {
    return 'field_' + Array.from(String(name))
      .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : '_' + char.charCodeAt(0).toString(16) + '_'))
      .join('');
  }

  function replaceDocument(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const attr of Array.from(document.documentElement.attributes)) {
      document.documentElement.removeAttribute(attr.name);
    }
    for (const attr of Array.from(parsed.documentElement.attributes)) {
      document.documentElement.setAttribute(attr.name, attr.value);
    }
    document.title = parsed.title;
    for (const attr of Array.from(document.body.attributes)) {
      document.body.removeAttribute(attr.name);
    }
    for (const attr of Array.from(parsed.body.attributes)) {
      document.body.setAttribute(attr.name, attr.value);
    }
    document.body.innerHTML = parsed.body.innerHTML;
    executeScripts(parsed);
  }

  function executeScripts(parsed) {
    parsed.querySelectorAll('script').forEach((oldScript) => {
      if (oldScript.getAttribute('nonce') !== payload.nonce) return;
      const script = document.createElement('script');
      for (const attr of Array.from(oldScript.attributes)) {
        script.setAttribute(attr.name, attr.value);
      }
      // Dynamically-inserted external scripts are force-async: they execute in
      // arrival order, not document order, so a page's library (qrcode.min.js)
      // could run after the code that needs it. async=false restores ordered
      // execution; `defer` copied above has no effect on injected scripts.
      if (script.hasAttribute('src')) script.async = false;
      script.textContent = oldScript.textContent;
      document.body.appendChild(script);
    });
  }

  function isPluginTemplate(path) {
    const normalized = sharedCmsTemplatePath(path) || normalizePath(path);
    return templateSource.get(templateKey(currentViewBasePath(normalized), normalized)) === 'plugin';
  }

  // Plugin id whose assets are currently allowlisted, derived from the active
  // view base path (e.g. "/admin/plugins/checkin/views" -> "checkin").
  function currentPluginId() {
    const match = /^\/admin\/plugins\/([^/]+)\/views$/.exec(activeViewBasePath || '');
    return match ? match[1] : null;
  }

  function approvedAsset(pluginId, path) {
    if (!pluginId) return null;
    const list = (payload.approvedPluginAssets || {})[pluginId];
    if (!Array.isArray(list)) return null;
    return list.find((entry) => entry.path === path) || null;
  }

  // Only a <script>/<link> whose src/href points at this exact CMS-served,
  // admin-approved asset URL survives; everything else (including any inline
  // script content) is still stripped. See utils/plugin-assets.ts — the CMS
  // re-hashes the file on every request, so this allowlist can't be used to
  // smuggle content the admin never reviewed.
  function approvedAssetSrc(pluginId, url) {
    // Manifest asset paths already start with "/assets/...", so the CMS-side
    // URL is just the plugin prefix (no extra "/assets") + that path — e.g.
    // "/admin/plugins/checkin/assets/js/kiosk.js" -> "/assets/js/kiosk.js".
    // Must match the server-side prefix in servePluginAsset() (routes/admin/plugins.ts).
    const prefix = '/admin/plugins/' + pluginId;
    if (!url || url.indexOf(prefix) !== 0) return null;
    // Match on the bare path — a cache-busting `?r=` / `#` (added here or by a
    // template via assetRevisionQuery) must not defeat the approval lookup.
    const path = url.slice(prefix.length).split(/[?#]/)[0];
    return approvedAsset(pluginId, path);
  }

  function sanitizePluginHtml(html) {
    if (!html || !/<(?:script|link|\w+[\s\S]*?\son\w+\s*=|\w+[\s\S]*?\s(?:href|src|action|formaction|xlink:href)\s*=)/i.test(html)) {
      return html;
    }

    const pluginId = currentPluginId();
    const cacheKey = pluginId + ' ' + html;
    if (pluginOutputCache.has(cacheKey)) return pluginOutputCache.get(cacheKey);

    const parsed = new DOMParser().parseFromString('<template>' + html + '</template>', 'text/html');
    const template = parsed.querySelector('template');
    if (!template) return html;

    template.content.querySelectorAll('script').forEach((script) => {
      const src = script.getAttribute('src');
      const approval = src && approvedAssetSrc(pluginId, src);
      if (!approval) {
        script.remove();
        return;
      }
      // Keep the tag, but never trust author-supplied attributes for the
      // security-relevant ones: pin the CMS-verified integrity hash and the
      // page's nonce (required for executeScripts() to run it), and drop any
      // inline body (browsers ignore it next to src, but don't carry it along).
      // No crossorigin attribute: the asset endpoint is same-origin and
      // requires the admin session cookie, which "crossorigin" would strip.
      script.setAttribute('integrity', approval.integrity);
      script.setAttribute('nonce', payload.nonce);
      // Use the plugin asset revision (plugin Worker deploy id when exposed,
      // otherwise the pinned integrity) so plugin deploys bust their own cache.
      script.setAttribute('src', withRevision(src, approval.revision));
      script.textContent = '';
    });
    template.content.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute('href');
      const approval = href && approvedAssetSrc(pluginId, href);
      if (!approval) {
        link.remove();
        return;
      }
      link.setAttribute('integrity', approval.integrity);
      link.setAttribute('href', withRevision(href, approval.revision));
    });
    template.content.querySelectorAll('*').forEach((element) => {
      for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || (isUrlAttribute(name) && isJavascriptUrl(attr.value))) {
          element.removeAttribute(attr.name);
        }
      }
    });

    const sanitized = template.innerHTML;
    pluginOutputCache.set(cacheKey, sanitized);
    return sanitized;
  }

  function isUrlAttribute(name) {
    return name === 'href' || name === 'src' || name === 'action' || name === 'formaction' || name === 'xlink:href';
  }

  // Script-capable schemes. data: is allowed only for raster images.
  function isJavascriptUrl(value) {
    const url = String(value).replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase();
    if (url.startsWith('javascript:') || url.startsWith('vbscript:')) return true;
    return url.startsWith('data:') && !/^data:image\/(?:png|gif|jpe?g|webp|avif)[;,]/.test(url);
  }

  function hasLiquidSyntax(value) {
    return /{{.*}}|{%.*%}/.test(value);
  }

  function escapeComment(value) {
    // Escape every ">" so neither "-->" nor "--!>" can close the comment.
    return String(value).replace(/>/g, '&gt;');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  async function main() {
    try {
      await loadTranslations();
      const layoutData = { ...(payload.layoutData || {}) };
      if (payload.bodyView) {
        const body = await withViewBasePath(payload.bodyView.viewBasePath, async () => {
          const rendered = await renderView(payload.bodyView.viewPath, payload.bodyView.data || {});
          // Sanitize while activeViewBasePath still identifies the plugin, so
          // the approved-asset allowlist can be applied to this plugin's id.
          return payload.bodyView.plugin ? sanitizePluginHtml(rendered) : rendered;
        });
        layoutData.body = payload.bodyView.plugin ? pluginContentWrapper(body) : body;
      }
      const html = await renderLiquid(payload.layoutPath || '/layout/default.liquid', layoutData);
      replaceDocument(html);
      setupWeightSortables();
      setupCollapsibleDetails();
    } catch (error) {
      console.error(error);
      const root = document.getElementById('cms-client-root') || document.body;
      root.innerHTML = '<div class="p-6 text-sm text-red-700">Unable to render this page.</div>';
    }
  }

  main();

  function pluginContentWrapper(html) {
    return '<div class="min-w-0 max-w-full px-4 py-5 sm:px-6 sm:py-8 lg:px-8">' + html + '</div>';
  }
})();
