import { validateAccessSession } from '../auth/sessions';
import { effectivePermissions, resolveRolePermissions } from '../auth/roles';
// Durable Object: one instance per page, handles hybrid WebSocket live sync.
//
// Model: a live overlay of *uncommitted* edits on top of the last-saved page.
// Ordinary form fields are LWW registers stored per (path, user_id). Richtext
// Markdown is a Y.Text sequence CRDT, so concurrent changes within one field
// merge instead of replacing the whole field.
//
// Protocol (JSON over WebSocket):
//   Client → Server  { type: 'sync' }
//   Client → Server  { type: 'op', path, value, hlc, opId }
//   Client → Server  { type: 'text-sync', path, baseline }
//   Client → Server  { type: 'text-update', path, update }
//   Server → Client  { type: 'snapshot', ops: [...] }
//   Server → Client  { type: 'op', path, value, hlc, userId, userName, opId }
//   Server → Client  { type: 'reset', entries: [{ path, value, hlc } | { path, baseline: true }] }
//       — sent when an editor leaves without saving: their uncommitted edits are
//         dropped; each affected field falls back to the next editor's value, or
//         to the saved baseline if none remains.
//   Server → Client  { type: 'saved' }
//       — sent (via the save route's HTTP call) when the page is saved: the live
//         overlay is committed, so clients adopt current values as the baseline.
//
// HLC format: "<Date.now()>.<counter>.<userId>" – lexicographic ordering is sufficient.

import type { Env } from '../../types';
import * as Y from 'yjs';

const MAX_TEXT_BASELINE = 1_000_000;
const MAX_TEXT_UPDATE_BASE64 = 2_000_000;
const MAX_PATH_LENGTH = 512;

function strField(msg: Record<string, unknown>, key: string): string {
  return String(msg[key] ?? '');
}

interface WsAttachment {
  userId: string;
  userName: string;
  sid: string;
  exp: number;
  window?: number;
  messages?: number;
}

interface LwwFieldRow {
  path: string;
  value: string;
  hlc: string;
  userId: string;
  userName: string;
  opId: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

interface PresenceInput {
  lastActive?: unknown;
  lastSeen?: unknown;
  userAvatar?: unknown;
}

interface PresenceRow {
  user_id: string;
  user_name: string;
  user_avatar: string | null;
  last_seen: string;
  last_active: string;
}

export class PageSyncDO implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.sql = state.storage.sql;

    // The old name overclaimed what this table did. Its rows are an ephemeral
    // LWW overlay, so upgrading can discard them safely; richtext CRDT state is
    // stored separately below.
    this.sql.exec(`DROP TABLE IF EXISTS crdt_ops`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lww_field_ops (
        path      TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        user_name TEXT NOT NULL,
        value     TEXT NOT NULL,
        hlc       TEXT NOT NULL,
        op_id     TEXT NOT NULL,
        PRIMARY KEY (path, user_id)
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS crdt_text_docs (
        path       TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence (
        user_id      TEXT    PRIMARY KEY,
        user_name    TEXT    NOT NULL,
        user_avatar  TEXT,
        last_seen    TEXT    NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        last_active  TEXT    NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal call from the save route: commit the live overlay.
    if (url.searchParams.get('action') === 'saved') {
      this.sql.exec(`DELETE FROM lww_field_ops`);
      this.sql.exec(`DELETE FROM crdt_text_docs`);
      await this.broadcast(JSON.stringify({ type: 'saved' }));
      return new Response('ok');
    }

    if (url.searchParams.get('action') === 'presence') {
      return this.handlePresence(request);
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const userId = request.headers.get('X-User-Id') ?? '';
    const userName = request.headers.get('X-User-Name') ?? '';

    const attachment: WsAttachment = { userId, userName, sid: request.headers.get('X-Session-Id') ?? '', exp: Number(request.headers.get('X-Session-Expires')) };
    if (!await this.validSession(attachment)) return new Response('Unauthorized', { status: 401 });
    if (this.state.getWebSockets().length >= 32) return new Response('Too many connections', { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    await this.state.storage.setAlarm(Date.now() + 60_000);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handlePresence(request: Request): Promise<Response> {
    this.deleteStalePresence();

    if (request.method === 'GET') {
      const rows = this.sql.exec(
        `SELECT user_id, user_name, user_avatar, last_seen, last_active
         FROM presence
         ORDER BY last_seen_ms DESC`,
      ).toArray() as unknown as PresenceRow[];
      return Response.json(rows);
    }

    const userId = request.headers.get('X-User-Id') ?? '';
    if (!userId) return Response.json({ error: 'missing_user' }, { status: 400 });

    if (request.method === 'DELETE') {
      this.sql.exec(`DELETE FROM presence WHERE user_id = ?`, userId);
      return Response.json({ ok: true });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    const userName = request.headers.get('X-User-Name') ?? '';
    if (!userName) return Response.json({ error: 'missing_user' }, { status: 400 });

    const body = await request.json().catch(() => ({})) as PresenceInput;
    const now = new Date();
    const lastSeen = typeof body.lastSeen === 'string' && Number.isFinite(Date.parse(body.lastSeen))
      ? body.lastSeen
      : now.toISOString();
    const lastActive = typeof body.lastActive === 'string' && Number.isFinite(Date.parse(body.lastActive))
      ? body.lastActive
      : lastSeen;
    const userAvatar = typeof body.userAvatar === 'string' && body.userAvatar ? body.userAvatar : null;

    this.sql.exec(
      `INSERT INTO presence (user_id, user_name, user_avatar, last_seen, last_seen_ms, last_active)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         user_name    = excluded.user_name,
         user_avatar  = excluded.user_avatar,
         last_seen    = excluded.last_seen,
         last_seen_ms = excluded.last_seen_ms,
         last_active  = excluded.last_active`,
      userId,
      userName,
      userAvatar,
      lastSeen,
      Date.parse(lastSeen),
      lastActive,
    );

    return Response.json({ ok: true });
  }

  private deleteStalePresence(): void {
    this.sql.exec(`DELETE FROM presence WHERE last_seen_ms < ?`, Date.now() - 10 * 60 * 1000);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!await this.authorize(ws)) return;
    const attachment = ws.deserializeAttachment() as WsAttachment;
    const window = Math.floor(Date.now() / 1000);
    attachment.messages = attachment.window === window ? (attachment.messages ?? 0) + 1 : 1;
    attachment.window = window;
    ws.serializeAttachment(attachment);
    if (attachment.messages > 60 || (typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength) > 2_100_000) {
      ws.close(1009, 'Message budget exceeded');
      return;
    }
    const { userId, userName } = attachment;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.type === 'sync') {
      const ops = this.sql.exec(
        `SELECT path, value, hlc,
                user_id   AS userId,
                user_name AS userName,
                op_id     AS opId
         FROM lww_field_ops`,
      ).toArray() as unknown as LwwFieldRow[];
      ws.send(JSON.stringify({ type: 'snapshot', ops }));
      return;
    }

    // Transient editing-presence signals: which field a user is in. Pure relay,
    // never stored — they only matter while both editors are connected.
    // userAvatar is intentionally omitted from the relay; clients should read
    // it from the presence API to avoid echoing client-supplied URLs.
    if (msg.type === 'focus') {
      const path = strField(msg, 'path');
      if (!this.validTextPath(path)) return;
      await this.broadcast(JSON.stringify({ type: 'focus', path, userId, userName }), ws);
      return;
    }

    if (msg.type === 'blur') {
      const path = strField(msg, 'path');
      if (!this.validTextPath(path)) return;
      await this.broadcast(JSON.stringify({ type: 'blur', path, userId }), ws);
      return;
    }

    if (msg.type === 'text-sync') {
      const path = strField(msg, 'path');
      const baseline = strField(msg, 'baseline');
      if (!this.validTextPath(path) || baseline.length > MAX_TEXT_BASELINE) return;
      let doc: Y.Doc;
      try { doc = this.loadTextDoc(path, baseline); } catch { ws.close(1009, 'Text budget exceeded'); return; }
      ws.send(JSON.stringify({ type: 'text-sync', path, update: bytesToBase64(Y.encodeStateAsUpdate(doc)) }));
      return;
    }

    if (msg.type === 'text-update') {
      const path = strField(msg, 'path');
      const encoded = strField(msg, 'update');
      if (!this.validTextPath(path) || !encoded || encoded.length > MAX_TEXT_UPDATE_BASE64) return;
      const update = base64ToBytes(encoded);
      if (!update) return;
      let doc: Y.Doc;
      try {
        doc = this.loadTextDoc(path, '');
        Y.applyUpdate(doc, update);
        this.storeTextDoc(path, doc);
      } catch {
        return;
      }
      await this.broadcast(JSON.stringify({ type: 'text-update', path, update: encoded, userId, userName }), ws);
      return;
    }

    if (msg.type === 'op') {
      const path  = strField(msg, 'path');
      const value = strField(msg, 'value');
      const hlc   = strField(msg, 'hlc');
      const opId  = strField(msg, 'opId') || crypto.randomUUID();

      if (!this.validTextPath(path) || !hlc || hlc.length > 100 || opId.length > 100 || value.length > 1_000_000) return;
      const budget = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(length(value) + length(path)), 0) AS bytes FROM lww_field_ops WHERE NOT (path = ? AND user_id = ?)', path, userId).one();
      if (Number(budget.n) >= 256 || Number(budget.bytes) + value.length + path.length > 4_000_000) { ws.close(1009, 'Field budget exceeded'); return; }

      const existing = this.sql.exec(
        `SELECT hlc FROM lww_field_ops WHERE path = ? AND user_id = ?`, path, userId,
      ).toArray()[0] as { hlc: string } | undefined;

      if (!existing || hlc > existing.hlc) {
        this.sql.exec(
          `INSERT OR REPLACE INTO lww_field_ops (path, user_id, user_name, value, hlc, op_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          path, userId, userName, value, hlc, opId,
        );

        const broadcast = JSON.stringify({ type: 'op', path, value, hlc, userId, userName, opId });
        await this.broadcast(broadcast, ws);
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
    try { ws.close(1000, 'Closing'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
    try { ws.close(1011, 'Error'); } catch { /* already closed */ }
  }

  // When an editor's last connection drops without saving, discard their
  // uncommitted ops and tell remaining clients what each field reverts to.
  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    const userId = attachment?.userId;
    if (!userId) return;

    // Keep ops if the same user still has another connection open (e.g. 2 tabs).
    const stillConnected = this.state.getWebSockets().some(
      (other) => other !== ws && (other.deserializeAttachment() as WsAttachment | null)?.userId === userId,
    );
    if (stillConnected) return;

    // Remove the leaving user's editing highlights from every other client.
    await this.broadcast(JSON.stringify({ type: 'blur', userId, clearAll: true }), ws);

    const paths = this.sql.exec(
      `SELECT DISTINCT path FROM lww_field_ops WHERE user_id = ?`, userId,
    ).toArray() as unknown as Array<{ path: string }>;
    if (!paths.length) return;

    this.sql.exec(`DELETE FROM lww_field_ops WHERE user_id = ?`, userId);

    const entries = paths.map(({ path }) => {
      const winner = this.sql.exec(
        `SELECT value, hlc FROM lww_field_ops WHERE path = ? ORDER BY hlc DESC LIMIT 1`, path,
      ).toArray()[0] as { value: string; hlc: string } | undefined;
      return winner ? { path, value: winner.value, hlc: winner.hlc } : { path, baseline: true };
    });

    await this.broadcast(JSON.stringify({ type: 'reset', entries }), ws);
  }

  private async broadcast(payload: string, except?: WebSocket): Promise<void> {
    for (const other of this.state.getWebSockets()) {
      if (other !== except && await this.authorize(other)) {
        try { other.send(payload); } catch { /* already closed */ }
      }
    }
  }

  private async validSession(attachment: WsAttachment | null): Promise<boolean> {
    if (!attachment || !Number.isFinite(attachment.exp)) return false;
    const user = await validateAccessSession(this.env.DB, {
      sub: attachment.userId, sid: attachment.sid, exp: attachment.exp,
      type: 'access', iat: 0, name: '', email: '', role: '',
    });
    return !!user && effectivePermissions(await resolveRolePermissions(this.env), user.role).has('content:write');
  }

  private async authorize(ws: WebSocket): Promise<boolean> {
    try {
      if (await this.validSession(ws.deserializeAttachment() as WsAttachment | null)) return true;
    } catch { /* Fail closed if authorization storage is unavailable. */ }
    try { ws.close(1008, 'Session expired or revoked'); } catch { /* already closed */ }
    return false;
  }

  async alarm(): Promise<void> {
    for (const ws of this.state.getWebSockets()) await this.authorize(ws);
    if (this.state.getWebSockets().length) await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  private validTextPath(path: string): boolean {
    return path.length > 0 && path.length <= MAX_PATH_LENGTH && /^[.@*#\d][\w\[\].@*|:-]*$/.test(path);
  }

  private loadTextDoc(path: string, baseline: string): Y.Doc {
    const row = this.sql.exec(
      `SELECT state FROM crdt_text_docs WHERE path = ?`, path,
    ).toArray()[0];
    if (!row && (this.sql.exec('SELECT COUNT(*) AS n FROM crdt_text_docs').one().n as number) >= 64) throw new Error('Text field budget exceeded');
    const doc = new Y.Doc();
    if (row && typeof row.state === 'string') {
      const state = base64ToBytes(row.state);
      if (state) Y.applyUpdate(doc, state);
      return doc;
    }
    if (baseline) doc.getText('markdown').insert(0, baseline);
    this.storeTextDoc(path, doc);
    return doc;
  }

  private storeTextDoc(path: string, doc: Y.Doc): void {
    const state = bytesToBase64(Y.encodeStateAsUpdate(doc));
    const otherBytes = this.sql.exec('SELECT COALESCE(SUM(length(state)), 0) AS bytes FROM crdt_text_docs WHERE path != ?', path).one().bytes;
    if (state.length + Number(otherBytes) > 4_000_000) throw new Error('Text document budget exceeded');
    this.sql.exec(
      `INSERT INTO crdt_text_docs (path, state, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      path,
      state,
      new Date().toISOString(),
    );
  }
}
