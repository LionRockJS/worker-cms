(function () {
  'use strict';

  function init() {
    var bar = document.getElementById('presence-bar');
    if (!bar || bar.dataset.cmsEditorSyncBound === '1') return;
    bar.dataset.cmsEditorSyncBound = '1';
    bindSync(bar);
    bindPresence(bar);
  }

  function bindPresence(bar) {
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
        var avatar = String(e.user_avatar || '');
        var idle = (now - new Date(e.last_active).getTime()) > IDLE_MS;
        var color = userColor(userId);
        var ring = idle ? '2px solid #9ca3af' : '2px solid ' + color;
        var opacity = idle ? '0.4' : '1';
        var label = userName + (idle ? ' (idle)' : '') + (userId === currentUserId ? ' (you)' : '');
        var node;
        if (avatar) {
          node = document.createElement('img');
          node.src = avatar;
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
    window.setInterval(sendHeartbeat, 30000);
    window.setInterval(refreshPresence, 8000);

    window.addEventListener('beforeunload', function () {
      fetch('/admin/api/presence/' + pageId, { method: 'DELETE', keepalive: true }).catch(function () {});
    });
  }

  function bindSync(bar) {
    var pageId = bar.dataset.pageId;
    var currentUserId = bar.dataset.userId;
    var userAvatar = bar.dataset.userAvatar || '';
    var indicator = document.getElementById('sync-indicator');
    var hlcCounter = 0;
    var register = {};
    var baseline = {};
    var textDocs = {};
    var ws = null;
    var reconnectTimer = null;
    var liveSyncEnabled = false;
    var editorsByPath = {};
    var badgeEls = {};
    var highlightOverlay = document.createElement('div');
    highlightOverlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:60';
    document.body.appendChild(highlightOverlay);

    function nextHlc() {
      return Date.now() + '.' + (++hlcCounter).toString().padStart(6, '0') + '.' + currentUserId;
    }

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

    function bytesToBase64(bytes) {
      var binary = '';
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }

    function base64ToBytes(value) {
      var binary = atob(String(value || ''));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    // Apply only the changed span. Y.Text turns these positional changes into
    // commutative operations, so concurrent edits to one richtext field merge.
    function replaceText(ytext, value, origin) {
      var before = ytext.toString();
      if (before === value) return;
      var prefix = 0;
      while (prefix < before.length && prefix < value.length && before[prefix] === value[prefix]) prefix++;
      var oldEnd = before.length;
      var newEnd = value.length;
      while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === value[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      ytext.doc.transact(function () {
        if (oldEnd > prefix) ytext.delete(prefix, oldEnd - prefix);
        if (newEnd > prefix) ytext.insert(prefix, value.slice(prefix, newEnd));
      }, origin);
    }

    function resetTextDocument(state) {
      var Y = window.WorkerCmsY;
      var richtext = window.WorkerCmsRichtextMd;
      if (state.doc) state.doc.destroy();
      var doc = new Y.Doc();
      var ytext = doc.getText('markdown');
      state.doc = doc;
      state.text = ytext;
      ytext.observe(function (_event, transaction) {
        if (transaction.origin !== 'local') richtext.applyCollaborativeMarkdown(state.root, ytext.toString());
      });
      doc.on('update', function (update, origin) {
        if (origin !== 'local' || !state.synced) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          state.dirty = true;
          return;
        }
        ws.send(JSON.stringify({ type: 'text-update', path: state.path, update: bytesToBase64(update) }));
      });
    }

    function bindRichtextCrdt() {
      var Y = window.WorkerCmsY;
      var richtext = window.WorkerCmsRichtextMd;
      if (!Y || !richtext) return;
      document.querySelectorAll('[data-richtext-md]').forEach(function (root) {
        var source = root.querySelector('[data-richtext-source][name]');
        var markdown = root.querySelector('[data-richtext-markdown]');
        if (!source || !markdown || textDocs[source.name]) return;
        var state = {
          doc: null,
          text: null,
          path: source.name,
          root: root,
          baseline: markdown.value,
          pending: markdown.value,
          synced: false,
          dirty: false,
        };
        textDocs[source.name] = state;
        resetTextDocument(state);
        root.addEventListener('cms:richtext-change', function (event) {
          var value = event.detail && typeof event.detail.markdown === 'string'
            ? event.detail.markdown
            : markdown.value;
          state.pending = value;
          if (state.synced) replaceText(state.text, value, 'local');
        });
      });
    }

    bindRichtextCrdt();

    function setSyncStatus(status) {
      if (!indicator) return;
      if (status === 'idle') {
        indicator.style.display = 'none';
        indicator.title = '';
      } else if (status === 'connected') {
        indicator.style.display = '';
        indicator.style.background = '#10b981';
        indicator.title = 'Live sync active';
      } else if (status === 'connecting') {
        indicator.style.display = '';
        indicator.style.background = '#f59e0b';
        indicator.title = 'Connecting...';
      } else {
        indicator.style.display = '';
        indicator.style.background = '#9ca3af';
        indicator.title = 'Sync disconnected - changes still save normally';
      }
    }

    function applyRemote(op) {
      if (!op || op.userId === currentUserId) return;
      var path = op.path;
      var value = op.value != null ? String(op.value) : '';
      var cur = register[path];
      if (cur && cur.hlc >= (op.hlc || '')) return;
      register[path] = { value: value, hlc: op.hlc };
      var el = findField(path);
      if (el) el.value = value;
    }

    function sendOp(el) {
      var hlc = nextHlc();
      register[el.name] = { value: el.value, hlc: hlc };
      sendRaw(el.name, el.value, hlc);
    }

    document.querySelectorAll('input[name], textarea[name], select[name]').forEach(function (el) {
      var name = el.getAttribute('name') || '';
      if (!/^[.@*#\d]/.test(name)) return;
      if (el.hasAttribute('data-richtext-source')) return;
      baseline[name] = el.value;
      el.addEventListener('input', function () { sendOp(el); });
      el.addEventListener('change', function () { sendOp(el); });
      el.addEventListener('focus', function () { sendFocus(el.name); });
      el.addEventListener('blur', function () { sendBlur(el.name); });
    });

    function forceField(path, value) {
      var el = findField(path);
      if (el) el.value = value;
    }

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
        node.title = info.name + ' is editing';
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
      if (ws && ws.readyState < 2) return;
      clearTimeout(reconnectTimer);
      setSyncStatus('connecting');
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/admin/api/sync/' + pageId);
      ws.onopen = function () {
        setSyncStatus('connected');
        ws.send(JSON.stringify({ type: 'sync' }));
        Object.keys(textDocs).forEach(function (path) {
          var state = textDocs[path];
          ws.send(JSON.stringify({ type: 'text-sync', path: path, baseline: state.baseline }));
        });
        var active = document.activeElement;
        if (active && active.name && /^[.@*#\d]/.test(active.name)) sendFocus(active.name);
      };
      ws.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (_error) { return; }
        if (msg.type === 'snapshot') {
          var serverMax = {};
          (msg.ops || []).forEach(function (op) {
            if (!serverMax[op.path] || op.hlc > serverMax[op.path]) serverMax[op.path] = op.hlc;
            applyRemote(op);
          });
          Object.keys(register).forEach(function (path) {
            var r = register[path];
            if (!serverMax[path] || r.hlc > serverMax[path]) sendRaw(path, r.value, r.hlc);
          });
        } else if (msg.type === 'op') {
          applyRemote(msg);
          if (!editorsByPath[msg.path] || !editorsByPath[msg.path][msg.userId]) {
            setFieldEditor(msg.path, msg.userId, { name: msg.userName, color: userColor(msg.userId), avatar: '' });
          }
        } else if (msg.type === 'text-sync') {
          var textState = textDocs[msg.path];
          if (!textState || !msg.update) return;
          var wasSynced = textState.synced;
          var pendingText = textState.pending;
          window.WorkerCmsY.applyUpdate(textState.doc, base64ToBytes(msg.update), 'remote');
          textState.synced = true;
          if (!wasSynced && pendingText !== textState.baseline) {
            replaceText(textState.text, pendingText, 'local');
          } else {
            window.WorkerCmsRichtextMd.applyCollaborativeMarkdown(textState.root, textState.text.toString());
          }
          textState.pending = textState.text.toString();
          if (textState.dirty) {
            var fullUpdate = window.WorkerCmsY.encodeStateAsUpdate(textState.doc);
            ws.send(JSON.stringify({ type: 'text-update', path: msg.path, update: bytesToBase64(fullUpdate) }));
            textState.dirty = false;
          }
        } else if (msg.type === 'text-update') {
          var remoteTextState = textDocs[msg.path];
          if (!remoteTextState || !msg.update) return;
          window.WorkerCmsY.applyUpdate(remoteTextState.doc, base64ToBytes(msg.update), 'remote');
        } else if (msg.type === 'focus') {
          setFieldEditor(msg.path, msg.userId, {
            name: msg.userName, color: userColor(msg.userId), avatar: msg.userAvatar || '',
          });
        } else if (msg.type === 'blur') {
          if (msg.clearAll) removeUserHighlights(msg.userId);
          else removeFieldEditor(msg.path, msg.userId);
        } else if (msg.type === 'reset') {
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
          Object.keys(baseline).forEach(function (path) {
            var el = findField(path);
            if (el) baseline[path] = el.value;
          });
          register = {};
          Object.keys(textDocs).forEach(function (path) {
            var state = textDocs[path];
            state.baseline = state.text.toString();
            state.pending = state.baseline;
            state.synced = false;
            state.dirty = false;
            resetTextDocument(state);
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'text-sync', path: path, baseline: state.baseline }));
            }
          });
        }
      };
      ws.onclose = ws.onerror = function () {
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
        try { ws.close(1000, 'No co-editors'); } catch (_error) {}
        ws = null;
      }
      clearAllHighlights();
      setSyncStatus('idle');
    }

    window.__cmsSync = {
      enable: function () {
        if (liveSyncEnabled) return;
        liveSyncEnabled = true;
        connect();
      },
      disable: disconnect,
    };

    window.addEventListener('beforeunload', function () {
      if (ws) try { ws.close(1001, 'Leaving'); } catch (_error) {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
