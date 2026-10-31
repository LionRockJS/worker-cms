// The audit log reader.
//
// Read-only on purpose: nothing here updates or deletes audit_events. Pruning
// belongs to the retention sweep alone, so there is no route an operator could
// use to edit their own trail.

import { Hono } from 'hono';
import { auditClassesPage, auditPage, auditReviewPage } from './template';
import { archiveHealth, reviewSignals } from './signals';
import type { Env, Variables } from '../../types';
import { dashboardPagination, renderPage } from '../../core/render/chrome';
import { dashboardPageNumber, dashboardPageSize } from '../../core/http/forms';
import { contextActor, logAudit, writeAuditRows } from '../../core/db/audit';
import { auditUnavailable, recordRead, recordTableReads } from '../../core/http/access-log';
import { outageEnabled } from '../../core/db/audit-outages';
import { outagePage, readOutage, reconcileOutage, type OutageReview } from './outages';
import {
  CONTAINER_KINDS,
  DATA_CLASSES,
  clearDataClassCache,
  classFor,
  resolveDataClasses,
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
  event_id: string;
  data_class: DataClass | 'none';
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
    `SELECT ae.event_id, ae.data_class, ae.occurred_at, ae.action, ae.outcome, ae.event_class, ae.actor_user_id, ae.actor_roles,
            ae.acting_via, ae.source_ip, ae.target_type, ae.target_id, ae.target_count, ae.detail,
            u.name AS actor_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = CAST(ae.actor_user_id AS INTEGER)
       ${where}
      ORDER BY ae.seq DESC
      LIMIT ? OFFSET ?`,
  ).bind(...params, pageSize, (currentPage - 1) * pageSize).all<AuditEventRow>();
  recordTableReads('user.audit-actor-read', 'users', rows.results.filter(row => row.actor_name !== null && row.actor_user_id !== null).map(row => row.actor_user_id!));

  for (const dataClass of ['none', 'pii', 'phi'] as const) {
    const ids = rows.results.filter(row => row.data_class === dataClass).map(row => row.event_id);
    if (ids.length) recordRead({ action: 'audit.events-read', kind: 'table', key: 'audit_events', targetType: 'audit_event', ids, count: ids.length, minimumClass: dataClass === 'none' ? undefined : dataClass });
  }

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
    `SELECT d.id, d.container_kind, d.container_key,
      CASE WHEN f.level = 2 THEN 'phi' ELSE d.class END AS class, d.note, d.created_at
     FROM data_classes d LEFT JOIN data_class_floors f ON f.container_kind = d.container_kind AND f.container_key = d.container_key
     UNION ALL SELECT 0, f.container_kind, f.container_key, CASE f.level WHEN 2 THEN 'phi' ELSE 'pii' END,
       'Retained classification; removal requires review.', '' FROM data_class_floors f
       WHERE NOT EXISTS (SELECT 1 FROM data_classes d WHERE d.container_kind = f.container_kind AND d.container_key = f.container_key)
     ORDER BY container_kind, container_key`,
  ).all<DataClassRow>();
  const effective = await resolveDataClasses(c.env);
  if (!effective.ok) return auditUnavailable(c);
  for (const row of rows.results) row.class = classFor(effective, row.container_kind as ContainerKind, row.container_key) ?? row.class;
  recordTableReads('audit.classes-read', 'data_classes', rows.results.filter(row => row.id > 0).map(row => row.id));
  const retained = rows.results.filter(row => row.id === 0);
  if (retained.length) recordRead({ action: 'audit.class-floors-read', kind: 'table', key: 'data_classes', targetType: 'data_class_floor',
    ids: retained.map(row => `${row.container_kind}:${row.container_key}`), count: retained.length,
    minimumClass: classFor(effective, 'table', 'data_class_floors') ?? undefined, detail: { source_table: 'data_class_floors' } });

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
  const effective = await resolveDataClasses(c.env, true);
  if (!effective.ok) return auditUnavailable(c);
  if (classFor(effective, kind as ContainerKind, key) === 'phi' && dataClass !== 'phi') {
    return c.json({ error: 'Classification reduction requires a reviewed declassification process' }, 409, { 'Cache-Control': 'no-store' });
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
  if (id <= 0) return c.json({ error: 'Classification removal requires a reviewed declassification process' }, 409, { 'Cache-Control': 'no-store' });
  const row = await c.env.DB.prepare('SELECT container_kind, container_key FROM data_classes WHERE id = ?')
    .bind(id)
    .first<{ container_kind: string; container_key: string }>();
  if (!row) return c.redirect('/admin/audit/classes?flash=audit.flash.invalid');
  return c.json({ error: 'Classification removal requires a reviewed declassification process' }, 409, { 'Cache-Control': 'no-store' });
});

// ── Review ────────────────────────────────────────────────────────────────────
// Detection and archive health in one screen. Recording a trail nobody examines
// satisfies no regime — ISO 27001 A 8.16, SOC 2 CC7.2, NIST AU-6 and HIPAA
// §164.308(a)(1)(ii)(D) all require the log be reviewed — so this is the screen
// that makes reviewing it a minute's work rather than a query-writing exercise.

auditRoutes.get('/audit/review', requirePermission('audit:read'), async (c) => {
  const [signals, health, outages] = await Promise.all([
    reviewSignals(c.env),
    archiveHealth(c.env),
    outagePage(c.env, (c.req.query('outage_cursor') ?? '').slice(0, 2048) || undefined),
  ]);
  for (const signal of signals) {
    recordTableReads('user.audit-actor-read', 'users', signal.rows.flatMap(row => row.user_id == null ? [] : [row.user_id]));
    if (!signal.rows.length) continue;
    const minimumClass = signal.rows.some(row => row.data_class === 'phi') ? 'phi' : signal.rows.some(row => row.data_class === 'pii') ? 'pii' : undefined;
    recordRead({ action: 'audit.signal-read', kind: 'table', key: 'audit_events', targetType: 'audit_signal', ids: [signal.id], count: signal.rows.length, minimumClass });
  }

  // Opening the review is itself a read of the trail.
  logAudit(c, 'audit.review', 'audit', undefined, {
    flagged: signals.reduce((sum, signal) => sum + signal.rows.length, 0),
  });

  return renderPage(c, auditReviewPage, { signals, health, outages,
    canReconcile: await userCan(c, 'menu:manage') });
});

auditRoutes.get('/audit/outages/:id', requirePermission('audit:read'), async (c) => {
  if (!outageEnabled(c.env)) return c.notFound();
  try {
    const incident = await readOutage(c.env, c.req.param('id'));
    if (!incident) return c.notFound();
    const dataClass = incident.records.some(row => row.dataClass === 'phi') ? 'phi'
      : incident.records.some(row => row.dataClass === 'pii') ? 'pii' : 'none';
    await writeAuditRows(c, [{ action: 'audit.outage.read', eventClass: 'admin', dataClass,
      retentionClass: dataClass === 'none' ? 'admin_config' : `${dataClass}_access`, outcome: 'success', targetType: 'audit_outage', targetId: incident.id,
      targetIds: null, targetCount: 1, containerKey: null, queryFingerprint: null, detail: null,
    }], contextActor(c), true);
    return c.json(incident, 200, { 'Cache-Control': 'no-store' });
  } catch { return auditUnavailable(c); }
});

auditRoutes.post('/audit/outages/:id/reconcile', requirePermission('audit:read'), requirePermission('menu:manage'), async (c) => {
  const form = await c.req.formData();
  try {
    await reconcileOutage(c.env, c.req.param('id'), contextActor(c), {
      disposition: String(form.get('disposition') ?? '') as OutageReview['disposition'],
      evidenceRef: String(form.get('evidence_ref') ?? '').trim(),
      evidenceSha256: String(form.get('evidence_sha256') ?? '').trim(),
    });
    return c.redirect('/admin/audit/review');
  } catch {
    return c.json({ error: 'Review not saved; verify evidence and retry after repair' }, 409, { 'Cache-Control': 'no-store' });
  }
});
