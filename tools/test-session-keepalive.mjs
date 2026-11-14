// Run the actual scripts from both admin shells with a browser/clock fixture.
// Node is used because the Worker test runtime correctly disallows dynamic eval.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sources = [
  ['bootstrap', '../src/core/render/layout.ts'],
  ['Liquid layout', '../src/core/views/layout/default.liquid'],
];

for (const [name, file] of sources) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = source.lastIndexOf('(function()', source.indexOf('if (window.__cmsSessionKeepaliveBound)'));
  const end = source.indexOf('})();', start) + 5;
  const script = source.slice(start, end);

  function browser() {
    let now = 1_000_000;
    let tick;
    let interval;
    let response = { status: 200, ok: true };
    const requests = [];
    const events = {};
    const document = { visibilityState: 'visible', hasFocus: () => true,
      addEventListener: (type, listener) => { events[type] = listener; } };
    const window = { location: { href: '/admin/pages/list', pathname: '/admin/pages/list', search: '?page=3&filter=draft', hash: '#rows' },
      addEventListener: (type, listener) => { events[type] = listener; },
      setInterval: (listener, delay) => { tick = listener; interval = delay; } };
    const context = { document, window, Date: { now: () => now }, fetch: async (url, options) => {
      requests.push({ url, ...options });
      return response;
    } };
    runInNewContext(script, context);
    return { document, window, requests, events, context,
      advance: (ms) => { now += ms; },
      tick: async () => { now += interval; await tick(); },
      respond: (value) => { response = value; },
    };
  }

  for (const focused of [true, false]) {
    test(`${name}: visible reading with focus=${focused} keeps reporting activity beyond the idle window`, async () => {
      const page = browser();
      page.document.hasFocus = () => focused;
      for (let i = 0; i < 108; i++) await page.tick(); // nine hours, without input
      assert.equal(page.requests.length, 108);
      for (const request of page.requests) {
        assert.equal(request.url, '/auth/refresh');
        assert.equal(request.method, 'POST');
        assert.equal(request.credentials, 'same-origin');
        assert.equal(request.headers['X-CMS-Idle-For'], '0');
        assert.equal(request.headers['X-CMS-Background'], undefined);
      }
    });
  }

  test(`${name}: hidden pages do not extend idle activity`, async () => {
    const page = browser();
    page.document.visibilityState = 'hidden';
    await page.tick();
    assert.equal(page.requests[0].headers['X-CMS-Background'], '1');
    assert.equal(page.requests[0].headers['X-CMS-Idle-For'], undefined);
  });

  test(`${name}: actual interaction still reports its age after becoming hidden`, async () => {
    const page = browser();
    page.advance(60_000);
    page.events.keydown();
    page.document.visibilityState = 'hidden';
    await page.tick();
    assert.equal(page.requests[0].headers['X-CMS-Idle-For'], '300');
    await page.tick();
    assert.equal(page.requests[1].headers['X-CMS-Background'], '1');
  });

  test(`${name}: rejected sessions still go to sign-in`, async () => {
    const page = browser();
    page.respond({ status: 401, ok: false });
    await page.tick();
    assert.equal(page.window.location.href, '/auth/login?returnTo=' + encodeURIComponent('/admin/pages/list?page=3&filter=draft#rows'));
  });

  test(`${name}: bootstrap and rendered layout cannot install duplicate timers`, () => {
    const page = browser();
    page.window.setInterval = () => assert.fail('duplicate keepalive');
    runInNewContext(script, page.context);
  });
}
