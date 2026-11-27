// Preview manually entered and uploaded picture URLs.
(function () {
  if (window.WorkerCmsPictureField) {
    window.WorkerCmsPictureField.scan(document);
    return;
  }

  // Optional features (media) map a URL to a cheaper preview URL.
  const rewriters = [];

  function previewUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    try {
      const source = new URL(value, window.location.origin);
      if (!['http:', 'https:', 'blob:'].includes(source.protocol)) return '';
      for (const rewrite of rewriters) {
        const rewritten = rewrite(source);
        if (rewritten) return rewritten;
      }
      return source.href;
    } catch {
      return '';
    }
  }

  function wire(root) {
    const urlInput = root.querySelector('[data-picture-url]');
    const preview = root.querySelector('[data-picture-preview]');
    const empty = root.querySelector('[data-picture-empty]');

    function setPreview(url) {
      if (!preview) return;
      const src = url ? previewUrl(url) : '';
      if (src) {
        preview.dataset.originalSrc = url;
        preview.src = src;
        preview.classList.remove('hidden');
        if (empty) empty.classList.add('hidden');
      } else {
        preview.removeAttribute('src');
        delete preview.dataset.originalSrc;
        preview.classList.add('hidden');
        if (empty) empty.classList.remove('hidden');
      }
    }

    preview?.addEventListener('error', () => {
      const original = preview.dataset.originalSrc || '';
      if (original && preview.src !== new URL(original, window.location.origin).href) {
        preview.src = original;
      }
    });

    const refresh = () => {
      if (urlInput?.value.trim()) setPreview(urlInput.value.trim());
    };
    refreshers.push(refresh);
    refresh();
    urlInput?.addEventListener('input', () => setPreview(urlInput.value.trim()));
  }

  const refreshers = [];

  function addPreviewRewriter(rewrite) {
    rewriters.push(rewrite);
    refreshers.forEach((refresh) => refresh());
  }

  function scan(scope) {
    scope.querySelectorAll('[data-picture-field]').forEach((root) => {
      if (root.dataset.picturePreviewReady === 'true') return;
      root.dataset.picturePreviewReady = 'true';
      wire(root);
    });
  }

  window.WorkerCmsPictureField = { scan, addPreviewRewriter };
  scan(document);
})();
