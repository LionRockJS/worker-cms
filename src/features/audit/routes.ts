// The audit log reader.
//
// Read-only on purpose: nothing here updates or deletes audit_events. Pruning
// belongs to the retention sweep alone, so there is no route an operator could
// use to edit their own trail.

import { Hono } from 'hono';
import { auditClassesPage, auditPage } from './template';
import type { Env, Variables } from '../../types';
import { dashboardPagination, renderPage } from '../../core/render/chrome';
import { dashboardPageNumber, dashboardPageSize } from '../../core/http/forms';
import { logAudit } from '../../core/db/audit';
import {
  CONTAINER_KINDS,
  DATA_CLASSES,
  clearDataClassCache,
  type ContainerKind,
  type DataClass,
  type DataClassRow,
} from '../../core/db/data-classes';
import { requirePermission } from '../../core/auth/guards';
import { userCan } from '../../core/auth/permissions';

export const auditRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const EVENT_CLASSES = ['auth', 'read', 'mutation', 'export', 'admin'];
const OUTCOMES = ['success', 'denied', 'error'];

/** An action filter is slug-like by construction, so anything else is dropped.
 *  That also removes the LIKE wildcards rather than escaping them. */
function safeActionFilter(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 64);
}

function oneOf(value: string | undefined, allowed: string[]): string {
  const candidate = (value ?? '').trim();
  return allowed.includes(candidate) ? candidate : '';
}

interface AuditEventRow {
  occurred_at: string;
  action: string;
  outcome: string;
  event_class: string;
  actor_user_id: string | null;
  actor_roles: string | null;
  acting_via: string | null;
  actor_name: string | null;
  source_ip: string | null;
  target_type: string | null;
  target_id: string | null;
  target_count: number | null;
  detail: string | null;
}

auditRoutes.get('/audit', requirePermission('audit:read'), async (c) => {
  const eventClass = oneOf(c.req.query('class'), EVENT_CLASSES);
  const outcome = oneOf(c.req.query('outcome'), OUTCOMES);
  const action = safeActionFilter(c.req.query('action'));

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (eventClass) { conditions.push('ae.event_class = ?'); params.push(eventClass); }
  if (outcome) { conditions.push('ae.outcome = ?'); params.push(outcome); }
  if (action) { conditions.push('ae.action LIKE ?'); params.push(`${action}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_events ae ${where}`)
    .bind(...params)
    .first<{ total: number }>();
  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);

  // The actor's name is resolved at read time rather than stored, so an erased
  // account simply stops resolving and the row keeps its internal id. The cast
  // bridges actor_user_id's TEXT affinity to users.id without giving up the
  // primary-key index on the users side.
  const rows = await c.env.DB.prepare(
    `SELECT ae.occurred_at, ae.action, ae.outcome, ae.event_class, ae.actor_user_id, ae.actor_roles,
            ae.acting_via, ae.source_ip, ae.target_type, ae.target_id, ae.target_count, ae.detail,
            u.name AS actor_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = CAST(ae.actor_user_id AS INTEGER)
       ${where}
      ORDER BY ae.seq DESC
      LIMIT ? OFFSET ?`,
  ).bind(...params, pageSize, (currentPage - 1) * pageSize).all<AuditEventRow>();

  // dashboardPagination reads only the pagination block, and its third argument
  // carries the active filters into every page link (blank values are dropped).
  const pagination = dashboardPagination(
    '/admin/audit',
    { results: [], pagination: { total, totalPages, currentPage, limit: pageSize } },
    { class: eventClass, outcome, action },
  );

  // Reading the trail is itself recorded, with the filters that were applied —
  // "who looked at whose history" is a question an audit asks too.
  logAudit(c, 'audit.read', 'audit', undefined, {
    ...(eventClass ? { class: eventClass } : {}),
    ...(outcome ? { outcome } : {}),
    ...(action ? { action } : {}),
    results: total,
  });

  return renderPage(c, auditPage, {
    events: rows.results,
    total,
    pagination,
    eventClass,
    outcome,
    action,
  });
});

// ── Container classification ──────────────────────────────────────────────────
// Viewing the policy needs audit:read; changing it is a system setting and
// needs menu:manage, because classifying a container is what turns read
// logging — and, for phi, fail-closed serving — on for it.

auditRoutes.get('/audit/classes', requirePermission('audit:read'), async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, container_kind, container_key, class, note, created_at FROM data_classes ORDER BY container_kind, container_key',
  ).all<DataClassRow>();

  return renderPage(c, auditClassesPage, {
    classes: rows.results,
    flash: c.req.query('flash') ?? undefined,
    canManage: await userCan(c, 'menu:manage'),
  });
});

auditRoutes.post('/audit/classes', requirePermission('menu:manage'), async (c) => {
  const form = await c.req.formData();
  const kind = String(form.get('container_kind') ?? '');
  const key = String(form.get('container_key') ?? '').trim();
  const dataClass = String(form.get('class') ?? '');
  const note = String(form.get('note') ?? '').trim();

  if (!CONTAINER_KINDS.includes(kind as ContainerKind) || !DATA_CLASSES.includes(dataClass as DataClass) || !key) {
    return c.redirect('/admin/audit/classes?flash=audit.flash.invalid');
  }

  // Re-classifying a container updates it rather than failing: an operator
  // correcting pii to phi should not have to delete the row first.
  await c.env.DB.prepare(
    `INSERT INTO data_classes (container_kind, container_key, class, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(container_kind, container_key) DO UPDATE SET class = excluded.class, note = excluded.note`,
  ).bind(kind, key, dataClass, note || null).run();
  clearDataClassCache();

  logAudit(c, 'data_class.set', 'settings', `${kind}:${key}`, { class: dataClass });
  return c.redirect('/admin/audit/classes?flash=audit.flash.saved');
});

auditRoutes.post('/audit/classes/:id/delete', requirePermission('menu:manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT container_kind, container_key FROM data_classes WHERE id = ?')
    .bind(id)
    .first<{ container_kind: string; container_key: string }>();
  if (!row) return c.redirect('/admin/audit/classes?flash=audit.flash.invalid');

  await c.env.DB.prepare('DELETE FROM data_classes WHERE id = ?').bind(id).run();
  clearDataClassCache();

  // Declassifying stops reads being recorded, so the act itself is recorded.
  logAudit(c, 'data_class.clear', 'settings', `${row.container_kind}:${row.container_key}`);
  return c.redirect('/admin/audit/classes?flash=audit.flash.removed');
});
