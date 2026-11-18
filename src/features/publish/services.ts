import type { FeatureServiceEntry } from '../services';
import {
  liveMapForDraftPages,
  publishFlash,
  publishPageToTargets,
  publishPagesToTargets,
  publishTagToTargets,
  publishTagsToTargets,
  removeTagFromTargets,
  unpublishPageFromTargets,
  unpublishPagesFromTargets,
} from './index';
import { dashboardPublishedTags, dashboardStatusFilterLinks, filteredDashboardPages } from './dashboard';
import { annotateDraftPages, editorPublicationState, filterDraftIdsByStatus } from './status';
import { renderLiveVersionBadge } from './version-badge';
import { ingestSubmissions } from './submission-ingest';
import { eraseSubmissionSources } from './submission-erasure';
import { submissionMirrorIds } from './submission-mirrors';

export const publishServices: FeatureServiceEntry = {
  id: 'publish',
  publication: {
    liveMapForDraftPages,
    publishFlash,
    publishPageToTargets,
    publishPagesToTargets,
    publishTagToTargets,
    publishTagsToTargets,
    removeTagFromTargets,
    unpublishPageFromTargets,
    unpublishPagesFromTargets,
    dashboardPublishedTags,
    dashboardStatusFilterLinks,
    renderLiveVersionBadge,
    filteredDashboardPages,
    annotateDraftPages,
    editorPublicationState,
    filterDraftIdsByStatus,
    ingestSubmissions,
    eraseSubmissionSources,
    submissionMirrorIds,
    async isD1Live(env, uuid) {
      return !!await env.PUBLISHED_DB?.prepare('SELECT 1 FROM pages WHERE uuid = ?').bind(uuid).first();
    },
  },
  async scheduled(env) {
    const result = await ingestSubmissions(env);
    if (result.scanned) console.log('submission ingest:', JSON.stringify(result));
    const erased = await eraseSubmissionSources(env);
    if (erased) console.log('submission erasure:', erased);
    return null;
  },
};
