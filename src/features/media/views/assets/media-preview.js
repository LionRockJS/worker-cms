// Preview same-origin /media/ pictures through the resized /media-preview/ route.
(function () {
  const field = window.WorkerCmsPictureField;
  if (!field || field.mediaPreviewReady) return;
  field.mediaPreviewReady = true;
  field.addPreviewRewriter((source) => {
    if (source.origin !== window.location.origin || !source.pathname.startsWith('/media/')) return '';
    return `/media-preview/${source.pathname.replace(/^\/media\//, '')}${source.search}`;
  });
})();
