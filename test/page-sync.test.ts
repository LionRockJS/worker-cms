// Multi-user live-sync tests for the PageSyncDO Durable Object.
//
// These connect several real WebSocket clients to one DO instance and exercise
// the sync protocol directly (bypassing the Hono route + auth, which just
// forwards X-User-Id / X-User-Name headers). The focus is correctness with
// MORE THAN THREE concurrent editors: broadcast fan-out, field-level LWW
// convergence, snapshots for late joiners, per-user abandon-on-leave reverts,
// multi-tab handling, and save commits.
//
// Synchronising between clients: the DO handles one message per turn and
// preserves order *per socket*, but nothing orders one client's socket against
// another's. So never use a fixed delay to "let a broadcast land" — under load
// it under-waits, and the message then turns up where a later assertion
// expects a different one. Wait for the specific message instead (`waitFor` /
// `waitForAll`); once a peer has observed an op, the DO turn that produced it
// has definitely run, which makes it a real barrier.

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

type Json = Record<string, any>;

/** Bound on any single wait — generous, since it only ever costs time on failure. */
const WAIT_MS = 5000;

interface Client {
  userId: string;
  send(msg: Json): void;
  /** Resolve with the next message, or reject after `timeoutMs`. */
  next(timeoutMs?: number): Promise<Json>;
  /**
   * Resolve with the first message whose fields all match `shape`. Messages
   * that arrive first without matching are left in the queue for later
   * assertions. Rejects once `timeoutMs` has elapsed.
   */
  waitFor(shape: Json, timeoutMs?: number): Promise<Json>;
  /** Resolve once `count` messages matching `shape` have arrived. */
  waitForAll(shape: Json, count: number, timeoutMs?: number): Promise<Json[]>;
  /** Wait briefly and return every buffered message, clearing the buffer. */
  drain(ms?: number): Promise<Json[]>;
  /** Assert that no message arrives within `ms`. */
  expectSilent(ms?: number): Promise<void>;
  close(code?: number): void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shallow partial match, the message-queue equivalent of `toMatchObject`. */
function matches(msg: Json, shape: Json): boolean {
  return Object.entries(shape).every(([key, value]) => msg[key] === value);
}

/** Deterministic HLC: "<ms>.<counter>.<userId>" — lexicographically ordered. */
function hlc(ms: number, counter: number, userId: string): string {
  return `${ms}.${String(counter).padStart(6, '0')}.${userId}`;
}

let pageCounter = 0;
/** A unique DO name per test so op state never leaks between tests. */
function freshPage(): string {
  return `page-test-${pageCounter++}-${crypto.randomUUID()}`;
}

async function connect(page: string, userId: string, userName = userId): Promise<Client> {
  const stub = env.PAGE_SYNC.get(env.PAGE_SYNC.idFromName(page));
  const res = await stub.fetch('https://page-sync/api/sync', {
    headers: { Upgrade: 'websocket', 'X-User-Id': userId, 'X-User-Name': userName },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error('expected a WebSocket from the Durable Object');

  const queue: Json[] = [];
  const waiters: Array<(msg: Json) => void> = [];
  ws.addEventListener('message', (event: MessageEvent) => {
    const data = JSON.parse(typeof event.data === 'string' ? event.data : '{}');
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  ws.accept();

  /** Take the next queued message, or wait for one to arrive. */
  function take(timeoutMs: number, what: string): Promise<Json> {
    if (queue.length) return Promise.resolve(queue.shift() as Json);
    return new Promise<Json>((resolve, reject) => {
      const waiter = (msg: Json) => {
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        // Drop the waiter — left in place it would swallow the next message.
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        reject(new Error(`${userId}: timed out waiting for ${what}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  async function waitFor(shape: Json, timeoutMs = WAIT_MS): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    const what = JSON.stringify(shape);
    const skipped: Json[] = [];
    try {
      for (;;) {
        const msg = await take(Math.max(deadline - Date.now(), 0), what);
        if (matches(msg, shape)) return msg;
        skipped.push(msg);
      }
    } finally {
      // Anything we passed over stays visible to later assertions.
      queue.unshift(...skipped);
    }
  }

  return {
    userId,
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    next(timeoutMs = WAIT_MS) {
      return take(timeoutMs, 'a message');
    },
    waitFor,
    async waitForAll(shape, count, timeoutMs = WAIT_MS) {
      const deadline = Date.now() + timeoutMs;
      const found: Json[] = [];
      while (found.length < count) {
        found.push(await waitFor(shape, Math.max(deadline - Date.now(), 0)));
      }
      return found;
    },
    async drain(ms = 60) {
      await wait(ms);
      const messages = queue.splice(0, queue.length);
      return messages;
    },
    async expectSilent(ms = 80) {
      await wait(ms);
      expect(queue).toEqual([]);
    },
    close(code = 1000) {
      ws.close(code);
    },
  };
}

function op(path: string, value: string, h: string): Json {
  return { type: 'op', path, value, hlc: h, opId: crypto.randomUUID() };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Pull a fresh full snapshot from the DO via a throwaway client. */
async function snapshotOf(page: string): Promise<Json[]> {
  const probe = await connect(page, 'probe');
  probe.send({ type: 'sync' });
  // The probe is an ordinary client, so another editor's op can reach it
  // before its own snapshot does — match on the type, don't take message #1.
  const snapshot = await probe.waitFor({ type: 'snapshot' });
  probe.close();
  return snapshot.ops as Json[];
}

describe('PageSyncDO multi-user sync', () => {
  it('merges concurrent edits within one richtext field with a sequence CRDT', async () => {
    const page = freshPage();
    const [a, b] = await Promise.all([connect(page, 'A'), connect(page, 'B')]);
    const path = '.body|en';

    a.send({ type: 'text-sync', path, baseline: 'Hello' });
    b.send({ type: 'text-sync', path, baseline: 'Hello' });
    const [aSync, bSync] = await Promise.all([
      a.waitFor({ type: 'text-sync', path }),
      b.waitFor({ type: 'text-sync', path }),
    ]);

    const aDoc = new Y.Doc();
    const bDoc = new Y.Doc();
    Y.applyUpdate(aDoc, base64ToBytes(aSync.update));
    Y.applyUpdate(bDoc, base64ToBytes(bSync.update));

    let aUpdate = new Uint8Array();
    let bUpdate = new Uint8Array();
    aDoc.on('update', (update) => { aUpdate = update; });
    bDoc.on('update', (update) => { bUpdate = update; });
    aDoc.getText('markdown').insert(5, ' Alice');
    bDoc.getText('markdown').insert(5, ' Bob');

    a.send({ type: 'text-update', path, update: bytesToBase64(aUpdate) });
    b.send({ type: 'text-update', path, update: bytesToBase64(bUpdate) });
    const [fromB, fromA] = await Promise.all([
      a.waitFor({ type: 'text-update', path }),
      b.waitFor({ type: 'text-update', path }),
    ]);
    Y.applyUpdate(aDoc, base64ToBytes(fromB.update));
    Y.applyUpdate(bDoc, base64ToBytes(fromA.update));

    const merged = aDoc.getText('markdown').toString();
    expect(bDoc.getText('markdown').toString()).toBe(merged);
    expect(merged).toContain('Alice');
    expect(merged).toContain('Bob');

    const late = await connect(page, 'late');
    late.send({ type: 'text-sync', path, baseline: 'ignored' });
    const lateSync = await late.waitFor({ type: 'text-sync', path });
    const lateDoc = new Y.Doc();
    Y.applyUpdate(lateDoc, base64ToBytes(lateSync.update));
    expect(lateDoc.getText('markdown').toString()).toBe(merged);

    const stub = env.PAGE_SYNC.get(env.PAGE_SYNC.idFromName(page));
    const saved = await stub.fetch('https://page-sync/?action=saved', { method: 'POST' });
    expect(saved.status).toBe(200);
    await Promise.all([a, b, late].map((client) => client.waitFor({ type: 'saved' })));

    const afterSave = await connect(page, 'after-save');
    afterSave.send({ type: 'text-sync', path, baseline: 'Committed baseline' });
    const resetSync = await afterSave.waitFor({ type: 'text-sync', path });
    const resetDoc = new Y.Doc();
    Y.applyUpdate(resetDoc, base64ToBytes(resetSync.update));
    expect(resetDoc.getText('markdown').toString()).toBe('Committed baseline');

    [a, b, late, afterSave].forEach((client) => client.close());
  });

  it('broadcasts one user\'s op to all other connected users, never the sender (4 users)', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    a.send(op('.title|en', 'Hello', hlc(1000, 1, 'A')));

    for (const peer of [b, c, d]) {
      const msg = await peer.waitFor({ type: 'op' });
      expect(msg).toMatchObject({ type: 'op', path: '.title|en', value: 'Hello', userId: 'A' });
    }
    // Sender is excluded from its own broadcast. The peers above already have
    // the op, so the fan-out for that turn is done: A's copy would be here too.
    await a.expectSilent();

    [a, b, c, d].forEach((client) => client.close());
  });

  it('fans every user\'s edits out to the other three (full mesh)', async () => {
    const page = freshPage();
    const clients = await Promise.all(['A', 'B', 'C', 'D'].map((u) => connect(page, u)));

    // Each of the four users edits a distinct field.
    clients.forEach((client, i) => client.send(op(`.f${i}|en`, `v${i}`, hlc(2000 + i, 1, client.userId))));

    // Every client should observe the three edits made by the others.
    for (const receiver of clients) {
      const fromOthers = await receiver.waitForAll({ type: 'op' }, 3);
      const senders = fromOthers.map((m) => m.userId).sort();
      const expected = clients.map((c) => c.userId).filter((u) => u !== receiver.userId).sort();
      expect(senders).toEqual(expected);
    }
    // ...and nothing more: no client sees an echo of its own edit.
    await Promise.all(clients.map((client) => client.expectSilent()));

    clients.forEach((client) => client.close());
  });

  it('converges to the highest-HLC write when 4 users edit the same field', async () => {
    const page = freshPage();
    const users = ['A', 'B', 'C', 'D'];
    const clients = await Promise.all(users.map((u) => connect(page, u)));

    // All four write the same path; D has the newest HLC and must win.
    clients[0].send(op('.headline|en', 'from A', hlc(5000, 1, 'A')));
    clients[1].send(op('.headline|en', 'from B', hlc(5001, 1, 'B')));
    clients[2].send(op('.headline|en', 'from C', hlc(5002, 1, 'C')));
    clients[3].send(op('.headline|en', 'from D', hlc(5003, 1, 'D')));

    // Barrier: once every client has seen the other three ops, all four have
    // been applied and the snapshot below cannot race ahead of them.
    await Promise.all(clients.map((c) => c.waitForAll({ type: 'op' }, 3)));

    // The DO keeps one op per (path,user); the effective value is the max HLC.
    const ops = (await snapshotOf(page)).filter((o) => o.path === '.headline|en');
    expect(ops).toHaveLength(4);
    const winner = ops.reduce((best, o) => (o.hlc > best.hlc ? o : best));
    expect(winner).toMatchObject({ value: 'from D', userId: 'D' });

    clients.forEach((client) => client.close());
  });

  it('ignores and does not rebroadcast a stale (older-HLC) op from the same user', async () => {
    const page = freshPage();
    const [a, b] = await Promise.all([connect(page, 'A'), connect(page, 'B')]);

    a.send(op('.note|en', 'current', hlc(7000, 2, 'A')));
    expect(await b.waitFor({ type: 'op' })).toMatchObject({ value: 'current' });

    // A's older edit for the same field must be dropped — no broadcast.
    a.send(op('.note|en', 'stale', hlc(6000, 1, 'A')));

    // Round-trip on A's own socket: the DO handles one connection's messages in
    // order, so the returned snapshot proves the stale op has been processed —
    // any rebroadcast of it would already have been sent.
    a.send({ type: 'sync' });
    const snapshot = await a.waitFor({ type: 'snapshot' });
    await b.expectSilent();

    const ops = (snapshot.ops as Json[]).filter((o) => o.path === '.note|en');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ value: 'current' });

    a.close();
    b.close();
  });

  it('gives a late-joining 4th user the full current state via snapshot', async () => {
    const page = freshPage();
    const [a, b, c] = await Promise.all([connect(page, 'A'), connect(page, 'B'), connect(page, 'C')]);

    a.send(op('.f1|en', 'A1', hlc(8000, 1, 'A')));
    b.send(op('.f2|en', 'B2', hlc(8001, 1, 'B')));
    c.send(op('.f3|en', 'C3', hlc(8002, 1, 'C')));
    // Each editor sees the two ops it didn't send — all three are now applied.
    await Promise.all([a, b, c].map((client) => client.waitForAll({ type: 'op' }, 2)));

    // The fourth editor joins and requests a sync.
    const d = await connect(page, 'D');
    d.send({ type: 'sync' });
    const snapshot = await d.waitFor({ type: 'snapshot' });

    const byPath = Object.fromEntries((snapshot.ops as Json[]).map((o) => [o.path, o]));
    expect(byPath['.f1|en']).toMatchObject({ value: 'A1', userId: 'A' });
    expect(byPath['.f2|en']).toMatchObject({ value: 'B2', userId: 'B' });
    expect(byPath['.f3|en']).toMatchObject({ value: 'C3', userId: 'C' });

    [a, b, c, d].forEach((client) => client.close());
  });

  it('reverts only the leaving user\'s abandoned fields, keeping co-editors\' work (4 users)', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    // A edits F1, F2. B also edits F1 (newer) and F3. C edits F4, D edits F5.
    a.send(op('.f1|en', 'A-f1', hlc(9000, 1, 'A')));
    a.send(op('.f2|en', 'A-f2', hlc(9001, 2, 'A')));
    b.send(op('.f1|en', 'B-f1', hlc(9100, 1, 'B'))); // newer than A's f1
    b.send(op('.f3|en', 'B-f3', hlc(9101, 2, 'B')));
    c.send(op('.f4|en', 'C-f4', hlc(9200, 1, 'C')));
    d.send(op('.f5|en', 'D-f5', hlc(9300, 1, 'D')));

    // Six ops in total; each editor receives the ones it didn't send. Waiting
    // for all of them guarantees every write landed before A leaves.
    await Promise.all([
      a.waitForAll({ type: 'op' }, 4),
      b.waitForAll({ type: 'op' }, 4),
      c.waitForAll({ type: 'op' }, 5),
      d.waitForAll({ type: 'op' }, 5),
    ]);

    // A leaves WITHOUT saving.
    a.close();

    // Remaining editors get A's highlight cleared AND a reset for A's paths.
    expect(await b.waitFor({ type: 'blur', clearAll: true })).toMatchObject({ userId: 'A' });
    const reset = await b.waitFor({ type: 'reset' });
    const entries = Object.fromEntries((reset.entries as Json[]).map((e) => [e.path, e]));
    expect(Object.keys(entries).sort()).toEqual(['.f1|en', '.f2|en']);
    // F1 still had B's (newer) op → falls back to B's value, not baseline.
    expect(entries['.f1|en']).toMatchObject({ value: 'B-f1' });
    expect(entries['.f1|en'].baseline).toBeUndefined();
    // F2 was A-only → no remaining op → revert to baseline.
    expect(entries['.f2|en']).toMatchObject({ baseline: true });

    // C and D receive the same reset.
    await c.waitFor({ type: 'reset' });
    await d.waitFor({ type: 'reset' });

    // Surviving server state: A's solo field is gone; everyone else's remains.
    const ops = Object.fromEntries((await snapshotOf(page)).map((o) => [o.path, o]));
    expect(ops['.f1|en']).toMatchObject({ value: 'B-f1', userId: 'B' });
    expect(ops['.f2|en']).toBeUndefined();
    expect(ops['.f3|en']).toMatchObject({ value: 'B-f3', userId: 'B' });
    expect(ops['.f4|en']).toMatchObject({ value: 'C-f4', userId: 'C' });
    expect(ops['.f5|en']).toMatchObject({ value: 'D-f5', userId: 'D' });

    [b, c, d].forEach((client) => client.close());
  });

  it('does NOT revert when a user closes one tab but keeps another open (multi-tab)', async () => {
    const page = freshPage();
    const [a1, a2, b] = await Promise.all([
      connect(page, 'A', 'Alice'), connect(page, 'A', 'Alice'), connect(page, 'B'),
    ]);

    a1.send(op('.f1|en', 'A-f1', hlc(11000, 1, 'A')));
    // Only the sending socket is excluded, so A's other tab sees it too.
    await Promise.all([a2.waitFor({ type: 'op' }), b.waitFor({ type: 'op' })]);

    // Close one of A's two connections.
    a1.close();

    // B must NOT receive a reset — A is still present via the second tab.
    await b.expectSilent(120);
    const ops = (await snapshotOf(page)).filter((o) => o.path === '.f1|en');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ value: 'A-f1', userId: 'A' });

    a2.close();
    b.close();
  });

  it('relays focus/blur editing signals to other users but not the sender', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A', 'Alice'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    a.send({ type: 'focus', path: '.title|en', userAvatar: 'https://img/a.png' });
    for (const peer of [b, c, d]) {
      expect(await peer.waitFor({ type: 'focus' })).toMatchObject({
        type: 'focus', path: '.title|en', userId: 'A', userName: 'Alice',
      });
    }
    await a.expectSilent();

    a.send({ type: 'blur', path: '.title|en' });
    for (const peer of [b, c, d]) {
      expect(await peer.next()).toMatchObject({ type: 'blur', path: '.title|en', userId: 'A' });
    }

    [a, b, c, d].forEach((client) => client.close());
  });

  it('tells remaining users to clear a leaving user\'s highlights (clearAll)', async () => {
    const page = freshPage();
    const [a, b, c] = await Promise.all([connect(page, 'A'), connect(page, 'B'), connect(page, 'C')]);

    a.send({ type: 'focus', path: '.title|en', userAvatar: '' });
    // Wait for the relay itself: a focus still in flight would otherwise be
    // read as the blur below.
    await Promise.all([b, c].map((peer) => peer.waitFor({ type: 'focus' })));

    a.close();

    for (const peer of [b, c]) {
      expect(await peer.next()).toMatchObject({ type: 'blur', userId: 'A', clearAll: true });
    }

    b.close();
    c.close();
  });

  it('commits on save: clears the overlay, broadcasts "saved", and a later leave reverts nothing', async () => {
    const page = freshPage();
    const [a, b, c, d] = await Promise.all([
      connect(page, 'A'), connect(page, 'B'), connect(page, 'C'), connect(page, 'D'),
    ]);

    a.send(op('.f1|en', 'A-f1', hlc(12000, 1, 'A')));
    b.send(op('.f2|en', 'B-f2', hlc(12001, 1, 'B')));
    // Both ops delivered before the save, so "saved" is the next message below.
    await Promise.all([
      a.waitFor({ type: 'op' }),
      b.waitFor({ type: 'op' }),
      c.waitForAll({ type: 'op' }, 2),
      d.waitForAll({ type: 'op' }, 2),
    ]);

    // The save route notifies the DO that the page was committed.
    const stub = env.PAGE_SYNC.get(env.PAGE_SYNC.idFromName(page));
    const res = await stub.fetch('https://page-sync/?action=saved', { method: 'POST' });
    expect(res.status).toBe(200);

    // Every connected editor is told the overlay was committed.
    for (const client of [a, b, c, d]) {
      expect(await client.next()).toMatchObject({ type: 'saved' });
    }

    // The op log is now empty.
    expect(await snapshotOf(page)).toEqual([]);

    // A leaving after a save reverts nothing — there are no uncommitted ops.
    // (A highlight-clear may still be relayed, but never a value reset/op.)
    a.close();
    const [mb, mc, md] = await Promise.all([b.drain(120), c.drain(120), d.drain(120)]);
    [mb, mc, md].forEach((messages) => {
      expect(messages.some((m) => m.type === 'reset' || m.type === 'op')).toBe(false);
    });

    [b, c, d].forEach((client) => client.close());
  });
});
