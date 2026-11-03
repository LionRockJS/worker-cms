import { describe, expect, it } from 'vitest';
import {
  canonicalHostResponse,
  rejectCrossOriginMutation,
  rejectCrossSiteRequest,
  withSensitiveCacheHeaders,
  withSecurityHeaders,
} from '../src/core/http/headers';
import { hasPermission, permissionsFor } from '../src/core/auth/roles';
import {
  blueprintToLect,
  getLectBlocks,
  getLectItems,
  getLectLocalizedValue,
  getLectPointer,
  getLectScalar,
  lectToPrint,
  mergeLects,
  postToLect,
  safeParseLect,
} from '../src/core/db/lect';
import { lectFromForm } from '../src/core/db/page-logic';
import type { CmsConfig } from '../src/cms-config';

describe('lect utilities', () => {
  it('builds the flatter lect shape from blueprint definitions', () => {
    const lect = blueprintToLect('default', {
      default: ['@date', 'name', 'link__label', 'link__url', '*parent', { items: ['@kind', 'name'] }],
    }, 'en');

    expect(lect._type).toBe('default');
    expect(getLectScalar(lect, 'date')).toBe('');
    expect(getLectLocalizedValue(lect, 'name', 'en')).toBe('');
    expect(getLectLocalizedValue(lect, 'link__label', 'en')).toBe('');
    expect(getLectLocalizedValue(lect, 'link__url', 'en')).toBe('');
    expect(getLectPointer(lect, 'parent')).toBe('');
    expect(getLectItems(lect, 'items')[0]).toEqual({
      _weight: 0,
      kind: '',
      name: { en: '' },
    });
  });

  it('coerces a localized value to text when read as a scalar field (blueprint drift)', () => {
    const lect = { name: { en: 'Main Menu', 'zh-hant': '主選單' } } as never;
    expect(getLectScalar(lect, 'name')).toBe('Main Menu');
    expect(getLectScalar({ name: {} } as never, 'name')).toBe('');
  });

  it('maps form field names into nested lect paths, items, pointers, and blocks', () => {
    const lect = postToLect({
      '@published': 'true',
      '*parent': '42',
      '.title|en': 'Hello',
      '.title|zh-hant': '你好',
      '.link__url|en': '/hello',
      '.items[0]@kind': 'primary',
      '.items[0].name|en': 'First item',
      '.items[0].links[0].label|en': 'Read more',
      '#0@date': '2026-06-04',
      '#0.subject|en': 'Block subject',
    }, 'en');

    expect(lect).toMatchObject({
      published: 'true',
      _pointers: { parent: '42' },
      title: { en: 'Hello', 'zh-hant': '你好' },
      link: { url: { en: '/hello' } },
      items: [{
        kind: 'primary',
        name: { en: 'First item' },
        links: [{ label: { en: 'Read more' } }],
      }],
      _blocks: [{
        date: '2026-06-04',
        subject: { en: 'Block subject' },
      }],
    });
  });

  it('lets an empty submitted pointer clear an existing pointer during form merge', () => {
    const config: CmsConfig = {
      defaultLanguage: 'en',
      languages: ['en'],
      blueprint: { rsvp: ['*event:page/basic', 'name'] },
      blocks: {},
      blockLists: {},
      taxonomies: {},
      taxonomyLists: {},
    };
    const existing = {
      _type: 'rsvp',
      _pointers: { event: '21867037820176' },
      name: { en: 'VIP list' },
    };
    const form = new FormData();
    form.set('lect_json', JSON.stringify(existing));
    form.set('*event', '');

    const lect = lectFromForm(config, 'rsvp', existing, form, 'en');

    expect(lect._pointers?.event).toBe('');
  });

  it('preserves compatibility with legacy original-style JSON', () => {
    const lect = safeParseLect(JSON.stringify({
      attributes: { _type: 'company', date: '2026-06-04' },
      pointers: { parent: 123 },
      values: {
        en: { name: 'Acme' },
        'zh-hant': { name: '雅克米' },
      },
      items: {
        contacts: [{ attributes: { _weight: 1 }, values: { en: { name: 'Ada' } } }],
      },
      blocks: [{ attributes: { _type: 'label' }, values: { en: { subject: 'News' } } }],
    }));

    expect(lect._type).toBe('company');
    expect(lect.date).toBe('2026-06-04');
    expect(lect._pointers).toEqual({ parent: 123 });
    expect(getLectLocalizedValue(lect, 'name', 'zh-hant', 'en')).toBe('雅克米');
    expect(getLectItems(lect, 'contacts')).toEqual([{
      _weight: 1,
      name: { en: 'Ada' },
    }]);
    expect(getLectBlocks(lect)).toEqual([{
      _type: 'label',
      _name: '',
      _weight: 0,
      subject: { en: 'News' },
    }]);
  });

  it('keeps a flat lect that only shares a key name with legacy original JSON', () => {
    const lect = safeParseLect(JSON.stringify({
      form: 'e_procurement',
      status: 'draft',
      values: '{"company":"CPD"}',
      tags: 'urgent',
    }));

    expect(lect).toMatchObject({ form: 'e_procurement', status: 'draft', values: '{"company":"CPD"}', tags: 'urgent' });
  });

  it('deep-merges objects while replacing repeatable arrays by index', () => {
    const merged = mergeLects(
      {
        title: { en: 'Fallback', 'zh-hant': '後備' },
        link: { label: { en: 'Open' }, url: { en: '/old' } },
        items: [{ _weight: 0, name: { en: 'Old' }, extra: 'keep' }],
      },
      {
        title: { en: 'Current' },
        link: { url: { en: '/new' } },
        items: [{ name: { en: 'New' } }],
      },
    );

    expect(merged.title).toEqual({ en: 'Current', 'zh-hant': '後備' });
    expect(merged.link).toEqual({ label: { en: 'Open' }, url: { en: '/new' } });
    expect(merged.items).toEqual([{ _weight: 0, name: { en: 'New' }, extra: 'keep' }]);
  });

  it('drops prototype-mutating keys from stored lect JSON and merges', () => {
    const parsed = safeParseLect('{"safe":"ok","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"_pointers":{"parent":"1","__proto__":"bad"}}');
    const merged = mergeLects(
      parsed,
      JSON.parse('{"nested":{"safe":"yes","__proto__":{"polluted":"yes"}}}') as never,
    );

    expect(parsed.safe).toBe('ok');
    expect(parsed._pointers).toEqual({ parent: '1' });
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false);
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false);
    expect(merged.nested).toEqual({ safe: 'yes' });
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it('localizes values, applies default-language fallback, and sorts by weight for rendering', () => {
    const printable = lectToPrint({
      title: { en: 'English title' },
      items: [
        { _weight: 10, name: { en: 'Second' } },
        { _weight: 1, name: { en: 'First' } },
      ],
      _blocks: [
        { _type: 'label', _weight: 2, subject: { en: 'Later' } },
        { _type: 'label', _weight: 0, subject: { en: 'Earlier' } },
      ],
    }, 'zh-hant', 'en');

    expect(printable.tokens.title).toBe('English title');
    expect((printable.tokens.items as unknown as Array<{ tokens: { name: string } }>).map((item) => item.tokens.name))
      .toEqual(['First', 'Second']);
    expect(printable.blocks.map((block) => block.tokens.subject)).toEqual(['Earlier', 'Later']);
  });
});

describe('security utilities', () => {
  it('redirects safe methods to the canonical origin', () => {
    const response = canonicalHostResponse(
      new Request('https://old.example.com/admin?flash=ok'),
      'https://cms.example.com',
    );

    expect(response?.status).toBe(308);
    expect(response?.headers.get('Location')).toBe('https://cms.example.com/admin?flash=ok');
  });

  it('rejects mutations sent to a non-canonical origin', async () => {
    const response = canonicalHostResponse(
      new Request('https://old.example.com/admin/pages', { method: 'POST' }),
      'https://cms.example.com',
    );

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toBe('Not Found');
  });

  it('allows localhost development hosts', () => {
    expect(canonicalHostResponse(
      new Request('http://localhost/admin'),
      'https://cms.example.com',
    )).toBeNull();
  });

  it('blocks unsafe cross-origin writes', async () => {
    const response = rejectCrossOriginMutation(
      new Request('https://cms.example.com/admin/pages', {
        method: 'POST',
        headers: { Origin: 'https://evil.example.com' },
      }),
    );

    expect(response?.status).toBe(403);
    await expect(response?.text()).resolves.toBe('Forbidden');
  });

  it('allows same-origin and configured origins', () => {
    expect(rejectCrossOriginMutation(
      new Request('https://cms.example.com/admin/pages', {
        method: 'POST',
        headers: { Origin: 'https://cms.example.com' },
      }),
    )).toBeNull();

    expect(rejectCrossOriginMutation(
      new Request('https://cms.example.com/admin/pages', {
        method: 'POST',
        headers: { Origin: 'https://admin.example.com' },
      }),
      ['https://admin.example.com'],
    )).toBeNull();
  });

  it('accepts a same-origin referer when Origin is absent', () => {
    expect(rejectCrossSiteRequest(
      new Request('https://cms.example.com/auth/logout', {
        headers: { Referer: 'https://cms.example.com/admin' },
      }),
    )).toBeNull();
  });

  it('adds the baseline browser hardening headers', () => {
    const response = withSecurityHeaders(new Response('ok'));

    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('preserves a Permissions-Policy a route already set (e.g. the kiosk enabling the camera)', () => {
    const response = withSecurityHeaders(
      new Response('ok', { headers: { 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()' } }),
    );

    expect(response.headers.get('Permissions-Policy')).toBe('camera=(self), microphone=(), geolocation=()');
  });

  it('marks authenticated surfaces as no-store without touching static paths', () => {
    const admin = withSensitiveCacheHeaders(
      new Response('ok'),
      new Request('https://cms.example.com/admin'),
    );
    const cmsApi = withSensitiveCacheHeaders(
      new Response('ok'),
      new Request('https://cms.example.com/__cms/pages'),
    );
    const asset = withSensitiveCacheHeaders(
      new Response('ok', { headers: { 'Cache-Control': 'public, max-age=86400' } }),
      new Request('https://cms.example.com/assets/admin.css'),
    );

    expect(admin.headers.get('Cache-Control')).toBe('no-store');
    expect(admin.headers.get('Pragma')).toBe('no-cache');
    expect(cmsApi.headers.get('Cache-Control')).toBe('no-store');
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });
});

describe('role capabilities', () => {
  it('grants admins every capability including destructive/global ops', () => {
    expect(hasPermission('admin', 'trash:purge')).toBe(true);
    expect(hasPermission('admin', 'plugin:access')).toBe(true);
    expect(hasPermission('admin', 'menu:manage')).toBe(true);
    expect(hasPermission('admin', 'content:write')).toBe(true);
  });

  it('lets editors author content but not purge or reach plugins', () => {
    expect(hasPermission('editor', 'content:write')).toBe(true);
    expect(hasPermission('editor', 'media:upload')).toBe(true);
    expect(hasPermission('editor', 'taxonomy:write')).toBe(true);
    expect(hasPermission('editor', 'trash:purge')).toBe(false);
    expect(hasPermission('editor', 'plugin:access')).toBe(false);
  });

  it('limits moderators to review actions only', () => {
    expect(hasPermission('moderator', 'content:publish')).toBe(true);
    expect(hasPermission('moderator', 'content:delete')).toBe(true);
    expect(hasPermission('moderator', 'trash:restore')).toBe(true);
    expect(hasPermission('moderator', 'content:write')).toBe(false);
    expect(hasPermission('moderator', 'taxonomy:write')).toBe(false);
    expect(hasPermission('moderator', 'media:upload')).toBe(false);
  });

  it('grants viewers nothing', () => {
    expect(permissionsFor('viewer').size).toBe(0);
  });

  it('unions capabilities across multiple roles', () => {
    expect(hasPermission('moderator,editor', 'content:write')).toBe(true);
    expect(hasPermission('moderator,editor', 'trash:purge')).toBe(false);
  });
});
