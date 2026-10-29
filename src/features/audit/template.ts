import { adminLayout, type BaseTemplateProps } from '../../core/render/layout';
import { renderView } from '../../core/render/liquid';

interface AuditPagination {
  total: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  previousHref: string;
  nextHref: string;
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

/** What the Actor column shows. A row with no user is not a gap in the record:
 *  a contributor can act on its own behalf, and a refused sign-in never got far
 *  enough to name an account. */
function actorLabel(row: AuditEventRow): string {
  if (row.acting_via) return `plugin:${row.acting_via}`;
  if (row.actor_name) return row.actor_name;
  if (row.actor_user_id) return `#${row.actor_user_id}`;
  return '—';
}

function targetLabel(row: AuditEventRow): string {
  if (!row.target_type) return '—';
  if (row.target_id) return `${row.target_type} #${row.target_id}`;
  if (row.target_count !== null) return `${row.target_type} ×${row.target_count}`;
  return row.target_type;
}

export async function auditPage(views: Fetcher, opts: BaseTemplateProps & {
  events: AuditEventRow[];
  total: number;
  pagination?: AuditPagination;
  eventClass?: string;
  outcome?: string;
  action?: string;
}): Promise<string> {
  const { events, total, pagination, eventClass = '', outcome = '', action = '' } = opts;
  const showPagination = (pagination?.totalPages ?? 1) > 1;
  const rangeFrom = total === 0 || !pagination ? 0 : (pagination.currentPage - 1) * pagination.pageSize + 1;
  const rangeTo = rangeFrom === 0 ? 0 : rangeFrom + events.length - 1;
  const body = await renderView(views, '/templates/audit.json', {
    eventCountLabel: `${total} event${total === 1 ? '' : 's'}`,
    hasEvents: events.length > 0,
    filterAction: '/admin/audit',
    eventClass,
    outcome,
    action,
    classOptions: ['auth', 'read', 'mutation', 'export', 'admin'].map((value) => ({
      value,
      selected: value === eventClass,
    })),
    outcomeOptions: ['success', 'denied', 'error'].map((value) => ({
      value,
      selected: value === outcome,
    })),
    events: events.map((row) => ({
      // Raw timestamp: the view formats it with l10n_date in the admin's
      // locale and the CMS's configured timezone.
      occurredAt: row.occurred_at,
      action: row.action,
      eventClass: row.event_class,
      outcome: row.outcome,
      isDenied: row.outcome !== 'success',
      actorLabel: actorLabel(row),
      actorRoles: row.actor_roles ?? '',
      hasActorRoles: !!row.actor_roles,
      targetLabel: targetLabel(row),
      sourceIp: row.source_ip ?? '—',
      detail: row.detail ?? '',
      hasDetail: !!row.detail,
    })),
    showPagination,
    ...(showPagination && pagination ? {
      total,
      rangeFrom,
      rangeTo,
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      hasPreviousPage: !!pagination.previousHref,
      previousHref: pagination.previousHref,
      hasNextPage: !!pagination.nextHref,
      nextHref: pagination.nextHref,
    } : {}),
  });

  return adminLayout(views, opts, { title: 'Audit Log', body });
}

interface DataClassRow {
  id: number;
  container_kind: string;
  container_key: string;
  class: string;
  note: string | null;
  created_at: string;
}

export async function auditClassesPage(views: Fetcher, opts: BaseTemplateProps & {
  classes: DataClassRow[];
  flash?: string;
  canManage?: boolean;
}): Promise<string> {
  const { classes, flash, canManage = false } = opts;
  const body = await renderView(views, '/templates/audit-classes.json', {
    flash,
    hasFlash: !!flash,
    canManage,
    hasClasses: classes.length > 0,
    countLabel: `${classes.length} classified container${classes.length === 1 ? '' : 's'}`,
    addAction: '/admin/audit/classes',
    auditHref: '/admin/audit',
    kindOptions: ['page_type', 'taxonomy', 'media_prefix', 'plugin', 'table'].map((value) => ({ value })),
    classOptions: ['pii', 'phi'].map((value) => ({ value })),
    classes: classes.map((row) => ({
      kind: row.container_kind,
      key: row.container_key,
      class: row.class,
      isPhi: row.class === 'phi',
      note: row.note ?? '',
      hasNote: !!row.note,
      createdAt: row.created_at,
      deleteAction: `/admin/audit/classes/${row.id}/delete`,
    })),
  });

  return adminLayout(views, opts, { title: 'Data Classification', body });
}
