import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from './plugin-fixtures';

// A canary x-plugin-secret is recorded and bans the caller from /auth, while
// the /__cms response stays identical to any other wrong secret.

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;
const CANARY = 'canary-plugin-secret-0123456789abcdef';
const REAL = 'real-plugin-secret-0123456789abcdef';

let counter = 0;
const nextIp = () => { counter++; return `10.124.${Math.floor(counter / 250)}.${counter % 250 + 1}`; };

function call(path: string, ip: string, ray: string, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://cms.example.com${path}`, {
    headers: { 'CF-Connecting-IP': ip, 'CF-Ray': ray, 'Sec-Fetch-Site': 'same-origin', ...headers },
  }));
}

async function canaryEvents(ray: string) {
  return (await env.DB.prepare("SELECT detail FROM audit_events WHERE action = 'auth.access' AND request_id = ?")
    .bind(ray).all<{ detail: string }>()).results.map(row => JSON.parse(row.detail));
}

beforeEach(async () => {
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)').bind('Events', url, REAL).run();
  __injectPluginFetcher(url, { fetch: async () => Response.json({ id: 'events', name: 'Events', version: '1.0.0' }) } as unknown as Fetcher);
  testEnv.CANARY_PLUGIN_SECRET = CANARY;
});

afterEach(() => { delete testEnv.CANARY_PLUGIN_SECRET; });

describe('canary plugin secret', () => {
  it('answers like a wrong secret, records the canary, and bans the IP from /auth', async () => {
    const wrongIp = nextIp();
    const wrong = await call('/__cms/limits', wrongIp, 'canary-wrong', { 'x-plugin-id': 'events', 'x-plugin-secret': 'not-it' });
    const ip = nextIp();
    const tripped = await call('/__cms/limits', ip, 'canary-hit', { 'x-plugin-id': 'events', 'x-plugin-secret': CANARY });

    expect(tripped.status).toBe(wrong.status);
    expect(await tripped.json()).toEqual(await wrong.json());
    expect(await canaryEvents('canary-hit')).toEqual([{ reason: 'canary_credential' }]);
    expect((await call('/auth/login', ip, 'canary-after')).status).toBe(403);

    // An ordinary wrong secret records no canary and bans nothing.
    expect(await canaryEvents('canary-wrong')).toEqual([]);
    expect((await call('/auth/login', wrongIp, 'canary-wrong-after')).status).toBe(200);
  });

  it('records the canary even when the caller names an unknown plugin', async () => {
    const ip = nextIp();
    const response = await call('/__cms/limits', ip, 'canary-unknown', { 'x-plugin-id': 'nope', 'x-plugin-secret': CANARY });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'unknown_plugin' });
    expect(await canaryEvents('canary-unknown')).toEqual([{ reason: 'canary_credential' }]);
  });

  it('never authenticates, even if a plugin row holds the canary value', async () => {
    await env.DB.prepare('UPDATE plugins SET secret = ?').bind(CANARY).run();
    clearManifestCache();
    const response = await call('/__cms/limits', nextIp(), 'canary-row', { 'x-plugin-id': 'events', 'x-plugin-secret': CANARY });
    expect(response.status).toBe(403);
  });

  it('does nothing when no canary is configured', async () => {
    delete testEnv.CANARY_PLUGIN_SECRET;
    const ip = nextIp();
    const response = await call('/__cms/limits', ip, 'canary-off', { 'x-plugin-id': 'events', 'x-plugin-secret': CANARY });
    expect(response.status).toBe(403);
    expect(await canaryEvents('canary-off')).toEqual([]);
    expect((await call('/auth/login', ip, 'canary-off-after')).status).toBe(200);
  });
});
