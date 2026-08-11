import { adminLayout, type BaseTemplateProps } from '../../core/render/layout';
import { renderView } from '../../core/render/liquid';
import type { DashboardPage } from '../../core/templates/dashboard';

interface AdvancedSearchTagOption {
  id: number;
  idString: string;
  name: string;
  selected: boolean;
}

interface AdvancedSearchTagGroup {
  name: string;
  tags: Array<AdvancedSearchTagOption | Omit<AdvancedSearchTagOption, 'selected'>>;
}

interface AdvancedSearchCriterionView {
  index: number;
  term: string;
  path: string;
  tagGroups: AdvancedSearchTagGroup[];
}

export async function advancedSearchPage(views: Fetcher, opts: BaseTemplateProps & {
  pageTitle: string;
  pageType: string;
  canSelectPageType: boolean;
  pageTypes: Array<{ value: string; label: string; selected: boolean }>;
  routeBase: string;
  criteria: AdvancedSearchCriterionView[];
  tagGroups: AdvancedSearchTagGroup[];
  pathOptions: string[];
  pathOptionsByPageTypeJson: string;
  nextCriterionIndex: number;
  operator: 'AND' | 'OR' | 'NOT';
  pageSize: number;
  sort: string;
  order: 'ASC' | 'DESC';
  hasSearch: boolean;
  count: number;
  currentPage: number;
  totalPages: number;
  previousHref: string;
  nextHref: string;
  resetHref: string;
  /** Import-export plugin deep link; empty (button hidden) when the plugin is absent. */
  exportHref: string;
  hasExportHref: boolean;
  bulkAction: string;
  currentHref: string;
  queryWithoutPage: string;
  pages: DashboardPage[];
}): Promise<string> {
  const pageActionReturnQuery = `?return_to=${encodeURIComponent(opts.currentHref)}`;
  const body = await renderView(views, '/templates/advanced-search.json', {
    ...opts,
    hasResults: opts.pages.length > 0,
    resultCountLabel: `${opts.count} result${opts.count === 1 ? '' : 's'}`,
    hasPreviousPage: !!opts.previousHref,
    hasNextPage: !!opts.nextHref,
    showPagination: opts.totalPages > 1,
    searchAction: opts.routeBase,
    listHref: opts.pageType === 'all' ? '/admin' : `/admin/pages/list/${encodeURIComponent(opts.pageType)}`,
    sortHref: `${opts.routeBase}?${opts.queryWithoutPage}`,
    pages: opts.pages.map((page) => ({
      id: page.id,
      name: page.name,
      slug: page.slug,
      pageType: page.page_type ?? '-',
      pageTypeHref: page.page_type ? `/admin/pages/list/${encodeURIComponent(page.page_type)}` : '',
      weight: page.weight,
      liveWeight: page.liveWeight,
      hasLiveWeightDrift: !!page.hasLiveWeightDrift,
      hasLiveLectDrift: !!page.hasLiveLectDrift,
      isPublished: page.isPublished,
      editHref: `/admin/pages/${page.id}/edit`,
      publishAction: `/admin/pages/${page.id}/publish${pageActionReturnQuery}`,
      unpublishAction: `/admin/pages/${page.id}/unpublish`,
      deleteAction: `/admin/pages/${page.id}/delete`,
    })),
  });

  return adminLayout(views, opts, { title: opts.pageTitle, body });
}

interface BulkReplacePreviewChange {
  pageName: string;
  pageEditHref: string;
  fieldPath: string;
  currentValue: string;
  futureValue: string;
}

export async function bulkReplacePreviewPage(views: Fetcher, opts: BaseTemplateProps & {
  pageTitle: string;
  returnTo: string;
  confirmAction: string;
  scope: 'selected' | 'all';
  selectedPageIds: number[];
  searchText: string;
  replacementText: string;
  targetPageCount: number;
  previewPageCount: number;
  affectedPageCount: number;
  displayedChangeCount: number;
  previewTruncated: boolean;
  hasChanges: boolean;
  canConfirm: boolean;
  changes: BulkReplacePreviewChange[];
}): Promise<string> {
  const body = await renderView(views, '/templates/bulk-replace-preview.json', { ...opts });
  return adminLayout(views, opts, { title: opts.pageTitle, body });
}
