import * as Y from 'yjs';

// editor-sync.js is a plain browser asset. Expose the bundled CRDT API before
// it runs, without adding a third-party script origin to the CMS CSP.
window.WorkerCmsY = Y;
