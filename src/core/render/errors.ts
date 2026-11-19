import { assetRevisionQuery, escHtml } from './layout';

export async function errorPage(views: Fetcher, opts: {
  status: 404 | 500;
  title: string;
  heading: string;
  message?: string;
  siteTitle: string;
  viewRevision?: string;
}): Promise<string> {
  void views;
  const revisionQuery = assetRevisionQuery(opts.viewRevision);
  const message = opts.message
    ? `<p class="mt-2 text-gray-500">${escHtml(opts.message)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.status} - ${escHtml(opts.title)} - ${escHtml(opts.siteTitle)}</title>
  <link rel="stylesheet" href="/assets/admin.css${escHtml(revisionQuery)}">
</head>
<body class="min-h-screen flex items-center justify-center bg-gray-50">
  <div class="text-center">
    <p class="text-6xl font-bold text-gray-300">${opts.status}</p>
    <h1 class="mt-4 text-2xl font-semibold text-gray-700">${escHtml(opts.heading)}</h1>
    ${message}
    <a href="/admin" title="Back to Dashboard" aria-label="Back to Dashboard"
       class="mt-6 inline-flex h-10 items-center justify-center gap-2 px-4 text-indigo-600 hover:underline">
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg${escHtml(revisionQuery)}#arrow-left"></use></svg>
      <span class="hidden lg:inline">Back to Dashboard</span>
    </a>
  </div>
</body>
</html>`;
}
