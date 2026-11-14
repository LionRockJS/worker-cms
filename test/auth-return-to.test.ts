import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { adminReturnTo } from '../src/core/auth/return-to';
import { loginPage } from '../src/core/templates/login';

describe('login return page', () => {
  it.each([
    '/admin', '/admin/pages/list?page=3&filter=draft#rows', '/admin/plugins/events/42',
  ])('keeps an admin URL: %s', value => expect(adminReturnTo(value)).toBe(value));

  it.each([
    undefined, '', 'https://evil.example/admin', '//evil.example/admin',
    '/\\evil.example/admin', '/admin/../../auth/logout', '/auth/logout',
    '/administrator', '/admin/%2f%2fevil.example', '/admin/%5cevil', '/admin/\nfoo',
  ])('rejects an unsafe return page: %s', value => expect(adminReturnTo(value)).toBe('/admin'));

  it('carries the return page into every provider link', async () => {
    const returnTo = '/admin/pages/list?page=3&filter=draft#rows';
    const html = await loginPage(env.VIEWS, { siteTitle: 'CMS', appIcon: 'key',
      appPrimaryColor: '#000000', appFont: 'system', providers: ['github', 'eventuai'],
      uiLocale: 'en', uiDirection: 'ltr', catalogHref: '/auth/i18n/catalog/en', returnTo });
    const payload = JSON.parse(html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s)![1]);
    for (const provider of payload.bodyView.data.providers) {
      const url = new URL(provider.href, 'https://cms.example.com');
      expect(url.searchParams.get('returnTo')).toBe(returnTo);
    }
  });
});
