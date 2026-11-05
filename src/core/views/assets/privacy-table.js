(function() {
  'use strict';

  if (window.WorkerCmsPrivacyTable) {
    window.WorkerCmsPrivacyTable.scan();
    return;
  }

  var STORAGE_KEY = 'worker-cms-privacy-revealed';
  var MASK = '***';

  function currentIconHrefPrefix() {
    var script = document.currentScript;
    if (!(script instanceof HTMLScriptElement)) return '/assets/icons.svg';
    var revision = new URL(script.src, window.location.href).searchParams.get('r') || '';
    return '/assets/icons.svg' + (revision ? '?r=' + encodeURIComponent(revision) : '');
  }

  var ICON_HREF_PREFIX = currentIconHrefPrefix();

  function storedRevealed() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function persistRevealed(revealed) {
    try {
      window.localStorage.setItem(STORAGE_KEY, revealed ? '1' : '0');
    } catch (error) {
      /* ignore */
    }
  }

  function normalizedHeader(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function privateHeaderKind(value) {
    var label = normalizedHeader(value);
    if (label === 'email') return 'email';
    if (label === 'phone') return 'phone';
    if (label === 'name / contact') return 'contact';
    if (label === 'name' || label === 'name / email') return 'name';
    return '';
  }

  function privateColumnIndexes(table) {
    var headRow = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
    if (!headRow) return [];
    return Array.from(headRow.cells).reduce(function(indexes, cell, index) {
      var kind = privateHeaderKind(cell.textContent);
      if (kind) indexes.push({ index: index, kind: kind });
      return indexes;
    }, []);
  }

  function explicitTargets(table) {
    return Array.from(table.querySelectorAll('[data-private-field]'));
  }

  function fallbackTargets(table) {
    var indexes = privateColumnIndexes(table);
    if (!indexes.length || explicitTargets(table).length) return [];

    return Array.from(table.tBodies).flatMap(function(tbody) {
      return Array.from(tbody.rows).flatMap(function(row) {
        if (row.hasAttribute('data-table-filter-empty')) return [];
        return indexes
          .map(function(column) {
            var cell = row.cells[column.index];
            if (cell && !cell.hasAttribute('data-private-field')) {
              cell.setAttribute('data-private-field', column.kind);
            }
            return cell;
          })
          .filter(function(cell) { return cell; });
      });
    });
  }

  function privateTargets(table) {
    return explicitTargets(table).concat(fallbackTargets(table));
  }

  // Original cell content, kept as cloned nodes (never re-parsed as HTML).
  var originals = new WeakMap();

  function ensureOriginal(target) {
    if (!originals.has(target)) {
      var content = document.createDocumentFragment();
      Array.from(target.childNodes).forEach(function(node) {
        content.appendChild(node.cloneNode(true));
      });
      originals.set(target, { content: content, text: target.textContent || '' });
    }
    if (!target.hasAttribute('data-private-mask')) {
      target.setAttribute(
        'data-private-mask',
        maskValue(originals.get(target).text, target.getAttribute('data-private-field') || ''),
      );
    }
  }

  function setMasked(target, masked) {
    if (masked) {
      ensureOriginal(target);
      var maskedValue = target.hasAttribute('data-private-mask')
        ? target.getAttribute('data-private-mask') || ''
        : MASK;
      if (target.getAttribute('data-private-masked') === '1' && target.textContent === maskedValue) return;
      target.textContent = maskedValue;
      target.setAttribute('data-private-masked', '1');
      return;
    }
    if (target.getAttribute('data-private-masked') !== '1') return;
    var original = originals.get(target);
    if (original) target.replaceChildren(original.content.cloneNode(true));
    else target.replaceChildren();
    target.removeAttribute('data-private-masked');
  }

  function maskValue(value, kind) {
    var text = String(value || '').trim();
    if (!text) return '';

    if (kind === 'email' || text.includes('@')) return maskEmail(text);
    if (kind === 'phone') return maskToken(text.replace(/\s+/g, ''));
    return text.split(/([\s·]+)/).map(function(part) {
      return /^[\s·]+$/.test(part) ? part : maskToken(part);
    }).join('');
  }

  function maskEmail(value) {
    var at = value.indexOf('@');
    if (at <= 0) return maskToken(value);

    var local = value.slice(0, at);
    var domain = value.slice(at + 1);
    var domainParts = domain.split('.');
    if (domainParts.length < 2) return maskToken(local) + '@' + maskToken(domain);

    return maskToken(local) + '@' + maskToken(domainParts[0]) + '.' + domainParts.slice(1).join('.');
  }

  function maskToken(value) {
    var chars = Array.from(String(value || ''));
    if (!chars.length) return '';
    if (chars.length <= 4) return chars[0] + MASK;
    if (/[A-Za-z]/.test(value)) return chars.slice(0, 2).join('') + MASK + chars[chars.length - 1];
    return chars[0] + MASK + chars[chars.length - 1];
  }

  function controlFor(table) {
    if (!table.parentElement) return null;
    var tableParent = table.parentElement;
    var scrollContainer = tableParent.classList.contains('overflow-x-auto') ? tableParent : table;
    var host = scrollContainer.parentElement;
    if (!host) return null;

    var existing = Array.from(host.children).find(function(child) {
      return child.hasAttribute('data-privacy-control');
    });
    if (!existing && scrollContainer !== table) {
      existing = Array.from(scrollContainer.children).find(function(child) {
        return child.hasAttribute('data-privacy-control');
      });
      if (existing) host.insertBefore(existing, scrollContainer);
    }
    if (existing) return existing.querySelector('[data-privacy-toggle]');

    var row = document.createElement('div');
    row.setAttribute('data-privacy-control', '');
    row.className = 'flex justify-end px-4 py-3';

    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-privacy-toggle', '');
    button.className = 'inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50';
    button.innerHTML = '<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="' + ICON_HREF_PREFIX + '#eye-off"></use></svg><span data-privacy-toggle-label></span>';
    row.appendChild(button);

    host.insertBefore(row, scrollContainer);
    return button;
  }

  function renderControls() {
    var revealed = storedRevealed();
    var root = document.documentElement;
    var revealLabel = root.getAttribute('data-privacy-reveal-label') || 'Reveal';
    var hideLabel = root.getAttribute('data-privacy-hide-label') || 'Hide';
    var revealFieldsLabel = root.getAttribute('data-privacy-reveal-fields-label') || 'Reveal private fields';
    var hideFieldsLabel = root.getAttribute('data-privacy-hide-fields-label') || 'Hide private fields';
    document.querySelectorAll('[data-privacy-toggle]').forEach(function(button) {
      button.setAttribute('aria-pressed', revealed ? 'true' : 'false');
      button.setAttribute('aria-label', revealed ? hideFieldsLabel : revealFieldsLabel);
      button.setAttribute('title', (revealed ? hideFieldsLabel : revealFieldsLabel) + ' (Alt+Shift+R)');
      var label = button.querySelector('[data-privacy-toggle-label]');
      if (label) label.textContent = revealed ? hideLabel : revealLabel;
    });
  }

  function apply(table) {
    var targets = privateTargets(table);
    if (!targets.length) return;
    controlFor(table);
    var masked = !storedRevealed();
    targets.forEach(function(target) {
      setMasked(target, masked);
    });
  }

  function scan(root) {
    (root || document).querySelectorAll('table[data-privacy-table]').forEach(function(table) {
      apply(table);
    });
    renderControls();
  }

  function toggleRevealed() {
    persistRevealed(!storedRevealed());
    scan(document);
  }

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest('input, textarea, select')) return true;
    var editable = target.closest('[contenteditable]');
    return editable instanceof HTMLElement && editable.isContentEditable;
  }

  document.addEventListener('click', function(event) {
    var button = event.target instanceof Element ? event.target.closest('[data-privacy-toggle]') : null;
    if (!button) return;
    event.preventDefault();
    toggleRevealed();
  });

  document.addEventListener('keydown', function(event) {
    if (event.repeat || isTypingTarget(event.target)) return;
    var isRevealShortcut = event.code === 'KeyR' || event.key.toLowerCase() === 'r';
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && isRevealShortcut) {
      event.preventDefault();
      toggleRevealed();
    }
  });

  var queued = false;
  function queueScan() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function() {
      queued = false;
      scan(document);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { scan(document); });
  } else {
    scan(document);
  }

  new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
  window.WorkerCmsPrivacyTable = { scan: scan };
})();
