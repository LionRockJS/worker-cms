// Wires picture pagefields ([data-picture-field]): URL input preview + file
// upload to /admin/upload. Loaded as a core admin asset (not inline in the
// snippet) so it also works where inline scripts never run: the client
// renderer re-executes nonce'd layout scripts after replacing the DOM, and
// plugin-rendered views have all inline scripts stripped by sanitizePluginHtml.
// Re-executions call scan() again, so newly rendered fields get wired.
(function () {
  if (window.WorkerCmsPictureField) {
    window.WorkerCmsPictureField.scan(document);
    return;
  }

  function previewUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    try {
      const source = new URL(value, window.location.origin);
      if (!['http:', 'https:', 'blob:'].includes(source.protocol)) return '';
      if (source.origin !== window.location.origin) return source.href;
      if (!source.pathname.startsWith('/media/')) return source.href;
      return `/media-preview/${source.pathname.replace(/^\/media\//, '')}${source.search}`;
    } catch {
      return '';
    }
  }

  // Plain text of an HTML error body. DOMParser never runs scripts.
  function cleanResponseText(value) {
    const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
    doc.querySelectorAll('script, style').forEach((node) => node.remove());
    const text = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 180);
  }

  function uploadErrorMessage(response, result, cmsError, rawBody) {
    const detail = (result && result.error) || cmsError || cleanResponseText(rawBody);
    return detail ? `${detail} (${response.status})` : `Upload failed (${response.status})`;
  }

  function wire(root) {
    const fileInput = root.querySelector('[data-picture-file]');
    const urlInput = root.querySelector('[data-picture-url]');
    const preview = root.querySelector('[data-picture-preview]');
    const empty = root.querySelector('[data-picture-empty]');
    const status = root.querySelector('[data-picture-status]');

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

    if (urlInput?.value.trim()) setPreview(urlInput.value.trim());
    urlInput?.addEventListener('input', () => setPreview(urlInput.value.trim()));

    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (status) status.textContent = 'Uploading...';

      const form = new FormData();
      // The file pagefield reuses this wiring with its own upload directory.
      form.append('dir', root.dataset.uploadDir || 'pictures');
      form.append('file', file);

      try {
        const response = await fetch(new URL('/admin/upload', window.location.origin), {
          method: 'POST',
          body: form,
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        const contentType = response.headers.get('content-type') || '';
        const rawBody = await response.text();
        const cmsError = response.headers.get('x-cms-error') || '';
        let result = null;
        if (contentType.includes('application/json') && rawBody) {
          try {
            result = JSON.parse(rawBody);
          } catch {
            result = null;
          }
        }
        const url = result && result.success && Array.isArray(result.files) ? result.files[0] : '';
        if (!response.ok) throw new Error(uploadErrorMessage(response, result, cmsError, rawBody));
        if (!url) throw new Error(result?.error || 'Upload returned no file URL');

        urlInput.value = url;
        setPreview(url);
        if (status) status.textContent = 'Uploaded';
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : 'Upload failed';
      } finally {
        fileInput.value = '';
      }
    });
  }

  function scan(scope) {
    scope.querySelectorAll('[data-picture-field]').forEach((root) => {
      if (root.dataset.pictureUploadReady === 'true') return;
      root.dataset.pictureUploadReady = 'true';
      wire(root);
    });
  }

  window.WorkerCmsPictureField = { scan };
  scan(document);
})();
