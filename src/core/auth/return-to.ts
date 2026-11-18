/** Only return to CMS admin pages; never accept an external redirect or auth loop. */
export function adminReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/.test(value)) return '/admin';
  try {
    const url = new URL(value, 'https://cms.invalid');
    if (url.origin !== 'https://cms.invalid'
        || (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/'))
        || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)) return '/admin';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/admin';
  }
}
