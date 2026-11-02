// W5 archive protection: the sweep under fault injection.
//
// Each test breaks one thing the archive depends on — a crash between the
// object write and the seal, a second runner, an R2 or D1 outage, a missing
// or corrupt segment, a rewritten seal, an orphaned object — and pins the two
// properties that must survive it: no unverified range is ever pruned, and the
// seal chain never forks.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSegment, sweepAuditEvents, verifyAuditArchive } from '../src/features/audit/sweep';
import { monitorAuditOutages, outagePage, readOutage } from '../src/features/audit/outages';
import { OUTAGE_PREFIX } from '../src/core/db/audit-outages';
import type { Env } from '../src/types';

const DAY = 86400_000;
const base = env as unknown as Env;
const real = () => env.AUDIT_BUCKET!;

let messages: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
let receiver: (path: string) => number = () => 200;

/** Outage monitoring on, with a fake receiver that records what it was sent. */
function monitored(overrides: Partial<Env> = {}): Env {
  return {
    ...base,
    AUDIT_OUTAGE_MONITORING: 'true',
    AUDIT_OUTAGE_BUCKET: env.AUDIT_OUTAGE_BUCKET,
    AUDIT_MONITOR_SOURCE: 'cms-test',
    AUDIT_MONITOR: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      messages.push({ path, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(null, { status: receiver(path) });
    } } as Fetcher,
    ...overrides,
  } as Env;
}

/** The real archive bucket with some methods replaced. */
function bucketWith(overrides: Partial<Record<'head' | 'get' | 'put' | 'list' | 'delete', unknown>>): R2Bucket {
  const bucket = real();
  return {
    head: (...args: Parameters<R2Bucket['head']>) => bucket.head(...args),
    get: (...args: Parameters<R2Bucket['get']>) => bucket.get(...args),
    put: (...args: Parameters<R2Bucket['put']>) => bucket.put(...args),
    list: (...args: Parameters<R2Bucket['list']>) => bucket.list(...args),
    delete: (...args: Parameters<R2Bucket['delete']>) => bucket.delete(...args),
    ...overrides,
  } as unknown as R2Bucket;
}

/** A bucket that writes the object and then loses the response. */
const lostPutResponse = () => bucketWith({
  put: async (...args: Parameters<R2Bucket['put']>) => {
    await real().put(...args);
    throw new Error('connection reset');
  },
});

const unavailable = bucketWith(Object.fromEntries(['head', 'get', 'put', 'list', 'delete']
  .map((method) => [method, async () => { throw new Error('R2 unavailable'); }])));

async function seedEvent(daysAgo = 0, action = 'page.read'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
       (event_id, occurred_at, event_class, data_class, retention_class, action, outcome, target_id)
     VALUES (?, ?, 'read', 'phi', 'phi_access', ?, 'success', 'patient-record-7')`,
  ).bind(crypto.randomUUID(), new Date(Date.now() - daysAgo * DAY).toISOString(), action).run();
}

async function count(sql: string): Promise<number> {
  return (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
}

const events = () => count('SELECT COUNT(*) AS n FROM audit_events');
const seals = () => count('SELECT COUNT(*) AS n FROM audit_seals');
const state = () => env.DB.prepare('SELECT * FROM audit_archive_state WHERE id = 1')
  .first<{ lease_holder: string | null; verified_seq: number; anchored_seq: number; fault: string | null }>();
const intent = () => env.DB.prepare('SELECT * FROM audit_archive_intents')
  .first<{ cursor_seq: number; r2_key: string; segment_hash: string; first_seq: number; last_seq: number }>();

async function gz(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

async function archiveIncidents(cfg: Env) {
  const page = await outagePage(cfg);
  return Promise.all(page.items.filter((item) => item.reason === 'archive')
    .map(async (item) => (await readOutage(cfg, item.id))!));
}

async function emptyBucket(bucket: R2Bucket | undefined, prefix?: string): Promise<void> {
  if (!bucket) return;
  const listed = await bucket.list({ prefix, limit: 1000 });
  if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
}

beforeEach(async () => {
  messages = [];
  receiver = () => 200;
  for (const table of ['audit_events', 'audit_seals', 'audit_archive_intents', 'audit_archive_orphans']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    `UPDATE audit_archive_state SET lease_holder = NULL, lease_expires_at = 0, verified_seq = 0,
       verified_hash = NULL, verified_at = NULL, anchored_seq = 0, anchored_at = NULL,
       fault = NULL, fault_at = NULL, orphan_cursor = NULL WHERE id = 1`,
  ).run();
  await emptyBucket(real());
  await emptyBucket(env.AUDIT_OUTAGE_BUCKET, OUTAGE_PREFIX);
});

describe('a crash between the object write and the seal', () => {
  it('resumes the frozen segment and adopts the object instead of rewriting it', async () => {
    await seedEvent(200);
    await seedEvent(200);

    // The object is written, then the seal transaction fails.
    let batches = 0;
    const sealFails = { prepare: base.DB.prepare.bind(base.DB),
      batch: (statements: D1PreparedStatement[]) => (++batches === 2
        ? Promise.reject(new Error('D1 unavailable')) : base.DB.batch(statements)) };
    await expect(sweepAuditEvents({ ...base, DB: sealFails } as Env)).rejects.toThrow('D1 unavailable');

    const frozen = (await intent())!;
    expect(frozen).toMatchObject({ cursor_seq: 0, first_seq: expect.any(Number), last_seq: expect.any(Number) });
    expect(await real().head(frozen.r2_key)).not.toBeNull();
    expect(await seals()).toBe(0);
    expect(await events()).toBe(2);
    // The lease is released on the way out, so the next tick is not delayed.
    expect((await state())!.lease_holder).toBeNull();

    let puts = 0;
    const counting = bucketWith({ put: (...args: Parameters<R2Bucket['put']>) => { puts += 1; return real().put(...args); } });
    const result = await sweepAuditEvents({ ...base, AUDIT_BUCKET: counting });

    expect(puts).toBe(0);
    expect(result).toMatchObject({ archived: 2, key: frozen.r2_key, pruned: 2, verifiedSeq: frozen.last_seq });
    expect(result.fault).toBeUndefined();
    expect(await intent()).toBeNull();
    expect(await seals()).toBe(1);
  });

  it('retries a write whose response was lost without sealing in between', async () => {
    await seedEvent(200);
    const first = await sweepAuditEvents({ ...base, AUDIT_BUCKET: lostPutResponse() });
    expect(first).toMatchObject({ archived: 0, pruned: 0, fault: 'bucket-unavailable' });
    expect(await seals()).toBe(0);
    expect(await events()).toBe(1);

    const second = await sweepAuditEvents(base);
    expect(second).toMatchObject({ archived: 1, pruned: 1 });
    expect((await verifyAuditArchive(base)).every((seal) => seal.contentOk && seal.chainOk)).toBe(true);
  });

  it('refuses to overwrite a different object already at the frozen key, and alerts', async () => {
    await seedEvent(200);
    await sweepAuditEvents({ ...base, AUDIT_BUCKET: lostPutResponse() });
    const frozen = (await intent())!;
    const planted = await gz('{"seq":1,"action":"planted"}\n');
    await real().put(frozen.r2_key, planted);

    const cfg = monitored();
    const result = await sweepAuditEvents(cfg);

    expect(result).toMatchObject({ archived: 0, pruned: 0, fault: 'segment-conflict' });
    expect(await seals()).toBe(0);
    expect(await events()).toBe(1);
    // Not overwritten: the conflicting bytes are evidence.
    expect(await (await real().get(frozen.r2_key))!.arrayBuffer()).toEqual(planted);

    const [incident] = await archiveIncidents(cfg);
    expect(incident.records[0]).toMatchObject({ action: 'audit.archive.segment-conflict', targetId: frozen.r2_key });
    const alert = messages.find((message) => message.path === '/incidents')!;
    expect(alert.body).toMatchObject({ kind: 'audit-outage', reason: 'archive' });
    expect(JSON.stringify(alert.body)).not.toMatch(/audit\/dt=|patient-record|page\.read/);
  });

  it('halts when the frozen rows no longer hash to the intent', async () => {
    await seedEvent(200);
    await sweepAuditEvents({ ...base, AUDIT_BUCKET: lostPutResponse() });
    await env.DB.prepare("UPDATE audit_events SET action = 'rewritten'").run();

    const result = await sweepAuditEvents(base);
    expect(result).toMatchObject({ archived: 0, pruned: 0, fault: 'segment-drift' });
    expect(await seals()).toBe(0);
    expect(await events()).toBe(1);
  });
});

describe('concurrent sweeps', () => {
  it('does nothing while another runner holds the lease, and takes an expired one', async () => {
    await seedEvent();
    await env.DB.prepare("UPDATE audit_archive_state SET lease_holder = 'other', lease_expires_at = ?")
      .bind(Date.now() + 60_000).run();
    expect(await sweepAuditEvents(base)).toMatchObject({ archived: 0, skipped: 'claimed' });
    expect(await seals()).toBe(0);

    await env.DB.prepare('UPDATE audit_archive_state SET lease_expires_at = ?').bind(Date.now() - 1).run();
    expect(await sweepAuditEvents(base)).toMatchObject({ archived: 1 });
  });

  it('seals each range once when ticks overlap', async () => {
    for (let i = 0; i < 5; i++) await seedEvent();
    const results = await Promise.all([sweepAuditEvents(base), sweepAuditEvents(base), sweepAuditEvents(base)]);

    expect(results.reduce((sum, result) => sum + result.archived, 0)).toBe(5);
    expect(results.filter((result) => result.skipped === 'claimed').length).toBeGreaterThanOrEqual(1);
    expect(await seals()).toBe(1);
  });

  it('cannot fork the chain from a runner whose lease lapsed mid-write', async () => {
    await seedEvent();
    await seedEvent();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const writing = new Promise<void>((resolve) => { reached = resolve; });
    const stalled = bucketWith({
      put: async (...args: Parameters<R2Bucket['put']>) => { reached(); await gate; return real().put(...args); },
    });

    const slow = sweepAuditEvents({ ...base, AUDIT_BUCKET: stalled });
    await writing;
    // The slow runner's lease lapses; a second runner takes over the same intent.
    await env.DB.prepare('UPDATE audit_archive_state SET lease_expires_at = 0').run();
    await seedEvent();
    const takeover = await sweepAuditEvents(base);
    expect(takeover).toMatchObject({ archived: 2 });

    release();
    const late = await slow;
    expect(late).toMatchObject({ archived: 0 });
    expect(late.fault).toBeUndefined();

    const rows = await env.DB.prepare('SELECT first_seq, last_seq, prev_hash FROM audit_seals ORDER BY last_seq')
      .all<{ first_seq: number; last_seq: number; prev_hash: string | null }>();
    expect(rows.results).toHaveLength(1);

    // The next tick extends the one chain with the event added meanwhile.
    expect(await sweepAuditEvents(base)).toMatchObject({ archived: 1 });
    expect((await verifyAuditArchive(base)).every((seal) => seal.contentOk && seal.chainOk)).toBe(true);
  });

  it('never prunes past a seal written outside the protocol', async () => {
    await seedEvent(200);
    await seedEvent(200);
    await sweepAuditEvents({ ...base, AUDIT_BUCKET: lostPutResponse() });
    const frozen = (await intent())!;

    // A writer that skips the intent — an old Worker version mid-rollout, or a
    // forger with database access — seals the same range with its own hash.
    await env.DB.prepare(
      `INSERT INTO audit_seals (first_seq, last_seq, event_count, segment_hash, prev_hash, rolling_hash, r2_key, sealed_at)
       VALUES (?, ?, 2, ?, NULL, ?, 'audit/dt=2020-01-01/seg-forged.ndjson.gz', ?)`,
    ).bind(frozen.first_seq, frozen.last_seq, 'f'.repeat(64), 'e'.repeat(64), new Date().toISOString()).run();

    const result = await sweepAuditEvents(base);
    expect(result).toMatchObject({ pruned: 0, verifiedSeq: 0, fault: 'verification-failed' });
    expect(await events()).toBe(2);
    // The overtaken intent is dropped; its object is now an orphan on record.
    expect(await intent()).toBeNull();
    expect(await env.DB.prepare('SELECT status FROM audit_archive_orphans WHERE r2_key = ?').bind(frozen.r2_key).first())
      .toMatchObject({ status: 'uncompared' });
  });
});

describe('outages', () => {
  it('archives, seals and prunes nothing during an R2 outage, alerts once, then recovers', async () => {
    await seedEvent(200);
    const cfg = monitored({ AUDIT_BUCKET: unavailable });

    expect(await sweepAuditEvents(cfg)).toMatchObject({ archived: 0, pruned: 0, fault: 'bucket-unavailable' });
    expect(await sweepAuditEvents(cfg)).toMatchObject({ fault: 'bucket-unavailable' });
    expect(await seals()).toBe(0);
    expect(await events()).toBe(1);
    expect(await archiveIncidents(cfg)).toHaveLength(1);

    const recovered = await sweepAuditEvents(monitored());
    expect(recovered).toMatchObject({ archived: 1, pruned: 1 });
    expect(recovered.fault).toBeUndefined();
    expect((await state())!.fault).toBeNull();
  });

  it('leaves the bucket untouched during a D1 outage', async () => {
    await seedEvent(200);
    const down = { prepare: () => { throw new Error('D1 unavailable'); }, batch: async () => { throw new Error('D1 unavailable'); } };
    await expect(sweepAuditEvents({ ...base, DB: down } as unknown as Env)).rejects.toThrow('D1 unavailable');
    expect((await real().list()).objects).toHaveLength(0);
    expect(await events()).toBe(1);
  });

  it('raises one archive incident for a missing bucket binding', async () => {
    await seedEvent(200);
    const cfg = monitored({ AUDIT_BUCKET: undefined });
    await sweepAuditEvents(cfg);
    await sweepAuditEvents(cfg);
    const incidents = await archiveIncidents(cfg);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].records[0].action).toBe('audit.archive.bucket-missing');
    expect(await events()).toBe(1);
  });
});

describe('verification gates pruning', () => {
  it('does not prune a segment that cannot be read back', async () => {
    await seedEvent(200);
    const blind = bucketWith({ get: async () => null });

    const result = await sweepAuditEvents({ ...base, AUDIT_BUCKET: blind });
    expect(result).toMatchObject({ archived: 1, pruned: 0, verifiedSeq: 0, fault: 'verification-failed' });
    expect(await events()).toBe(1);

    expect(await sweepAuditEvents(base)).toMatchObject({ pruned: 1 });
  });

  it('halts pruning at a corrupted segment', async () => {
    await seedEvent(200);
    const sealed = await sweepAuditEvents({ ...base, AUDIT_BUCKET: bucketWith({ get: async () => null }) });
    await real().put(sealed.key!, await gz('{"seq":1}\n'));

    expect(await sweepAuditEvents(base)).toMatchObject({ pruned: 0, verifiedSeq: 0, fault: 'verification-failed' });
    expect(await events()).toBe(1);
  });

  it('catches a reseal that is consistent in D1 but not with the objects', async () => {
    await seedEvent();
    await sweepAuditEvents(base);
    await seedEvent();
    await sweepAuditEvents(base);

    // Graft a new chain root and recompute every later link, as a database
    // writer could. The D1 chain is self-consistent; the objects disagree.
    const rows = await env.DB.prepare('SELECT id, segment_hash FROM audit_seals ORDER BY last_seq')
      .all<{ id: number; segment_hash: string }>();
    const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    let prev: string | null = 'a'.repeat(64);
    for (const row of rows.results) {
      const rolling: string = await sha(`${prev ?? ''}${row.segment_hash}`);
      await env.DB.prepare('UPDATE audit_seals SET prev_hash = ?, rolling_hash = ? WHERE id = ?').bind(prev, rolling, row.id).run();
      prev = rolling;
    }

    // Check only the newest seal, seeded from the grafted one before it: by D1
    // alone it chains and its bytes match; only its object's own link disagrees.
    const [check] = await verifyAuditArchive(base, 1);
    expect(check.contentOk).toBe(true);
    expect(check.chainOk).toBe(false);
  });

  it('stamps each object with its format and its own chain link', async () => {
    await seedEvent();
    const result = await sweepAuditEvents(base);
    const object = await real().head(result.key!);
    const seal = await env.DB.prepare('SELECT rolling_hash, segment_hash FROM audit_seals').first<{ rolling_hash: string; segment_hash: string }>();
    expect(object!.customMetadata).toMatchObject({ format: '1', prevHash: '', rollingHash: seal!.rolling_hash, segmentHash: seal!.segment_hash });
  });
});

describe('independent checkpoints', () => {
  it('hands each verified checkpoint to the receiver, chained and PHI-free', async () => {
    const cfg = monitored();
    await seedEvent();
    await sweepAuditEvents(cfg);
    await seedEvent();
    const second = await sweepAuditEvents(cfg);

    const checkpoints = messages.filter((message) => message.path === '/checkpoints');
    expect(checkpoints).toHaveLength(2);
    expect(Object.keys(checkpoints[0].body).sort()).toEqual([
      'eventCount', 'firstSeq', 'kind', 'lastSeq', 'prevHash', 'rollingHash', 'sealedAt', 'segmentHash', 'source', 'version',
    ]);
    expect(checkpoints[0].body).toMatchObject({ kind: 'audit-checkpoint', source: 'cms-test', prevHash: null });
    expect(checkpoints[1].body.prevHash).toBe(checkpoints[0].body.rollingHash);
    expect(checkpoints[1].headers.get('Idempotency-Key')).toBe(`checkpoint-${checkpoints[1].body.lastSeq}`);
    expect(JSON.stringify(checkpoints)).not.toMatch(/patient-record|page\.read|audit\/dt=/);
    expect(second.anchoredSeq).toBe(checkpoints[1].body.lastSeq);
  });

  it('keeps checkpoints pending while the receiver is down and retries them in order', async () => {
    receiver = (path) => (path === '/checkpoints' ? 503 : 200);
    const cfg = monitored();
    await seedEvent();
    expect(await sweepAuditEvents(cfg)).toMatchObject({ anchoredSeq: 0 });
    expect((await state())!.fault).toBeNull();

    receiver = () => 200;
    const retried = await sweepAuditEvents(cfg);
    expect(retried.anchoredSeq).toBeGreaterThan(0);
  });

  it('treats a checkpoint the receiver contradicts as a verification fault', async () => {
    receiver = (path) => (path === '/checkpoints' ? 409 : 200);
    const cfg = monitored();
    await seedEvent();
    expect(await sweepAuditEvents(cfg)).toMatchObject({ anchoredSeq: 0, fault: 'anchor-conflict' });
    expect((await archiveIncidents(cfg))[0].records[0].action).toBe('audit.archive.anchor-conflict');
  });
});

describe('orphan reconciliation', () => {
  async function canonical(first: number, last: number): Promise<string> {
    const rows = await env.DB.prepare('SELECT * FROM audit_events WHERE seq BETWEEN ? AND ? ORDER BY seq')
      .bind(first, last).all<Record<string, unknown>>();
    return canonicalSegment(rows.results);
  }
  const keyFor = (first: number, last: number) =>
    `audit/dt=${new Date().toISOString().slice(0, 10)}/seg-${String(first).padStart(12, '0')}-${String(last).padStart(12, '0')}.ndjson.gz`;

  it('records an earlier identical copy as superseded, without a fault', async () => {
    for (let i = 0; i < 3; i++) await seedEvent();
    const first = (await env.DB.prepare('SELECT MIN(seq) AS n FROM audit_events').first<{ n: number }>())!.n;
    // What a pre-W5 crash left: a shorter segment for the same start.
    await real().put(keyFor(first, first + 1), await gz(await canonical(first, first + 1)));

    const result = await sweepAuditEvents(base);
    expect(result.fault).toBeUndefined();
    expect(await env.DB.prepare('SELECT status FROM audit_archive_orphans').first()).toMatchObject({ status: 'superseded' });
  });

  it('flags a divergent copy and an unsealed object once each', async () => {
    for (let i = 0; i < 2; i++) await seedEvent();
    const first = (await env.DB.prepare('SELECT MIN(seq) AS n FROM audit_events').first<{ n: number }>())!.n;
    const text = (await canonical(first, first)).replace('page.read', 'page.altered');
    await real().put(keyFor(first, first), await gz(text));
    await real().put(keyFor(first + 100, first + 101), await gz('{"seq":0}\n'));

    const cfg = monitored();
    expect(await sweepAuditEvents(cfg)).toMatchObject({ fault: 'orphan' });
    const statuses = await env.DB.prepare('SELECT status FROM audit_archive_orphans ORDER BY first_seq').all<{ status: string }>();
    expect(statuses.results.map((row) => row.status)).toEqual(['divergent', 'unsealed']);
    // Both objects stay: the CMS never deletes from the archive.
    expect((await real().list()).objects).toHaveLength(3);

    // Recorded once; the next clean run clears the fault.
    expect((await sweepAuditEvents(cfg)).fault).toBeUndefined();
    expect(await archiveIncidents(cfg)).toHaveLength(1);
  });
});

describe('health', () => {
  it('reports an archive fault as unhealthy and the chain head in the heartbeat', async () => {
    const cfg = monitored();
    await seedEvent();
    await sweepAuditEvents({ ...cfg, AUDIT_BUCKET: bucketWith({ get: async () => null }) });
    messages = [];

    await monitorAuditOutages(cfg);
    const heartbeat = messages.find((message) => message.path === '/heartbeat')!;
    const head = await env.DB.prepare('SELECT last_seq, rolling_hash FROM audit_seals').first<{ last_seq: number; rolling_hash: string }>();
    expect(heartbeat.body).toMatchObject({
      archiveHealthy: false,
      archiveFault: 'verification-failed',
      archiveSealedSeq: head!.last_seq,
      archiveHeadHash: head!.rolling_hash,
    });
    expect(JSON.stringify(heartbeat.body)).not.toMatch(/audit\/dt=/);
    expect((await outagePage(cfg)).health?.archiveHealthy).toBe(false);
  });

  it('reports a segment frozen too long as archive lag', async () => {
    const cfg = monitored({ AUDIT_ARCHIVE_MAX_LAG_SECONDS: '60' });
    await seedEvent();
    await sweepAuditEvents({ ...cfg, AUDIT_BUCKET: lostPutResponse() });
    await env.DB.prepare('UPDATE audit_archive_intents SET frozen_at = ?').bind(new Date(Date.now() - 120_000).toISOString()).run();
    // Fresh events, so only the frozen segment can make the archive lag.
    await env.DB.prepare('UPDATE audit_events SET occurred_at = ?').bind(new Date().toISOString()).run();
    await env.DB.prepare('UPDATE audit_archive_state SET fault = NULL').run();

    await monitorAuditOutages(cfg);
    expect((await outagePage(cfg)).health?.archiveHealthy).toBe(false);
  });
});
