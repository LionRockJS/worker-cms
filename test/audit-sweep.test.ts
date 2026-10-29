// The audit archive and retention sweep.
//
// What matters here is not that rows move, but that they only ever move in a
// safe order: nothing is pruned that was not archived first, and the archive
// can be proven years later to be the bytes that were sealed. Each test below
// pins one of those.

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { sweepAuditEvents, verifyAuditArchive, canonicalSegment, hotDaysFor } from '../src/features/audit/sweep';
import type { Env } from '../src/types';

const DAY = 86400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

async function seedEvent(opts: {
  action?: string;
  retentionClass?: string;
  daysAgo?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events
       (event_id, occurred_at, event_class, data_class, retention_class, action, outcome)
     VALUES (?, ?, 'read', 'phi', ?, ?, 'success')`,
  ).bind(
    crypto.randomUUID(),
    isoDaysAgo(opts.daysAgo ?? 0),
    opts.retentionClass ?? 'phi_access',
    opts.action ?? 'page.read',
  ).run();
}

async function emptyBucket(): Promise<void> {
  const bucket = env.AUDIT_BUCKET;
  if (!bucket) return;
  const listed = await bucket.list();
  for (const object of listed.objects) await bucket.delete(object.key);
}

function countEvents(): Promise<{ total: number } | null> {
  return env.DB.prepare('SELECT COUNT(*) AS total FROM audit_events').first<{ total: number }>();
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare('DELETE FROM audit_seals').run();
  await emptyBucket();
});

describe('the archive', () => {
  it('archives a segment, seals it, and keeps the hot rows', async () => {
    await seedEvent({ action: 'page.read' });
    await seedEvent({ action: 'page.list' });

    const result = await sweepAuditEvents(env as unknown as Env);

    expect(result.archived).toBe(2);
    expect(result.key).toMatch(/^audit\/dt=\d{4}-\d{2}-\d{2}\/seg-\d{12}-\d{12}\.ndjson\.gz$/);
    expect(await env.AUDIT_BUCKET!.head(result.key!)).not.toBeNull();

    const seal = await env.DB.prepare('SELECT event_count, prev_hash, r2_key FROM audit_seals').first();
    expect(seal).toMatchObject({ event_count: 2, prev_hash: null, r2_key: result.key });
    // Recent events stay queryable: archiving is not pruning.
    expect(await countEvents()).toEqual({ total: 2 });
  });

  it('resumes from the last seal instead of re-archiving', async () => {
    await seedEvent({});
    const first = await sweepAuditEvents(env as unknown as Env);
    expect(first.archived).toBe(1);

    // Nothing new: the next tick has nothing to archive.
    expect(await sweepAuditEvents(env as unknown as Env)).toMatchObject({
      archived: 0,
      skipped: 'nothing_to_archive',
    });

    await seedEvent({});
    const third = await sweepAuditEvents(env as unknown as Env);
    expect(third.archived).toBe(1);
    expect(third.key).not.toBe(first.key);

    const seals = await env.DB.prepare('SELECT first_seq, last_seq, prev_hash FROM audit_seals ORDER BY last_seq')
      .all<{ first_seq: number; last_seq: number; prev_hash: string | null }>();
    expect(seals.results).toHaveLength(2);
    // Ranges join end to end, which is what proves nothing was skipped.
    expect(seals.results[1].first_seq).toBe(seals.results[0].last_seq + 1);
    expect(seals.results[1].prev_hash).not.toBeNull();
  });

  it('verifies every seal against the archived bytes', async () => {
    await seedEvent({});
    await sweepAuditEvents(env as unknown as Env);
    await seedEvent({});
    await sweepAuditEvents(env as unknown as Env);

    const verification = await verifyAuditArchive(env as unknown as Env);
    expect(verification).toHaveLength(2);
    expect(verification.every((seal) => seal.contentOk && seal.chainOk)).toBe(true);
  });

  it('detects an archive object that no longer matches its seal', async () => {
    await seedEvent({});
    const result = await sweepAuditEvents(env as unknown as Env);

    // Replace the archived segment with different content, the way a tamper
    // with write access to the bucket would.
    // R2 needs a known-length body, so the replacement is buffered rather
    // than streamed in.
    const tampered = await new Response(
      new Blob(['{"seq":1,"action":"nothing"}\n']).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    await env.AUDIT_BUCKET!.put(result.key!, tampered);

    const [seal] = await verifyAuditArchive(env as unknown as Env);
    expect(seal.contentOk).toBe(false);
    // The chain itself is intact — only the bytes changed, which is exactly
    // what the two separate checks are there to distinguish.
    expect(seal.chainOk).toBe(true);
  });

  it('detects a deleted archive object', async () => {
    await seedEvent({});
    const result = await sweepAuditEvents(env as unknown as Env);
    await env.AUDIT_BUCKET!.delete(result.key!);

    const [seal] = await verifyAuditArchive(env as unknown as Env);
    expect(seal).toMatchObject({ contentOk: false, missing: true });
  });

  it('detects a seal swapped out from under the chain', async () => {
    await seedEvent({});
    await sweepAuditEvents(env as unknown as Env);
    await seedEvent({});
    await sweepAuditEvents(env as unknown as Env);

    // Rewrite the first seal's rolling hash. Its own segment still verifies,
    // but the second seal no longer chains onto it.
    await env.DB.prepare('UPDATE audit_seals SET rolling_hash = ? WHERE last_seq = (SELECT MIN(last_seq) FROM audit_seals)')
      .bind('0'.repeat(64))
      .run();

    const verification = await verifyAuditArchive(env as unknown as Env);
    expect(verification[0].contentOk).toBe(true);
    expect(verification[0].chainOk).toBe(false);
    expect(verification[1].chainOk).toBe(false);
  });
});

describe('retention', () => {
  it('prunes archived rows past their class window and keeps the rest', async () => {
    await seedEvent({ retentionClass: 'phi_access', daysAgo: 200, action: 'old.read' });
    await seedEvent({ retentionClass: 'phi_access', daysAgo: 1, action: 'new.read' });
    // 365 days hot, so a 200-day-old row of this class is still hot.
    await seedEvent({ retentionClass: 'phi_mutation', daysAgo: 200, action: 'mutation.kept' });

    const result = await sweepAuditEvents(env as unknown as Env);
    expect(result.archived).toBe(3);
    expect(result.pruned).toBe(1);

    const remaining = await env.DB.prepare('SELECT action FROM audit_events ORDER BY seq')
      .all<{ action: string }>();
    expect(remaining.results.map((row) => row.action)).toEqual(['new.read', 'mutation.kept']);
  });

  it('never prunes what it could not archive', async () => {
    await seedEvent({ retentionClass: 'phi_access', daysAgo: 200 });

    // No bucket: the sweep must do nothing at all rather than free space by
    // destroying the only copy of the trail.
    const result = await sweepAuditEvents({ ...env, AUDIT_BUCKET: undefined } as unknown as Env);

    expect(result).toMatchObject({ archived: 0, pruned: 0, skipped: 'no_bucket' });
    expect(await countEvents()).toEqual({ total: 1 });
    expect(await env.DB.prepare('SELECT id FROM audit_seals').first()).toBeNull();
  });

  it('keeps an unrecognised retention class on the conservative horizon', () => {
    expect(hotDaysFor('phi_access')).toBe(90);
    // A class added later must not be swept away by this file's silence.
    expect(hotDaysFor('something_new')).toBe(365);
  });
});

describe('the canonical segment form', () => {
  it('orders keys so the hash is reproducible from the archived bytes', () => {
    // Input key order must not reach the output: the hash has to be
    // recomputable years from now by code that cannot know how a driver
    // happened to order columns.
    const ndjson = canonicalSegment([
      { action: 'page.read', seq: 7, event_id: 'e1' } as never,
    ]);
    const parsed = JSON.parse(ndjson.trim());
    expect(Object.keys(parsed).slice(0, 4)).toEqual(['seq', 'event_id', 'occurred_at', 'event_class']);
    // Absent columns are present as null rather than omitted, so two segments
    // of the same rows always hash alike.
    expect(parsed.occurred_at).toBeNull();
    expect(ndjson.endsWith('\n')).toBe(true);
  });

  it('is empty for an empty segment', () => {
    expect(canonicalSegment([])).toBe('');
  });
});
