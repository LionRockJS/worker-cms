// The audit log reader.
//
// Read-only on purpose: nothing here updates or deletes audit_events. Pruning
// belongs to the retention sweep alone, so there is no route an operator could
// use to edit their own trail.

import { Hono } from 'hono';
import { auditPage } from './template';
import type { Env, Variables } from '../../types';
import { dashboardPagination, renderPage } from '../../core/render/chrome';
import { dashboardPageNumber, dashboardPageSize } from '../../core/http/forms';
import { logAudit } from '../../core/db/audit';
import { requirePermission } from '../../core/auth/guards';

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
