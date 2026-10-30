// Review signals, archive health, and the screen that shows them.
//
// The signals are the part of the design that makes the trail *examined* rather
// than merely written, so what matters is that each one fires on the shape it
// claims to detect and stays silent otherwise — a signal that cries wolf is one
// an operator learns to ignore, which is the same as having none.

import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import {
  archiveHealth,
  reviewSignals,
  BULK_READ_RECORDS,
  REFUSED_ATTEMPTS,
} from '../src/features/audit/signals';
import { sweepAuditEvents, verifyAuditArchive } from '../src/features/audit/sweep';
import type { Env } from '../src/types';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;
let ipCounter = 0;

async function adminFetch(path: string, role = 'admin'): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: role === 'admin' ? '1' : '2',
    email: `${role}@example.com`,
    name: `${role} user`,
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  ipCounter += 1;
  return worker.fetch(new IncomingRequest(new URL(path, 'http://localhost'), {
    redirect: 'manual',
    headers: {
      Cookie: `access_token=${token}`,
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': `10.66.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`,
    },
  }));
}

/** One read event, with everything the signals group by. */
async function seedRead(opts: {
  actorUserId?: string | null;
  actingVia?: string | null;
  dataClass?: string;
  container?: string;
  targetCount?: number;
  outcome?: string;
  eventClass?: string;
  sourceIp?: string | null;
  hoursAgo?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
       (event_id, occurred_at, event_class, data_class, retention_class, action, outcome,
        actor_user_id, acting_via, source_ip, target_type, target_count, container_key)
     VALUES (?, ?, ?, ?, 'phi_access', 'page.read', ?, ?, ?, ?, 'page', ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    new Date(Date.now() - (opts.hoursAgo ?? 0) * 3600_000).toISOString(),
    opts.eventClass ?? 'read',
    opts.dataClass ?? 'phi',
    opts.outcome ?? 'success',
    opts.actorUserId === undefined ? '1' : opts.actorUserId,
    opts.actingVia ?? null,
    opts.sourceIp ?? '10.1.1.1',
    opts.targetCount ?? 1,
    opts.container ?? 'chart',
  ).run();
}

async function emptyBucket(): Promise<void> {
  const bucket = env.AUDIT_BUCKET;
  if (!bucket) return;
  for (const object of (await bucket.list()).objects) await bucket.delete(object.key);
}

function signalById(signals: Awaited<ReturnType<typeof reviewSignals>>, id: string) {
  const signal = signals.find((candidate) => candidate.id === id);
  if (!signal) throw new Error(`no signal ${id}`);
  return signal;
}

beforeEach(async () => {
  clearRolePermissionsCache();
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM audit_seals').run();
  await env.DB.prepare('DELETE FROM users').run();
  await emptyBucket();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin'),
    env.DB.prepare('INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(2, 'eventuai:editor', 'editor@example.com', 'Editor User', '', 'editor'),
  ]);
});

describe('bulk reads', () => {
  it('flags an actor over the threshold and names them', async () => {
    await seedRead({ targetCount: BULK_READ_RECORDS });

    const signal = signalById(await reviewSignals(env as unknown as Env), 'bulk_reads');
    expect(signal.rows).toMatchObject([{
      subject: 'Admin User',
      context: 'chart',
      value: BULK_READ_RECORDS,
      events: 1,
    }]);
  });

  it('sums across requests rather than needing one big read', async () => {
    // The realistic shape: many modest list views, not a single huge one.
    const each = Math.ceil(BULK_READ_RECORDS / 4);
    for (let index = 0; index < 4; index += 1) await seedRead({ targetCount: each });

    const signal = signalById(await reviewSignals(env as unknown as Env), 'bulk_reads');
    expect(signal.rows[0]).toMatchObject({ value: each * 4, events: 4 });
  });

  it('stays silent below the threshold', async () => {
    await seedRead({ targetCount: BULK_READ_RECORDS - 1 });
    expect(signalById(await reviewSignals(env as unknown as Env), 'bulk_reads').rows).toEqual([]);
  });

  it('ignores reads of unclassified containers however large', async () => {
    // Browsing ordinary content is not a finding, and treating it as one is how
    // a signal becomes noise.
    await seedRead({ dataClass: 'none', targetCount: BULK_READ_RECORDS * 10 });
    expect(signalById(await reviewSignals(env as unknown as Env), 'bulk_reads').rows).toEqual([]);
  });

  it('ignores reads older than its window', async () => {
    await seedRead({ targetCount: BULK_READ_RECORDS, hoursAgo: 48 });
    expect(signalById(await reviewSignals(env as unknown as Env), 'bulk_reads').rows).toEqual([]);
  });
});

describe('refused access', () => {
  it('flags repeated denials per actor and address', async () => {
    for (let index = 0; index < REFUSED_ATTEMPTS; index += 1) {
      await seedRead({ outcome: 'denied', eventClass: 'auth', sourceIp: '10.9.9.9' });
    }

    const signal = signalById(await reviewSignals(env as unknown as Env), 'refused_access');
    expect(signal.rows).toMatchObject([{ subject: 'Admin User', context: '10.9.9.9', value: REFUSED_ATTEMPTS }]);
  });

  it('stays silent below the threshold', async () => {
    for (let index = 0; index < REFUSED_ATTEMPTS - 1; index += 1) {
      await seedRead({ outcome: 'denied', eventClass: 'auth' });
    }
    expect(signalById(await reviewSignals(env as unknown as Env), 'refused_access').rows).toEqual([]);
  });

  it('reports an unidentified actor rather than hiding the row', async () => {
    // A refused sign-in never resolves an account; those are the ones that
    // matter most, so they must not be dropped for lack of a name.
    for (let index = 0; index < REFUSED_ATTEMPTS; index += 1) {
      await seedRead({ outcome: 'denied', eventClass: 'auth', actorUserId: null, sourceIp: '10.8.8.8' });
    }

    const signal = signalById(await reviewSignals(env as unknown as Env), 'refused_access');
    expect(signal.rows).toMatchObject([{ subject: 'no actor', context: '10.8.8.8' }]);
  });
});

describe('contributor reads with no accountable user', () => {
  it('lists every occurrence without a threshold', async () => {
    await seedRead({ actorUserId: null, actingVia: 'events', targetCount: 3 });

    const signal = signalById(await reviewSignals(env as unknown as Env), 'contributor_alone');
    expect(signal.rows).toMatchObject([{ subject: 'events', context: 'chart', value: 3 }]);
  });

  it('ignores a contributor read that does name its user', async () => {
    await seedRead({ actorUserId: '1', actingVia: 'events', targetCount: 3 });
    expect(signalById(await reviewSignals(env as unknown as Env), 'contributor_alone').rows).toEqual([]);
  });
});

describe('archive health', () => {
  it('reports the unarchived backlog and its oldest event', async () => {
    await seedRead({ hoursAgo: 3 });
    await seedRead({ hoursAgo: 1 });

    const health = await archiveHealth(env as unknown as Env);
    expect(health).toMatchObject({ seals: 0, backlog: 2, bucketBound: true });
    expect(health.oldestUnarchived).not.toBeNull();
  });

  it('counts only what the seals do not already cover', async () => {
    await seedRead({});
    await sweepAuditEvents(env as unknown as Env);
    await seedRead({});

    const health = await archiveHealth(env as unknown as Env);
    expect(health).toMatchObject({ seals: 1, backlog: 1 });
    expect(health.verification).toHaveLength(1);
  });

  it('says there is no archive rather than reporting a healthy one', async () => {
    await seedRead({});
    const health = await archiveHealth({ ...env, AUDIT_BUCKET: undefined } as unknown as Env);

    expect(health).toMatchObject({ bucketBound: false, verification: null, backlog: 1 });
  });
});

describe('verifying a window of the archive', () => {
  it('verifies the newest seals and still checks the chain into the window', async () => {
    // Three segments, then verify only the last two. The second seal's chain
    // can only be judged against the first, which is outside the window — so
    // this fails if the window is not seeded from the seal before it.
    for (let index = 0; index < 3; index += 1) {
      await seedRead({});
      await sweepAuditEvents(env as unknown as Env);
    }

    const windowed = await verifyAuditArchive(env as unknown as Env, 2);
    expect(windowed).toHaveLength(2);
    expect(windowed.every((seal) => seal.contentOk && seal.chainOk)).toBe(true);

    // And it really is the newest two, not the oldest.
    const all = await verifyAuditArchive(env as unknown as Env, 10);
    expect(windowed.map((seal) => seal.firstSeq)).toEqual(all.slice(1).map((seal) => seal.firstSeq));
  });
});

describe('the review screen', () => {
  it('serves to audit:read and refuses an editor', async () => {
    await seedRead({ targetCount: BULK_READ_RECORDS });

    const allowed = await adminFetch('/admin/audit/review');
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('cms-render-payload');

    expect((await adminFetch('/admin/audit/review', 'editor')).status).toBe(403);
  });

  it('records opening the review with what it flagged', async () => {
    await seedRead({ targetCount: BULK_READ_RECORDS });
    expect((await adminFetch('/admin/audit/review')).status).toBe(200);

    await expect.poll(async () => env.DB.prepare(
      "SELECT event_class, retention_class, detail FROM audit_events WHERE action = 'audit.review' LIMIT 1",
    ).first<{ event_class: string; retention_class: string; detail: string }>(), { timeout: 2000 })
      .toMatchObject({
        event_class: 'admin',
        retention_class: 'admin_config',
        detail: JSON.stringify({ flagged: 1 }),
      });
  });
});
