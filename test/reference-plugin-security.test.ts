import { describe, expect, it } from 'vitest';
import plugin from '../docs/examples/plugin-events/src/index';

const env = { PLUGIN_SECRET: 'reference-plugin-dedicated-secret' };

describe('reference events plugin authentication', () => {
  it.each([
    ['missing', undefined],
    ['wrong', 'wrong-secret'],
  ])('fails closed on a %s secret for protected endpoints', async (_label, secret) => {
    const response = await plugin.fetch(new Request('https://events.example/__plugin/publish/page', {
      method: 'POST',
      headers: secret ? { 'x-plugin-secret': secret } : undefined,
      body: JSON.stringify({ uuid: 'page-1' }),
    }), env);
    expect(response.status).toBe(403);
  });

  it('accepts the matching registration secret and leaves public discovery available', async () => {
    const [publish, manifest] = await Promise.all([
      plugin.fetch(new Request('https://events.example/__plugin/publish/page', {
        method: 'POST',
        headers: { 'x-plugin-secret': env.PLUGIN_SECRET },
        body: JSON.stringify({ uuid: 'page-1' }),
      }), env),
      plugin.fetch(new Request('https://events.example/__plugin/manifest'), {}),
    ]);

    expect(publish.status).toBe(200);
    expect(manifest.status).toBe(200);
  });
});
