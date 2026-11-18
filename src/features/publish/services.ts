import type { FeatureServiceEntry } from '../services';
import {
  getLiveLect,
  listLiveByTypes,
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
import { dashboardPublishedTags, filteredDashboardPages } from './dashboard';
import { draftLectProjector } from './projection';
import { ingestSubmissions } from './submission-ingest';
import { eraseSubmissionSources } from './submission-erasure';
import { submissionMirrorIds } from './submission-mirrors';

export const publishServices: FeatureServiceEntry = {
  id: 'publish',
  publication: {
    getLiveLect,
    listLiveByTypes,
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
    filteredDashboardPages,
    draftLectProjector,
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
