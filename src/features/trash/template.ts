import { adminLayout, type BaseTemplateProps } from '../../core/render/layout';
import { renderView } from '../../core/render/liquid';
import type { Page } from '../../types';

interface TrashPagination {
  total: number;
  totalPages: number;
  currentPage: number;
  firstHref: string;
  previousHref: string;
  nextHref: string;
  lastHref: string;
}

interface TypeCount {
  pageType: string;
  count: number;
}

export async function trashPage(views: Fetcher, opts: BaseTemplateProps & {
  pages: Page[];
  flash?: string;
  pagination?: TrashPagination;
  total?: number;
  grandTotal?: number;
  filterType?: string;
  typeCounts?: TypeCount[];
  recentCount?: number;
  canPurgeTrash?: boolean;
  canHold?: boolean;
  /** Uuids of the listed pages under an active hold. */
  held?: Set<string>;
  /** TRASH_RETENTION_DAYS, or null when no retention purge is offered. */
  retentionDays?: number | null;
}): Promise<string> {
  const { pages, flash, pagination, total = pages.length, typeCounts = [], recentCount = 0, filterType = '', canPurgeTrash = false,
    canHold = false, held = new Set<string>(), retentionDays = null } = opts;
  const grandTotal = opts.grandTotal ?? total;
  const showPagination = (pagination?.totalPages ?? 1) > 1;
  const typeSuffix = filterType ? `${filterType} ` : '';
  const body = await renderView(views, '/templates/trash.json', {
    flash,
    hasFlash: !!flash,
    pageCountLabel: `${total} ${typeSuffix}page${total === 1 ? '' : 's'} in trash`,
    singularCount: total === 1,
    hasPages: total > 0,
    anyTrash: grandTotal > 0,
    emptyTrashAction: '/admin/trash/empty',
    restoreAllAction: '/admin/trash/restore',
    typeCounts,
    hasTypeFilter: typeCounts.length > 0,
    filterType,
    // Hide the per-row type badge when a type filter is active — every row
    // shares that type, so it would just be redundant (mirrors the page list).
    showTypeBadge: !filterType,
    grandTotal,
    recentCount,
    hasRecent: recentCount > 0,
    total,
    canPurgeTrash,
    canHold,
    hasRetention: retentionDays !== null,
    retentionDays,
    holdAction: '/admin/holds',
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      slug: page.slug,
      pageType: page.page_type ?? '-',
      hasPageType: !!page.page_type,
      pageTypeHref: page.page_type ? `/admin/trash?type=${encodeURIComponent(page.page_type)}` : '',
      updatedAt: page.updated_at,
      restoreAction: `/admin/trash/${page.id}/restore`,
      deleteAction: `/admin/trash/${page.id}/delete`,
      uuid: page.uuid,
      held: held.has(page.uuid),
    })),
    showPagination,
    ...(showPagination && pagination ? {
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      hasFirstPage: !!pagination.firstHref,
      firstHref: pagination.firstHref,
      hasPreviousPage: !!pagination.previousHref,
      previousHref: pagination.previousHref,
      hasNextPage: !!pagination.nextHref,
      nextHref: pagination.nextHref,
      hasLastPage: !!pagination.lastHref,
      lastHref: pagination.lastHref,
    } : {}),
  });

  return adminLayout(views, opts, { title: 'Trash', body });
}

export interface HoldRow {
  id: number;
  page_uuid: string;
  reason: string;
  placed_by: number;
  placed_at: string;
  released_by: number | null;
  released_at: string | null;
}

export async function holdsPage(views: Fetcher, opts: BaseTemplateProps & { holds: HoldRow[]; flash?: string }): Promise<string> {
  const body = await renderView(views, '/templates/holds.json', {
    flash: opts.flash,
    hasFlash: !!opts.flash,
    placeAction: '/admin/holds',
    hasHolds: opts.holds.length > 0,
    holds: opts.holds.map((hold) => ({
      uuid: hold.page_uuid,
      reason: hold.reason,
      placedBy: hold.placed_by,
      placedAt: hold.placed_at,
      active: hold.released_at === null,
      releasedBy: hold.released_by,
      releasedAt: hold.released_at,
      releaseAction: `/admin/holds/${hold.id}/release`,
    })),
  });
  return adminLayout(views, opts, { title: 'Holds', body });
}
