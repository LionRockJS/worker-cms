import { adminLayout, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';
import type { Page } from '../../types';
import type { UiTranslator } from '../i18n';

export interface DashboardPage extends Page {
  isPublished: boolean;
  publicationStatus?: 'draft' | 'scheduled' | 'live' | 'ended';
  isDraftMissing?: boolean;
  contentPreview?: string;
  liveWeight?: number;
  hasLiveWeightDrift?: boolean;
  hasLiveLectDrift?: boolean;
  tagNames?: string[];
}

interface DashboardPagination {
  total: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  firstHref: string;
  previousHref: string;
  nextHref: string;
  lastHref: string;
}

interface DashboardStatusFilterLink {
  label: string;
  translationKey?: string;
  href: string;
  isActive: boolean;
}

interface DashboardBulkTagGroup {
  name: string;
  slug: string;
  isOther: boolean;
  tags: Array<{ id: number; name: string }>;
}

export async function dashboardPage(views: Fetcher, opts: BaseTemplateProps & {
  pages: DashboardPage[];
  flash?: string;
  returnPath?: string;
  pageTypeFilter?: string;
  statusFilter?: '' | 'draft' | 'scheduled' | 'live' | 'ended';
  statusFilters?: DashboardStatusFilterLink[];
  privacyTable?: boolean;
  searchValue?: string;
  searchAction?: string;
  advancedSearchHref?: string;
  importHref?: string;
  exportHref?: string;
  bulkAction?: string;
  bulkTagGroups?: DashboardBulkTagGroup[];
  /** All page-type slugs, used to build the filter dropdown. */
  pageTypeChoices?: string[];
  pagination?: DashboardPagination;
  /** Drag-and-drop reorder, enabled only for a single page type with no status
   *  filter — see POST /admin/pages/reorder for why the other lists are out. */
  reorder?: boolean;
  /** Server-side UI translation for the page-list header and count summary. */
  t?: UiTranslator;
}): Promise<string> {
  const {
    pages,
    flash,
    returnPath = '/admin',
    pageTypeFilter,
    statusFilter = '',
    statusFilters = [],
    searchValue = '',
    searchAction = '/admin',
    advancedSearchHref = pageTypeFilter ? `/admin/advanced-search/${encodeURIComponent(pageTypeFilter)}` : '/admin/advanced-search',
    // Import/export live in the import-export plugin; empty hrefs hide the buttons.
    importHref = '',
    exportHref = '',
    bulkAction: requestedBulkAction,
    bulkTagGroups = [],
    pageTypeChoices = [],
    pagination,
  } = opts;
  // The reorder POST replays the same window the list rendered, so it has to be
  // told the effective (clamped) page and size, not what the query string asked.
  const canReorder = !!opts.reorder && !!pageTypeFilter && !statusFilter && pages.length > 1;
  const translate = opts.t ?? ((_key: string, fallback: string) => fallback);
  const pageCount = pagination?.total ?? pages.length;
  const paginationStart = pagination && pageCount > 0
    ? ((pagination.currentPage - 1) * pagination.pageSize) + 1
    : pages.length ? 1 : 0;
  const paginationEnd = pagination
    ? Math.min(pageCount, paginationStart + pages.length - 1)
    : pages.length;
  const showPageTypeColumn = !pageTypeFilter;
  const bulkRoute = pageTypeFilter
    ? `/admin/advanced-search/${encodeURIComponent(pageTypeFilter)}/bulk`
    : '/admin/advanced-search/bulk';
  const bulkParams = new URLSearchParams({ dashboard: '1' });
  if (statusFilter) bulkParams.set('status', statusFilter);
  const bulkAction = requestedBulkAction ?? `${bulkRoute}?${bulkParams.toString()}`;
  const pageActionReturnQuery = `?return_to=${encodeURIComponent(returnPath)}`;
  const pageTypeOptions = pageTypeChoices.map((slug) => ({
    slug,
    href: `/admin/pages/list/${encodeURIComponent(slug)}`,
    isSelected: slug === pageTypeFilter,
  }));
  const countSubjectKey = statusFilter === 'live'
    ? pageCount === 1 ? 'pages.count.live_page' : 'pages.count.live_pages'
    : statusFilter === 'scheduled'
      ? pageCount === 1 ? 'pages.count.scheduled_page' : 'pages.count.scheduled_pages'
      : statusFilter === 'ended'
        ? pageCount === 1 ? 'pages.count.ended_page' : 'pages.count.ended_pages'
        : statusFilter === 'draft'
          ? pageCount === 1 ? 'pages.count.draft_page' : 'pages.count.draft_pages'
          : pageCount === 1 ? 'pages.count.page' : 'pages.count.pages';
  const countSubjectFallback = statusFilter === 'live'
    ? pageCount === 1 ? 'live page' : 'live pages'
    : statusFilter === 'scheduled'
      ? pageCount === 1 ? 'scheduled page' : 'scheduled pages'
      : statusFilter === 'ended'
        ? pageCount === 1 ? 'ended page' : 'ended pages'
        : statusFilter === 'draft'
          ? pageCount === 1 ? 'draft page' : 'draft pages'
          : pageCount === 1 ? 'page' : 'pages';
  const countSubject = translate(countSubjectKey, countSubjectFallback);
  const countDraftSuffix = statusFilter ? '' : ` ${translate('pages.count.in_draft', 'in draft')}`;
  const countShowing = translate('pages.count.showing', 'Showing');
  const countOf = translate('pages.count.of', 'of');
  const pageCountLabel = pagination && pageCount > 0
    ? `${countShowing} ${paginationStart}-${paginationEnd} ${countOf} ${pageCount} ${countSubject}${countDraftSuffix}`
    : `${pageCount} ${countSubject}${countDraftSuffix}`;
  const pagesLabel = translate('nav.pages', 'Pages');
  const pageTitle = pageTypeFilter ? `${pagesLabel}: ${pageTypeFilter}` : pagesLabel;
  const body = await renderView(views, '/templates/dashboard.json', {
    flash,
    hasFlash: !!flash,
    returnPath,
    pageTypeFilter: pageTypeFilter ?? '',
    pageTitle,
    showPageTypeColumn,
    hasPageTypeChoices: pageTypeOptions.length > 0,
    allTypesSelected: !pageTypeFilter,
    pageTypeOptions,
    allTypesHref: '/admin/pages/list',
    privacyTable: !!opts.privacyTable,
    emptyColspan: 4,
    searchValue,
    searchAction,
    searchPlaceholder: pageTypeFilter ? `Search ${pageTypeFilter} pages` : 'Search pages',
    statusFilter,
    hasStatusFilters: statusFilters.length > 0,
    statusFilters,
    advancedSearchHref,
    importHref,
    hasImportHref: !!importHref,
    exportHref,
    hasExportHref: !!exportHref,
    pageCount,
    pageCountLabel,
    paginatedCount: !!pagination && pageCount > 0,
    paginationStart,
    paginationEnd,
    singularCount: pageCount === 1,
    hasPages: pages.length > 0,
    hasSelectablePages: pages.some((page) => !page.isDraftMissing),
    bulkAction,
    bulkTagGroups,
    hasBulkTagOptions: bulkTagGroups.some((group) => group.tags.length > 0),
    canReorder,
    reorderAction: canReorder ? '/admin/pages/reorder' : '',
    reorderPageType: pageTypeFilter ?? '',
    reorderPage: pagination?.currentPage ?? 1,
    reorderPageSize: pagination?.pageSize ?? pages.length,
    showPagination: !!pagination && pagination.totalPages > 1,
    currentPage: pagination?.currentPage ?? 1,
    totalPages: pagination?.totalPages ?? 1,
    hasFirstPage: !!pagination?.firstHref,
    hasPreviousPage: !!pagination?.previousHref,
    hasNextPage: !!pagination?.nextHref,
    hasLastPage: !!pagination?.lastHref,
    firstHref: pagination?.firstHref ?? '',
    previousHref: pagination?.previousHref ?? '',
    nextHref: pagination?.nextHref ?? '',
    lastHref: pagination?.lastHref ?? '',
    pages: pages.map((page) => {
      const tagNames = page.tagNames ?? [];
      return {
        id: page.id,
        name: page.name,
        slug: page.slug,
        tags: tagNames.slice(0, 5).map((name) => ({ name })),
        hasTags: tagNames.length > 0,
        hasMoreTags: tagNames.length > 5,
        pageType: page.page_type ?? '-',
        hasPageType: !!page.page_type,
        pageTypeHref: showPageTypeColumn && page.page_type ? `/admin/pages/list/${encodeURIComponent(page.page_type)}` : '',
        weight: page.weight,
        liveWeight: page.liveWeight,
        hasLiveWeight: page.liveWeight !== undefined,
        hasLiveWeightDrift: !!page.hasLiveWeightDrift,
        hasLiveLectDrift: !!page.hasLiveLectDrift,
        isDraftMissing: !!page.isDraftMissing,
        isSelectable: !page.isDraftMissing,
        isPublished: page.isPublished,
        publicationStatus: page.publicationStatus ?? (page.isPublished ? 'live' : 'draft'),
        weightAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/weight`,
        editHref: page.isDraftMissing ? '' : `/admin/pages/${page.id}/edit`,
        readHref: page.isDraftMissing ? '' : `/admin/pages/${page.id}/read`,
        publishAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/publish${pageActionReturnQuery}`,
        unpublishAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/unpublish`,
        deleteAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/delete`,
        pullAction: `/admin/pages/pull/${encodeURIComponent(page.uuid)}`,
      };
    }),
  });

  return adminLayout(views, opts, { title: pageTitle, body });
}
