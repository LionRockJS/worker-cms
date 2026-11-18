// Upload picture and file fields in host and plugin editors.
(function () {
  if (window.WorkerCmsFieldUpload) {
    window.WorkerCmsFieldUpload.scan(document);
    return;
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
    const status = root.querySelector('[data-picture-status]');

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
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
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

  window.WorkerCmsFieldUpload = { scan };
  scan(document);
})();
