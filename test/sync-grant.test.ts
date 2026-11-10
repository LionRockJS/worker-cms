import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYNC_GRANT_TTL_SECONDS, mintSyncGrant, verifySyncGrant } from '../src/core/auth/sync-grant';

afterEach(() => vi.useRealTimers());

describe('sync grants', () => {
  it('verifies only for the session and page it was minted for', async () => {
    const grant = await mintSyncGrant('secret', '11', 42);
    expect(await verifySyncGrant('secret', grant, '11', 42)).toBeGreaterThan(Date.now() / 1000);
    expect(await verifySyncGrant('secret', grant, '12', 42)).toBeNull();
    expect(await verifySyncGrant('secret', grant, '11', 43)).toBeNull();
    expect(await verifySyncGrant('other', grant, '11', 42)).toBeNull();
  });

  it('rejects an extended expiry and an expired grant', async () => {
    const grant = await mintSyncGrant('secret', '11', 42);
    const [exp, signature] = grant.split('.');
    expect(await verifySyncGrant('secret', `${Number(exp) + 3600}.${signature}`, '11', 42)).toBeNull();
    expect(await verifySyncGrant('secret', 'garbage', '11', 42)).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (SYNC_GRANT_TTL_SECONDS + 1) * 1000);
    expect(await verifySyncGrant('secret', grant, '11', 42)).toBeNull();
  });
});
