// ============================================================
// /audit/events — a plugin's access events in the host audit log.
//
// Some reads never pass through /__cms in a form the host can attribute:
// a plugin renders a page it fetched once, streams a file, prints a PDF, or
// serves a no-login link to someone with no CMS account. The plugin knows
// what it disclosed and to whom; this lets it say so in audit_events, the
// same stream the host's own reads go to, so a reviewer has one trail.
//
//   POST /audit/events   { events: [{ action, page_id, event_class?, detail? }] }
//   GET  /audit/events?page_id=&limit=&before=   that plugin's events on one page
//
// What keeps the stream honest:
//   - Only pages the plugin may read. Each event targets one page; its
//     container is that page's type, so classification applies as usual.
//   - The action is namespaced `plugin.<action>`: a plugin cannot write an
//     `auth.*` or `page.*` event the host's own signals would trust.
//   - acting_via is the plugin; the acting user is the plugin's assertion
//     (x-acting-user-id), marked unverified in the detail as everywhere else.
//     A no-login link has no user: the plugin omits the header and names the
//     link in the detail instead.
//   - No email, ever (see core/db/audit.ts): a detail value that looks like
//     one is refused. Details are small flat scalars.
//   - Classified pages keep their class's retention (phi fails closed, as for
//     host reads). An unclassified page still records — the plugin asked —
//     under `plugin_access`, which the sweep keeps 365 days hot.
//   - Reading events back is itself recorded (`audit.read`), and returns only
//     the calling plugin's own events.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import type { AppContext } from '../../../core/http/context';
import { writeAuditRows, type AuditRow } from '../../../core/db/audit';
import { classFor, failsClosed, resolveDataClasses, retentionClassFor, strongestClass } from '../../../core/db/data-classes';
import { pageSensitivityFloors } from '../../../core/db/sensitivity';
import { auditBackgroundReads, auditUnavailable } from '../../../core/http/access-log';
import { inventoried } from '../../../core/http/regulated-profile';
import { authenticatePlugin } from './auth';
import { pluginReadActor } from './read-audit';
import { noteActingUser } from '../evidence-common';
import { pageTypeScopeAllows } from '../page-types';

export const auditApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const MAX_AUDIT_EVENTS = 100;
export const PLUGIN_ACCESS_RETENTION = 'plugin_access';
const ACTION = /^[a-z][a-z0-9_.-]{0,63}$/;
const DETAIL_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_TEXT = 200;
const MAX_DETAIL_JSON = 2000;
const MAX_READ = 200;

interface EventInput {
  action: string;
  page_id: number;
  event_class: 'read' | 'export';
  detail: Record<string, string | number | boolean>;
}

type Parsed = { ok: true; events: EventInput[] } | { ok: false; index: number; error: string };

/** Parses `{ events: [...] }`; the first problem, by input index, when any is malformed. */
export function readAuditEvents(body: unknown): Parsed {
  const items = body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : null;
  if (!items || !items.length || items.length > MAX_AUDIT_EVENTS) return { ok: false, index: -1, error: 'invalid_body' };
  const events: EventInput[] = [];
  for (const [index, item] of items.entries()) {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (!entry) return { ok: false, index, error: 'invalid_event' };
    const action = typeof entry.action === 'string' ? entry.action : '';
    if (!ACTION.test(action)) return { ok: false, index, error: 'invalid_action' };
    const pageId = Number(entry.page_id);
    if (!Number.isSafeInteger(pageId) || pageId <= 0) return { ok: false, index, error: 'invalid_page_id' };
    const eventClass = entry.event_class === undefined ? 'read' : entry.event_class;
    if (eventClass !== 'read' && eventClass !== 'export') return { ok: false, index, error: 'invalid_event_class' };
    const raw = entry.detail === undefined ? {} : entry.detail;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, index, error: 'invalid_detail' };
    const detail: Record<string, string | number | boolean> = {};
    const pairs = Object.entries(raw as Record<string, unknown>);
    if (pairs.length > MAX_DETAIL_KEYS) return { ok: false, index, error: 'invalid_detail' };
    for (const [key, value] of pairs) {
      if (!DETAIL_KEY.test(key)) return { ok: false, index, error: 'invalid_detail' };
      if (typeof value === 'string') {
        if (value.length > MAX_DETAIL_TEXT) return { ok: false, index, error: 'invalid_detail' };
        if (EMAIL.test(value)) return { ok: false, index, error: 'detail_contains_email' };
      } else if (!(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
        return { ok: false, index, error: 'invalid_detail' };
      }
      detail[key] = value;
    }
    if (JSON.stringify(detail).length > MAX_DETAIL_JSON) return { ok: false, index, error: 'invalid_detail' };
    events.push({ action, page_id: pageId, event_class: eventClass, detail });
  }
  return { ok: true, events };
}

interface PageRow { id: number; uuid: string; page_type: string | null }

async function readPages(c: AppContext, ids: number[]): Promise<PageRow[]> {
  return (await c.env.DB.prepare('SELECT id, uuid, page_type FROM pages WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(ids)])).all<PageRow>()).results;
}

auditApiRoutes.post('/audit/events', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;
  const parsed = readAuditEvents(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error, ...(parsed.index >= 0 ? { index: parsed.index } : { max: MAX_AUDIT_EVENTS }) }, 400);

  const policy = await resolveDataClasses(c.env, true);
  if (!policy.ok) return auditUnavailable(c);
  const pages = await readPages(c, parsed.events.map((event) => event.page_id));
  const floors = await pageSensitivityFloors(c.env, pages.map((page) => String(page.id)));
  const actor = pluginReadActor(c, auth.pluginId);
  const errors: Array<{ index: number; error: string }> = [];
  const rows: AuditRow[] = [];
  const occurredAt = new Date().toISOString();
  for (const [index, event] of parsed.events.entries()) {
    const page = pages.find((entry) => entry.id === event.page_id);
    const pageType = page?.page_type ?? 'default';
    if (!page) { errors.push({ index, error: 'not_found' }); continue; }
    if (!pageTypeScopeAllows(auth.readableTypes, pageType)) { errors.push({ index, error: 'forbidden_page_type' }); continue; }
    if (!inventoried(c.env, 'page_type', pageType)) { errors.push({ index, error: 'not_inventoried' }); continue; }
    const dataClass = strongestClass([classFor(policy, 'page_type', pageType), floors.get(String(page.id))]);
    const detail: Record<string, unknown> = { ...event.detail, plugin_id: auth.pluginId };
    noteActingUser(c, detail);
    rows.push({
      occurredAt,
      action: `plugin.${event.action}`,
      eventClass: event.event_class,
      dataClass,
      retentionClass: dataClass === 'none' ? PLUGIN_ACCESS_RETENTION : retentionClassFor(dataClass),
      outcome: 'success',
      targetType: 'page',
      targetId: String(page.id),
      targetIds: null,
      targetCount: 1,
      containerKey: pageType,
      queryFingerprint: null,
      detail,
    });
  }
  // ePHI fails closed: the plugin learns the write failed before it serves.
  const strict = rows.some((row) => row.dataClass !== 'none' && failsClosed(row.dataClass));
  try {
    await writeAuditRows(c, rows, actor, strict);
  } catch {
    return auditUnavailable(c);
  }
  return c.json({ recorded: rows.length, errors });
});

auditApiRoutes.get('/audit/events', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;
  const pageId = Number(c.req.query('page_id'));
  if (!Number.isSafeInteger(pageId) || pageId <= 0) return c.json({ error: 'invalid_page_id' }, 400);
  const limit = Math.min(MAX_READ, Math.max(1, Math.floor(Number(c.req.query('limit')) || 50)));
  const before = Math.floor(Number(c.req.query('before')) || 0);
  const [page] = await readPages(c, [pageId]);
  if (!page) return c.json({ error: 'not_found' }, 404);
  if (!pageTypeScopeAllows(auth.readableTypes, page.page_type ?? 'default')) return c.json({ error: 'forbidden_page_type' }, 403);

  const rows = (await c.env.DB.prepare(
    `SELECT seq, event_id, occurred_at, action, event_class, outcome, actor_user_id, detail FROM audit_events
      WHERE target_type = 'page' AND target_id = ? AND acting_via = ? AND action LIKE 'plugin.%' ${before > 0 ? 'AND seq < ?' : ''}
      ORDER BY seq DESC LIMIT ?`,
  ).bind(...[String(pageId), auth.pluginId, ...(before > 0 ? [before] : []), limit + 1]).all<{
    seq: number; event_id: string; occurred_at: string; action: string; event_class: string; outcome: string; actor_user_id: string | null; detail: string | null;
  }>()).results;
  const more = rows.length > limit;
  const events = rows.slice(0, limit);
  // Names come from the users table now, never from the trail: erasing an account removes them.
  const userIds = [...new Set(events.map((event) => event.actor_user_id).filter((id): id is string => Boolean(id)))];
  const users = userIds.length ? (await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(userIds.map(Number))).all<{ id: number; name: string; email: string }>()).results : [];
  const actor = pluginReadActor(c, auth.pluginId);
  await auditBackgroundReads(c.env, [{ action: 'plugin.audit-actor-read', kind: 'table', key: 'users', targetType: 'users', ids: users.map((user) => String(user.id)), count: users.length }], actor).catch(() => []);
  const detail: Record<string, unknown> = { plugin_id: auth.pluginId, results: events.length, ...(before > 0 ? { before } : {}) };
  noteActingUser(c, detail);
  await writeAuditRows(c, [{
    action: 'audit.read', eventClass: 'admin', retentionClass: 'admin_config', outcome: 'success', dataClass: 'none',
    targetType: 'page', targetId: String(pageId), targetIds: null, targetCount: 1, containerKey: page.page_type ?? 'default', queryFingerprint: null, detail,
  }], actor);

  return c.json({
    events: events.map((event) => {
      const user = users.find((entry) => String(entry.id) === event.actor_user_id);
      let parsedDetail: Record<string, unknown> = {};
      try { parsedDetail = event.detail ? JSON.parse(event.detail) as Record<string, unknown> : {}; } catch { /* unreadable: none */ }
      return {
        seq: event.seq,
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        action: event.action.slice('plugin.'.length),
        event_class: event.event_class,
        outcome: event.outcome,
        actor_user_id: event.actor_user_id,
        actor_name: user?.name ?? null,
        actor_email: user?.email ?? null,
        detail: parsedDetail,
      };
    }),
    next: more ? events[events.length - 1].seq : null,
  }, 200, { 'Cache-Control': 'no-store' });
});
