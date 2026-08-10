(function () {
  'use strict';

  if (window.WorkerCmsEditor) {
    window.WorkerCmsEditor.scan();
    return;
  }

  function scan() {
    const editorForm = document.querySelector('form[data-editor-form]');
    if (!editorForm || editorForm.dataset.cmsEditorBound === '1') return;
    editorForm.dataset.cmsEditorBound = '1';

  const flash = document.getElementById('flash');
  if (flash) setTimeout(() => flash.remove(), 4000);

  const publishScheduleToggle = document.querySelector('[data-publish-schedule-toggle]');
  const publishSchedulePanel = document.querySelector('[data-publish-schedule-panel]');
  if (publishScheduleToggle && publishSchedulePanel) {
    const publishScheduleStorageKey = 'cms-editor-publish-schedule-collapsed';
    const expandedIcon = publishScheduleToggle.querySelector('[data-publish-schedule-expanded-icon]');
    const collapsedIcon = publishScheduleToggle.querySelector('[data-publish-schedule-collapsed-icon]');

    function setPublishScheduleCollapsed(collapsed, persist) {
      publishSchedulePanel.hidden = collapsed;
      publishSchedulePanel.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
      publishScheduleToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      const label = collapsed
        ? publishScheduleToggle.dataset.expandLabel
        : publishScheduleToggle.dataset.collapseLabel;
      if (label) {
        publishScheduleToggle.setAttribute('aria-label', label);
        publishScheduleToggle.setAttribute('title', label);
      }
      if (expandedIcon) expandedIcon.classList.toggle('hidden', collapsed);
      if (collapsedIcon) collapsedIcon.classList.toggle('hidden', !collapsed);
      if (persist) {
        try {
          window.localStorage.setItem(publishScheduleStorageKey, collapsed ? '1' : '0');
        } catch (_error) {}
      }
    }

    let publishScheduleCollapsed = true;
    try {
      publishScheduleCollapsed = window.localStorage.getItem(publishScheduleStorageKey) === '1';
    } catch (_error) {}
    setPublishScheduleCollapsed(publishScheduleCollapsed, false);
    publishScheduleToggle.addEventListener('click', () => {
      setPublishScheduleCollapsed(!publishSchedulePanel.hidden, true);
    });
  }

  const deleteButton = document.querySelector('[data-delete-button]');
  if (deleteButton) {
    deleteButton.addEventListener('click', (event) => {
      const message = deleteButton.getAttribute('data-confirm-message')
        || 'Delete this page?\n\nIt will be unpublished from all sites and moved to trash. You can restore it later from Trash.';
      if (!confirm(message)) event.preventDefault();
    });
  }

  const unpublishButton = document.querySelector('[data-unpublish-button]');
  if (unpublishButton) {
    unpublishButton.addEventListener('click', (event) => {
      const message = unpublishButton.getAttribute('data-confirm-message') || 'Un-publish this page?';
      if (!confirm(message)) event.preventDefault();
    });
  }

  document.querySelectorAll('[data-version-delete-button]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const message = button.getAttribute('data-confirm-message')
        || 'Remove this saved version?\n\nThis cannot be undone.';
      if (!confirm(message)) event.preventDefault();
    });
  });

  const cleanVersionsButton = document.querySelector('[data-clean-versions-button]');
  if (cleanVersionsButton) {
    cleanVersionsButton.addEventListener('click', (event) => {
      const message = cleanVersionsButton.getAttribute('data-confirm-message')
        || 'Clean all saved versions for this page?\n\nThis cannot be undone.';
      if (!confirm(message)) event.preventDefault();
    });
  }

  const parentCombobox = document.querySelector('[data-parent-combobox]');
  if (parentCombobox) {
    const parentInput = parentCombobox.querySelector('[data-parent-search]');
    const parentHidden = parentCombobox.querySelector('#page_id');
    const parentResults = parentCombobox.querySelector('[data-parent-results]');
    const parentEmpty = parentCombobox.querySelector('[data-parent-empty]');
    const parentToggle = parentCombobox.querySelector('[data-parent-toggle]');
    let parentSearchRequest = 0;

    function parentOptions() {
      return Array.from(parentCombobox.querySelectorAll('[data-parent-option]'));
    }

    function bindParentOption(option) {
      option.addEventListener('click', () => selectParentOption(option));
    }

    function updateParentEmpty() {
      let visibleCount = 0;
      parentOptions().forEach((option) => {
        const visible = !option.classList.contains('hidden');
        if (visible) visibleCount++;
      });
      parentEmpty.classList.toggle('hidden', visibleCount > 0);
    }

    function renderParentOptions(pages) {
      parentCombobox.querySelectorAll('[data-parent-dynamic]').forEach((option) => option.remove());
      pages.forEach((page) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50';
        option.dataset.parentOption = '';
        option.dataset.parentDynamic = '';
        option.dataset.parentId = String(page.id);
        option.dataset.parentLabel = page.label;
        option.innerHTML = `<span class="block truncate font-medium"></span><span class="block truncate text-[11px] text-gray-400"></span>`;
        option.children[0].textContent = page.label;
        option.children[1].textContent = page.name;
        bindParentOption(option);
        parentResults.insertBefore(option, parentEmpty);
      });
      updateParentEmpty();
    }

    async function loadParentOptions() {
      const requestId = ++parentSearchRequest;
      const params = new URLSearchParams();
      const query = parentInput.value.trim();
      const exclude = parentCombobox.dataset.parentExclude || '';
      const noParentOption = parentCombobox.querySelector('[data-parent-id=""]');
      noParentOption.classList.toggle('hidden', !!query && query !== '/');
      if (query && query !== '/') params.set('q', query);
      if (exclude) params.set('exclude', exclude);

      try {
        const response = await fetch(`/admin/api/parent-pages?${params.toString()}`);
        if (!response.ok || requestId !== parentSearchRequest) return;
        renderParentOptions(await response.json());
      } catch (_error) {
        if (requestId === parentSearchRequest) renderParentOptions([]);
      }
    }

    async function openParentResults() {
      parentResults.classList.remove('hidden');
      parentInput.setAttribute('aria-expanded', 'true');
      await loadParentOptions();
    }

    function closeParentResults() {
      parentResults.classList.add('hidden');
      parentInput.setAttribute('aria-expanded', 'false');
    }

    function selectParentOption(option) {
      parentHidden.value = option.dataset.parentId || '';
      parentInput.value = option.dataset.parentLabel || '/';
      closeParentResults();
    }

    parentInput.addEventListener('focus', openParentResults);
    parentInput.addEventListener('input', () => {
      if (!parentInput.value.trim()) parentHidden.value = '';
      openParentResults();
    });
    parentInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeParentResults();
        return;
      }
      if (event.key !== 'Enter') return;
      const firstVisible = parentOptions().find((option) => !option.classList.contains('hidden'));
      if (!firstVisible) return;
      event.preventDefault();
      selectParentOption(firstVisible);
    });
    parentToggle.addEventListener('click', () => {
      if (parentResults.classList.contains('hidden')) {
        parentInput.focus();
        openParentResults();
      } else {
        closeParentResults();
      }
    });
    parentOptions().forEach(bindParentOption);
    document.addEventListener('click', (event) => {
      if (!parentCombobox.contains(event.target)) closeParentResults();
    });
  }

  // Editors combobox: search users by name, confirmed users become removable
  // chips; the hidden #editors input carries the comma-separated user ids.
  const editorsCombobox = document.querySelector('[data-editors-combobox]');
  if (editorsCombobox) {
    const editorsHidden = document.getElementById('editors');
    const editorsSearch = editorsCombobox.querySelector('[data-editors-search]');
    const editorsResults = editorsCombobox.querySelector('[data-editors-results]');
    const editorsEmpty = editorsCombobox.querySelector('[data-editors-empty]');
    const editorChipTemplate = editorsCombobox.querySelector('[data-editor-chip-template]');
    let editorsSearchRequest = 0;

    function editorIds() {
      return editorsHidden.value.split(',').map((id) => id.trim()).filter(Boolean);
    }

    function bindEditorChip(chip) {
      chip.querySelector('[data-editor-remove]').addEventListener('click', () => {
        editorsHidden.value = editorIds().filter((id) => id !== chip.dataset.editorId).join(',');
        chip.remove();
      });
    }

    function addEditorChip(user) {
      const id = String(user.id);
      if (editorIds().includes(id)) return;
      editorsHidden.value = editorIds().concat(id).join(',');
      const chip = editorChipTemplate.content.firstElementChild.cloneNode(true);
      chip.dataset.editorId = id;
      chip.children[0].textContent = user.name;
      bindEditorChip(chip);
      editorsCombobox.insertBefore(chip, editorsSearch);
    }

    function renderEditorOptions(users) {
      editorsResults.querySelectorAll('[data-editor-option]').forEach((option) => option.remove());
      const selected = new Set(editorIds());
      const candidates = users.filter((user) => !selected.has(String(user.id)));
      candidates.forEach((user) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'block w-full px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50';
        option.dataset.editorOption = '';
        option.innerHTML = '<span class="block truncate font-medium"></span><span class="block truncate text-[11px] text-gray-400"></span>';
        option.children[0].textContent = user.name;
        option.children[1].textContent = user.email;
        option.addEventListener('click', () => {
          addEditorChip(user);
          editorsSearch.value = '';
          editorsSearch.focus();
          loadEditorOptions();
        });
        editorsResults.insertBefore(option, editorsEmpty);
      });
      editorsEmpty.classList.toggle('hidden', candidates.length > 0);
    }

    async function loadEditorOptions() {
      const requestId = ++editorsSearchRequest;
      const params = new URLSearchParams();
      const query = editorsSearch.value.trim();
      if (query) params.set('q', query);
      try {
        const response = await fetch(`/admin/api/users?${params.toString()}`);
        if (!response.ok || requestId !== editorsSearchRequest) return;
        renderEditorOptions(await response.json());
      } catch (_error) {
        if (requestId === editorsSearchRequest) renderEditorOptions([]);
      }
    }

    async function openEditorsResults() {
      editorsResults.classList.remove('hidden');
      editorsSearch.setAttribute('aria-expanded', 'true');
      await loadEditorOptions();
    }

    function closeEditorsResults() {
      editorsResults.classList.add('hidden');
      editorsSearch.setAttribute('aria-expanded', 'false');
    }

    editorsSearch.addEventListener('focus', openEditorsResults);
    editorsSearch.addEventListener('input', openEditorsResults);
    editorsSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeEditorsResults();
        return;
      }
      // Backspace in an empty search removes the last chip.
      if (event.key === 'Backspace' && !editorsSearch.value) {
        const chips = editorsCombobox.querySelectorAll('[data-editor-chip]');
        if (chips.length) chips[chips.length - 1].querySelector('[data-editor-remove]').click();
        return;
      }
      if (event.key !== 'Enter') return;
      // Enter confirms the first match instead of submitting the form.
      event.preventDefault();
      const firstOption = editorsResults.querySelector('[data-editor-option]');
      if (firstOption) firstOption.click();
    });
    editorsCombobox.querySelectorAll('[data-editor-chip]').forEach(bindEditorChip);
    document.addEventListener('click', (event) => {
      if (!editorsCombobox.contains(event.target)) closeEditorsResults();
    });
  }

  // Tag comboboxes (one per taxonomy group): options are pre-rendered
  // server-side and filtered client-side; assigned tags become removable chips
  // whose hidden inputs carry the tag_ids the form posts.
  document.querySelectorAll('[data-tags-combobox]').forEach((combobox) => {
    const search = combobox.querySelector('[data-tags-search]');
    const results = combobox.querySelector('[data-tags-results]');
    const empty = combobox.querySelector('[data-tags-empty]');
    const chipTemplate = combobox.querySelector('[data-tag-chip-template]');

    function optionFor(id) {
      return results.querySelector('[data-tag-option][data-tag-id="' + id + '"]');
    }

    function bindTagChip(chip) {
      chip.querySelector('[data-tag-remove]').addEventListener('click', () => {
        const option = optionFor(chip.dataset.tagId);
        if (option) option.classList.remove('hidden');
        chip.remove();
        filterOptions();
      });
    }

    function addTagChip(option) {
      const chip = chipTemplate.content.firstElementChild.cloneNode(true);
      chip.dataset.tagId = option.dataset.tagId;
      chip.querySelector('input').value = option.dataset.tagId;
      chip.querySelector('span').textContent = option.dataset.tagName;
      bindTagChip(chip);
      combobox.insertBefore(chip, search);
      option.classList.add('hidden');
    }

    function visibleOptions() {
      return [...results.querySelectorAll('[data-tag-option]:not(.hidden)')];
    }

    function filterOptions() {
      const query = search.value.trim().toLowerCase();
      let matches = 0;
      results.querySelectorAll('[data-tag-option]').forEach((option) => {
        // Chips stay hidden in the list even when they match the query.
        const assigned = combobox.querySelector('[data-tag-chip][data-tag-id="' + option.dataset.tagId + '"]');
        const visible = !assigned && option.dataset.tagName.toLowerCase().includes(query);
        option.classList.toggle('hidden', !visible);
        if (visible) matches += 1;
      });
      empty.classList.toggle('hidden', matches > 0);
    }

    function openResults() {
      filterOptions();
      results.classList.remove('hidden');
      search.setAttribute('aria-expanded', 'true');
    }

    function closeResults() {
      results.classList.add('hidden');
      search.setAttribute('aria-expanded', 'false');
    }

    results.querySelectorAll('[data-tag-option]').forEach((option) => {
      option.addEventListener('click', () => {
        addTagChip(option);
        search.value = '';
        search.focus();
        filterOptions();
      });
    });

    search.addEventListener('focus', openResults);
    search.addEventListener('input', openResults);
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeResults();
        return;
      }
      // Backspace in an empty search removes the last chip.
      if (event.key === 'Backspace' && !search.value) {
        const chips = combobox.querySelectorAll('[data-tag-chip]');
        if (chips.length) chips[chips.length - 1].querySelector('[data-tag-remove]').click();
        return;
      }
      if (event.key !== 'Enter') return;
      // Enter confirms the first match instead of submitting the form.
      event.preventDefault();
      const firstOption = visibleOptions()[0];
      if (firstOption) firstOption.click();
    });
    combobox.querySelectorAll('[data-tag-chip]').forEach(bindTagChip);
    document.addEventListener('click', (event) => {
      if (!combobox.contains(event.target)) closeResults();
    });
  });

  const editorScrollKey = 'cms-editor-scroll:' + window.location.pathname;
  const savedEditorScroll = window.sessionStorage.getItem(editorScrollKey);
  if (savedEditorScroll !== null) {
    window.sessionStorage.removeItem(editorScrollKey);
    window.requestAnimationFrame(() => {
      window.scrollTo(0, Number(savedEditorScroll) || 0);
    });
  }

  function switchEditorLanguage(language) {
    window.sessionStorage.setItem(editorScrollKey, String(window.scrollY));
    const params = new window.URLSearchParams(window.location.search);
    params.set('language', language);
    window.location.href = window.location.pathname + '?' + params.toString();
  }

  const structuredActions = new Set([
    'block-add',
    'block-delete',
    'item-add',
    'item-delete',
    'block-item-add',
    'block-item-delete',
  ]);
  // Target the editor form specifically: the admin layout renders a logout
  // form earlier in the DOM, so a bare form[method="POST"] would bind here.
  if (editorForm) {
    editorForm.addEventListener('submit', (event) => {
      const submitter = event.submitter || document.activeElement;
      const action = submitter && submitter.getAttribute ? submitter.getAttribute('value') || '' : '';
      if (structuredActions.has(action.split(':')[0])) {
        window.sessionStorage.setItem(editorScrollKey, String(window.scrollY));
      }
    });
  }

  let slugEdited = editorForm.getAttribute('data-editor-mode') === 'edit';
  document.getElementById('slug').addEventListener('input', () => { slugEdited = true; });

  function autoSlug(name) {
    if (slugEdited) return;
    const slug = name.toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    document.getElementById('slug').value = slug;
  }

  function copyToClipboard(selector) {
    const input = document.querySelector(selector);
    if (!input) return;
    input.select();
    input.setSelectionRange(0, 99999); // For mobile devices
    document.execCommand('copy');
  }

  document.getElementById('page-name')?.addEventListener('input', (event) => autoSlug(event.target.value));
  document.getElementById('copy-slug-btn')?.addEventListener('click', () => copyToClipboard('#slug'));
  document.getElementById('structured_language')?.addEventListener('change', (event) => switchEditorLanguage(event.target.value));

  // ── Copy / paste all fields ───────────────────────────────────────────────
  // Serialises every lect-encoded field on the form (settings, content, blocks
  // and items) as JSON, so a whole page's values can be moved to another page
  // or to another language. Value-field names carry a "|<language>" suffix; it
  // is stripped on copy and re-applied from the language currently on screen on
  // paste, which is what makes an en → mis paste land in the right inputs.
  // Fields the target form doesn't have (a block the other page lacks, a field
  // of a different page type) are reported as skipped rather than applied.
  const fieldsClipboard = document.querySelector('[data-fields-clipboard]');
  const fieldsPanel = document.querySelector('[data-fields-clipboard-panel]');
  if (editorForm && fieldsClipboard && fieldsPanel) {
    const panelHint = fieldsPanel.querySelector('[data-fields-panel-hint]');
    const panelText = fieldsPanel.querySelector('[data-fields-clipboard-text]');
    const panelApply = fieldsPanel.querySelector('[data-fields-panel-apply]');
    const panelClose = fieldsPanel.querySelector('[data-fields-panel-close]');
    const fieldsStatus = document.querySelector('[data-fields-status]');
    const languageSelect = document.getElementById('structured_language');
    const text = (key, fallback) => fieldsClipboard.getAttribute(key) || fallback;

    function currentLanguage() {
      return languageSelect ? languageSelect.value : '';
    }

    // `_type` and `_id` identify a block instance rather than describe it —
    // overwriting them would repoint the target's blocks at the source's.
    function isCopyableName(name) {
      return /^[.@*#\d]/.test(name) && !/@_(?:id|type)$/.test(name);
    }

    function lectFieldNodes() {
      return Array.from(editorForm.querySelectorAll('input[name], textarea[name], select[name]'))
        .filter((el) => isCopyableName(el.getAttribute('name') || ''));
    }

    function fieldKey(name) {
      return name.replace(/\|[A-Za-z0-9_-]+$/, '');
    }

    function collectFields() {
      const fields = {};
      lectFieldNodes().forEach((el) => {
        const key = fieldKey(el.getAttribute('name'));
        if (el.type === 'radio') {
          if (el.checked) fields[key] = el.value;
          else if (!(key in fields)) fields[key] = '';
        } else if (el.type === 'checkbox') {
          fields[key] = el.checked ? el.value : '';
        } else {
          fields[key] = el.value;
        }
      });
      return fields;
    }

    // A page reference posts its id from a hidden input; its visible combobox
    // has to be relabelled by hand (page-ref.js only reacts to typing).
    function syncPageRef(el) {
      if (!el.hasAttribute('data-page-ref-id')) return;
      const search = el.closest('[data-page-ref]')?.querySelector('[data-page-ref-search]');
      if (search) search.value = el.value ? '#' + el.value : '';
    }

    function setFieldValue(nodes, value) {
      const first = nodes[0];
      if (first.type === 'radio') {
        let matched = false;
        nodes.forEach((el) => {
          const checked = el.value === value;
          matched = matched || checked;
          if (el.checked !== checked) {
            el.checked = checked;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        return matched || value === '';
      }
      if (first.type === 'checkbox') {
        const checked = value !== '' && value !== 'no';
        if (first.checked !== checked) {
          first.checked = checked;
          first.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      }
      // A select can't hold a value it has no option for (a block type's own
      // option list) — leave it alone and count it as skipped.
      if (first.tagName === 'SELECT' && !Array.from(first.options).some((option) => option.value === value)) {
        return false;
      }
      first.value = value;
      // The richtext, picture and live-sync bindings all listen for these.
      first.dispatchEvent(new Event('input', { bubbles: true }));
      first.dispatchEvent(new Event('change', { bubbles: true }));
      syncPageRef(first);
      return true;
    }

    function applyFields(fields) {
      const byKey = new Map();
      lectFieldNodes().forEach((el) => {
        const key = fieldKey(el.getAttribute('name'));
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(el);
      });
      let applied = 0;
      let skipped = 0;
      Object.keys(fields).forEach((key) => {
        const nodes = byKey.get(key);
        const value = fields[key] == null ? '' : String(fields[key]);
        if (nodes && setFieldValue(nodes, value)) applied += 1;
        else skipped += 1;
      });
      return { applied, skipped };
    }

    function showStatus(message) {
      if (!fieldsStatus) return;
      fieldsStatus.textContent = message;
      fieldsStatus.classList.remove('hidden');
    }

    function openPanel(hint, value, withApply) {
      panelHint.textContent = hint;
      panelText.value = value;
      panelApply.classList.toggle('hidden', !withApply);
      fieldsPanel.classList.remove('hidden');
      panelText.focus();
      if (!withApply) panelText.select();
    }

    function closePanel() {
      fieldsPanel.classList.add('hidden');
      panelText.value = '';
    }

    function fill(template, values) {
      return Object.keys(values).reduce(
        (message, key) => message.split('{' + key + '}').join(String(values[key])),
        template,
      );
    }

    function payloadFor(fields) {
      return JSON.stringify({
        kind: 'cms-page-fields',
        version: 1,
        language: currentLanguage(),
        pageType: document.getElementById('page_type')?.value || '',
        fields,
      }, null, 2);
    }

    function parsePayload(raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_error) {
        return null;
      }
      if (!parsed || parsed.kind !== 'cms-page-fields' || !parsed.fields || typeof parsed.fields !== 'object') return null;
      return parsed;
    }

    function pasteFrom(raw) {
      const parsed = parsePayload(raw);
      if (!parsed) {
        showStatus(text('data-paste-invalid', 'That text is not a copied set of page fields.'));
        return false;
      }
      const count = Object.keys(parsed.fields).length;
      const confirmed = confirm(fill(text('data-paste-confirm', 'Replace {count} fields on this form with the values copied from {from}?'), {
        count,
        from: parsed.language || '?',
      }));
      if (!confirmed) return false;
      const result = applyFields(parsed.fields);
      showStatus(fill(text('data-pasted-status', 'Filled {applied} fields, {skipped} skipped. Save to keep the changes.'), result));
      return true;
    }

    // What "Copy fields" last put on the clipboard, kept per browser so the
    // paste button can appear on the page you move to — reading the real
    // clipboard needs a permission the browser only grants on a click.
    const clipboardStoreKey = 'cms-page-fields-clipboard';

    function storedPayload() {
      try {
        return window.localStorage.getItem(clipboardStoreKey) || '';
      } catch (_error) {
        return '';
      }
    }

    function storePayload(raw) {
      try {
        window.localStorage.setItem(clipboardStoreKey, raw);
      } catch (_error) {
        // Private mode or a full quota: paste still works from the clipboard.
      }
    }

    // Reads the clipboard only where that needs no prompt, so it is safe to call
    // on load; everywhere else this returns '' and the stored copy is used.
    async function silentClipboardRead() {
      try {
        if (!navigator.clipboard || !navigator.permissions) return '';
        const permission = await navigator.permissions.query({ name: 'clipboard-read' });
        if (permission.state !== 'granted') return '';
        return await navigator.clipboard.readText();
      } catch (_error) {
        return '';
      }
    }

    function setPasteVisible(visible) {
      // `.inline-flex` is emitted after `.hidden`, so both have to be toggled.
      pasteButton.classList.toggle('hidden', !visible);
      pasteButton.classList.toggle('inline-flex', visible);
    }

    async function refreshPasteVisible() {
      setPasteVisible(!!parsePayload(storedPayload()) || !!parsePayload(await silentClipboardRead()));
    }

    const pasteButton = fieldsClipboard.querySelector('[data-fields-paste]');

    fieldsClipboard.querySelector('[data-fields-copy]').addEventListener('click', async () => {
      const fields = collectFields();
      const count = Object.keys(fields).length;
      if (!count) {
        showStatus(text('data-nothing-to-copy', 'There are no fields to copy.'));
        return;
      }
      const payload = payloadFor(fields);
      const status = fill(text('data-copied-status', 'Copied {count} fields ({language}).'), {
        count,
        language: currentLanguage() || '-',
      });
      storePayload(payload);
      setPasteVisible(true);
      try {
        await navigator.clipboard.writeText(payload);
        closePanel();
        showStatus(status);
      } catch (_error) {
        // No clipboard permission (or an insecure origin): hand over the text.
        openPanel(text('data-copy-manual', 'Copy this text, then paste it on the other page or language.'), payload, false);
        showStatus(status);
      }
    });

    pasteButton.addEventListener('click', async () => {
      let raw = '';
      try {
        raw = await navigator.clipboard.readText();
      } catch (_error) {
        raw = '';
      }
      // The real clipboard wins when it holds a field set; otherwise fall back to
      // what this browser last copied (Firefox and insecure origins never read).
      if (!parsePayload(raw)) raw = storedPayload();
      if (!parsePayload(raw)) {
        openPanel(text('data-paste-manual', 'Paste the copied fields here, then choose Apply.'), '', true);
        return;
      }
      if (pasteFrom(raw)) closePanel();
    });

    // A real ⌘V outside a text field carries the clipboard with it, so field sets
    // copied elsewhere (another browser, a message from a colleague) still land
    // even though the button had nothing to reveal itself for.
    document.addEventListener('paste', (event) => {
      const target = event.target;
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const raw = (event.clipboardData && event.clipboardData.getData('text/plain')) || '';
      if (!parsePayload(raw)) return;
      event.preventDefault();
      storePayload(raw);
      setPasteVisible(true);
      if (pasteFrom(raw)) closePanel();
    });

    // Another tab may have copied since this page loaded.
    window.addEventListener('storage', (event) => {
      if (event.key === clipboardStoreKey) refreshPasteVisible();
    });
    window.addEventListener('focus', refreshPasteVisible);
    refreshPasteVisible();

    panelApply.addEventListener('click', () => {
      const raw = panelText.value.trim();
      if (!pasteFrom(raw)) return;
      storePayload(raw);
      setPasteVisible(true);
      closePanel();
    });
    panelClose.addEventListener('click', closePanel);
  }

  // Presence and live collaboration now live in editor-sync.js so native and
  // plugin-owned editors share the same hybrid LWW + Y.Text implementation.
  // The legacy blocks below are retained temporarily for pages with custom
  // asset sets that do not load editor-sync, but must not run alongside it.
  if (document.getElementById('presence-bar')
      && document.querySelector('script[src*="/assets/editor-sync.js"]')) return;

(function () {
  var bar = document.getElementById('presence-bar');
  if (!bar) return;

  var pageId = bar.dataset.pageId;
  var currentUserId = bar.dataset.userId;
  var userAvatar = bar.dataset.userAvatar || '';
  var lastActive = new Date().toISOString();

  ['mousemove', 'keydown', 'click', 'scroll'].forEach(function (evt) {
    document.addEventListener(evt, function () { lastActive = new Date().toISOString(); }, { passive: true });
  });

  function userColor(userId) {
    var palette = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316'];
    var h = 0;
    for (var i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) & 0xffffff;
    return palette[Math.abs(h) % palette.length];
  }

  function initials(name) {
    return name.trim().split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
  }

  function renderAvatars(editors) {
    var container = document.getElementById('presence-avatars');
    if (!container) return;
    var now = Date.now();
    var IDLE_MS = 5 * 60 * 1000;
    container.replaceChildren();
    editors.forEach(function (e) {
      var userId = String(e.user_id || '');
      var userName = String(e.user_name || '');
      var userAvatar = String(e.user_avatar || '');
      var idle = (now - new Date(e.last_active).getTime()) > IDLE_MS;
      var color = userColor(userId);
      var ring = idle ? '2px solid #9ca3af' : '2px solid ' + color;
      var opacity = idle ? '0.4' : '1';
      var label = userName + (idle ? ' (idle)' : '') + (userId === currentUserId ? ' (you)' : '');
      var node;
      if (userAvatar) {
        node = document.createElement('img');
        node.src = userAvatar;
        node.alt = userName;
        node.style.objectFit = 'cover';
      } else {
        node = document.createElement('div');
        node.textContent = initials(userName);
        node.setAttribute('aria-label', label);
        node.style.background = color;
        node.style.display = 'flex';
        node.style.alignItems = 'center';
        node.style.justifyContent = 'center';
        node.style.fontSize = '11px';
        node.style.fontWeight = '700';
        node.style.color = '#fff';
      }
      node.title = label;
      node.style.width = '32px';
      node.style.height = '32px';
      node.style.borderRadius = '50%';
      node.style.outline = ring;
      node.style.opacity = opacity;
      node.style.transition = 'opacity .3s';
      container.appendChild(node);
    });
    // Enable live sync only while at least one other editor is present.
    if (editors.length > 1) {
      window.__cmsSync && window.__cmsSync.enable();
    } else {
      window.__cmsSync && window.__cmsSync.disable();
    }
  }

  function sendHeartbeat() {
    fetch('/admin/api/presence/' + pageId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastActive: lastActive, userAvatar: userAvatar }),
    }).catch(function () {});
  }

  function refreshPresence() {
    fetch('/admin/api/presence/' + pageId)
      .then(function (r) { return r.json(); })
      .then(renderAvatars)
      .catch(function () {});
  }

  sendHeartbeat();
  refreshPresence();
  setInterval(sendHeartbeat, 30000);
  setInterval(refreshPresence, 8000);

  window.addEventListener('beforeunload', function () {
    fetch('/admin/api/presence/' + pageId, { method: 'DELETE', keepalive: true }).catch(function () {});
  });
}());

(function () {
  var bar = document.getElementById('presence-bar');
  if (!bar) return;

  var pageId = bar.dataset.pageId;
  var currentUserId = bar.dataset.userId;
  var userAvatar = bar.dataset.userAvatar || '';
  var indicator = document.getElementById('sync-indicator');

  // HLC: "<ms>.<counter>.<userId>" — lexicographic ordering is correct.
  var hlcCounter = 0;
  function nextHlc() {
    return Date.now() + '.' + (++hlcCounter).toString().padStart(6, '0') + '.' + currentUserId;
  }

  // register[path] = { value, hlc } — our local replica of the LWW state,
  // updated from BOTH our own edits and remote ops. It lets us:
  //   (a) reject stale remote ops, and
  //   (b) replay un-synced local edits when we (re)connect — including edits
  //       typed while we were solo and live sync was still disabled.
  var register = {};

  // baseline[path] = the last-saved value (the field's value at page load, and
  // refreshed whenever the page is saved). Fields revert here when an editor
  // abandons their unsaved changes.
  var baseline = {};

  var ws = null;
  var reconnectTimer = null;
  var liveSyncEnabled = false;

  function findField(path) {
    var escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return document.querySelector('[name="' + escaped + '"]');
  }

  function sendRaw(path, value, hlc) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'op', path: path, value: value, hlc: hlc, opId: crypto.randomUUID(),
    }));
  }

  function setSyncStatus(status) {
    if (!indicator) return;
    if (status === 'idle') {
      indicator.style.display = 'none';
      indicator.title = '';
    } else if (status === 'connected') {
      indicator.style.display = '';
      indicator.style.background = '#10b981';
      indicator.title = indicator.getAttribute('data-title-connected') || 'Live sync active';
    } else if (status === 'connecting') {
      indicator.style.display = '';
      indicator.style.background = '#f59e0b';
      indicator.title = indicator.getAttribute('data-title-connecting') || 'Connecting…';
    } else {
      indicator.style.display = '';
      indicator.style.background = '#9ca3af';
      indicator.title = indicator.getAttribute('data-title-disconnected') || 'Sync disconnected — changes still save normally';
    }
  }

  function applyRemote(op) {
    if (!op || op.userId === currentUserId) return;
    var path = op.path;
    var value = op.value != null ? String(op.value) : '';

    // LWW: ignore anything not strictly newer than what we already hold. This
    // also protects active typing — each local keystroke stamps register with a
    // newer HLC, so a slower remote op for the same field is rejected right here.
    // (We must NOT additionally skip on focus: a field can be focused/parked
    // without being edited, and that field still needs to receive updates.)
    var cur = register[path];
    if (cur && cur.hlc >= (op.hlc || '')) return;
    register[path] = { value: value, hlc: op.hlc };

    var el = findField(path);
    if (el) el.value = value;
  }

  function sendOp(el) {
    // Always record the edit locally, even while disabled/disconnected, so it
    // can be replayed on connect. Sending happens only when the socket is open.
    var hlc = nextHlc();
    register[el.name] = { value: el.value, hlc: hlc };
    sendRaw(el.name, el.value, hlc);
  }

  // Attach listeners to all lect-encoded form fields.
  // Names follow the lect convention: starts with . @ * or # (digit).
  document.querySelectorAll('input[name], textarea[name], select[name]').forEach(function (el) {
    var name = el.getAttribute('name') || '';
    if (!/^[.@*#\d]/.test(name)) return;
    baseline[name] = el.value;
    el.addEventListener('input',  function () { sendOp(el); });
    el.addEventListener('change', function () { sendOp(el); });
    el.addEventListener('focus',  function () { sendFocus(el.name); });
    el.addEventListener('blur',   function () { sendBlur(el.name); });
  });

  // Force a field to a value regardless of LWW state (used by reset). Safe to
  // apply even when focused: reset only targets fields the local user has no
  // newer op for, so it never clobbers something they're actively editing.
  function forceField(path, value) {
    var el = findField(path);
    if (el) el.value = value;
  }

  // ── Live editing highlights ──────────────────────────────────────────────
  // editorsByPath[path] = { userId: { name, color, avatar } } — who else is
  // currently in each field. Drives a coloured outline + corner badge.
  var editorsByPath = {};
  var badgeEls = {};
  var highlightOverlay = document.createElement('div');
  highlightOverlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:60';
  document.body.appendChild(highlightOverlay);

  function userColor(userId) {
    var palette = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316'];
    var h = 0;
    for (var i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) & 0xffffff;
    return palette[Math.abs(h) % palette.length];
  }

  function initials(name) {
    return (name || '?').trim().split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
  }

  function positionBadge(path) {
    var badge = badgeEls[path];
    var el = findField(path);
    if (!badge || !el) return;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) { badge.style.display = 'none'; return; }
    badge.style.display = 'flex';
    badge.style.left = r.right + 'px';
    badge.style.top = r.top + 'px';
  }

  function renderHighlight(path) {
    var el = findField(path);
    var users = editorsByPath[path] ? Object.keys(editorsByPath[path]) : [];
    if (!el || !users.length) {
      if (badgeEls[path]) { badgeEls[path].remove(); delete badgeEls[path]; }
      if (el) el.style.outline = '';
      return;
    }
    var color = editorsByPath[path][users[0]].color;
    el.style.outline = '2px solid ' + color;
    el.style.outlineOffset = '1px';

    var badge = badgeEls[path];
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;display:flex;gap:2px;transform:translate(-50%,-50%)';
      highlightOverlay.appendChild(badge);
      badgeEls[path] = badge;
    }
    badge.replaceChildren();
    users.forEach(function (uid) {
      var info = editorsByPath[path][uid];
      var title = info.name + ' is editing';
      var node;
      if (info.avatar) {
        node = document.createElement('img');
        node.src = info.avatar;
        node.alt = '';
        node.style.objectFit = 'cover';
      } else {
        node = document.createElement('div');
        node.textContent = initials(info.name);
        node.style.background = info.color;
        node.style.color = '#fff';
        node.style.fontSize = '9px';
        node.style.fontWeight = '700';
        node.style.display = 'flex';
        node.style.alignItems = 'center';
        node.style.justifyContent = 'center';
      }
      node.title = title;
      node.style.width = '18px';
      node.style.height = '18px';
      node.style.borderRadius = '50%';
      node.style.border = '2px solid #fff';
      node.style.boxShadow = '0 0 0 1px ' + info.color;
      badge.appendChild(node);
    });
    positionBadge(path);
  }

  function setFieldEditor(path, userId, info) {
    if (!editorsByPath[path]) editorsByPath[path] = {};
    editorsByPath[path][userId] = info;
    renderHighlight(path);
  }

  function removeFieldEditor(path, userId) {
    var entry = editorsByPath[path];
    if (entry) {
      delete entry[userId];
      if (!Object.keys(entry).length) delete editorsByPath[path];
    }
    renderHighlight(path);
  }

  function removeUserHighlights(userId) {
    Object.keys(editorsByPath).forEach(function (path) {
      if (editorsByPath[path][userId]) removeFieldEditor(path, userId);
    });
  }

  function clearAllHighlights() {
    Object.keys(badgeEls).forEach(function (path) {
      badgeEls[path].remove();
      var el = findField(path);
      if (el) el.style.outline = '';
    });
    badgeEls = {};
    editorsByPath = {};
  }

  function repositionBadges() {
    Object.keys(badgeEls).forEach(positionBadge);
  }
  window.addEventListener('scroll', repositionBadges, true);
  window.addEventListener('resize', repositionBadges);

  function sendFocus(path) {
    if (!liveSyncEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'focus', path: path, userAvatar: userAvatar }));
  }

  function sendBlur(path) {
    if (!liveSyncEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'blur', path: path }));
  }

  function connect() {
    if (!liveSyncEnabled) return;
    if (ws && ws.readyState < 2) return; // already CONNECTING or OPEN
    clearTimeout(reconnectTimer);
    setSyncStatus('connecting');

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/admin/api/sync/' + pageId);

    ws.onopen = function () {
      setSyncStatus('connected');
      ws.send(JSON.stringify({ type: 'sync' }));
      // Announce the field we're already in, if any, so peers highlight it.
      var active = document.activeElement;
      if (active && active.name && /^[.@*#\d]/.test(active.name)) sendFocus(active.name);
    };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'snapshot') {
        // 1. Pull: apply the server's state (applyRemote skips our own + stale).
        //    Ops are per-(path,user), so track the highest HLC seen per path.
        var serverMax = {};
        (msg.ops || []).forEach(function (op) {
          if (!serverMax[op.path] || op.hlc > serverMax[op.path]) serverMax[op.path] = op.hlc;
          applyRemote(op);
        });
        // 2. Push: replay local edits the server hasn't seen yet — this is what
        //    propagates work done while solo, and makes connect bidirectional.
        Object.keys(register).forEach(function (path) {
          var r = register[path];
          if (!serverMax[path] || r.hlc > serverMax[path]) sendRaw(path, r.value, r.hlc);
        });
      } else if (msg.type === 'op') {
        // Real-time broadcast — server never echoes back to sender.
        applyRemote(msg);
        // Typing implies the user is in that field; show it even if we missed
        // their focus event — but don't override a focus that carried an avatar.
        if (!editorsByPath[msg.path] || !editorsByPath[msg.path][msg.userId]) {
          setFieldEditor(msg.path, msg.userId, { name: msg.userName, color: userColor(msg.userId), avatar: '' });
        }
      } else if (msg.type === 'focus') {
        setFieldEditor(msg.path, msg.userId, {
          name: msg.userName, color: userColor(msg.userId), avatar: msg.userAvatar || '',
        });
      } else if (msg.type === 'blur') {
        if (msg.clearAll) removeUserHighlights(msg.userId);
        else removeFieldEditor(msg.path, msg.userId);
      } else if (msg.type === 'reset') {
        // An editor left without saving; their abandoned fields fall back to the
        // next editor's value, or to the saved baseline. Force past LWW.
        (msg.entries || []).forEach(function (entry) {
          if (entry.baseline) {
            delete register[entry.path];
            forceField(entry.path, baseline[entry.path] != null ? baseline[entry.path] : '');
          } else {
            register[entry.path] = { value: entry.value, hlc: entry.hlc };
            forceField(entry.path, entry.value);
          }
        });
      } else if (msg.type === 'saved') {
        // Page was saved: current on-screen values are the new baseline; the
        // live overlay is committed, so clear it.
        Object.keys(baseline).forEach(function (path) {
          var el = findField(path);
          if (el) baseline[path] = el.value;
        });
        register = {};
      }
    };

    ws.onclose = ws.onerror = function () {
      // Remote highlights are stale once we lose the connection.
      clearAllHighlights();
      if (!liveSyncEnabled) {
        setSyncStatus('idle');
        return;
      }
      setSyncStatus('disconnected');
      reconnectTimer = setTimeout(connect, 4000);
    };
  }

  function disconnect() {
    liveSyncEnabled = false;
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = ws.onerror = null;
      try { ws.close(1000, 'No co-editors'); } catch {}
      ws = null;
    }
    clearAllHighlights();
    setSyncStatus('idle');
  }

  // Exposed to the presence script so it can drive live-sync activation.
  window.__cmsSync = {
    enable: function () {
      if (liveSyncEnabled) return; // already active
      liveSyncEnabled = true;
      connect();
    },
    disable: disconnect,
  };

  window.addEventListener('beforeunload', function () {
    if (ws) try { ws.close(1001, 'Leaving'); } catch {}
  });
}());
  }

  window.WorkerCmsEditor = { scan: scan };
  scan();
})();
