import type { Env, Page, PageVersion } from '../types';
import type { AuditActor } from '../core/db/audit';
import type { AppContext } from '../core/http/context';
import type { LivePageSnapshot, PagePublicationStatus } from '../contracts/publish';

export interface EditorPublicationState {
  isPublished: boolean;
  publicationStatus: PagePublicationStatus;
  liveVersionId?: number;
  isLiveSynced: boolean;
}

export interface DraftPublicationRow extends Page {
  isPublished: boolean;
  publicationStatus?: PagePublicationStatus;
  liveWeight?: number;
  hasLiveWeightDrift?: boolean;
  hasLiveLectDrift?: boolean;
}

export type PublishRefusal = 'submission' | 'regulated' | 'classification_unavailable' | 'writes_unavailable';

export interface PublishOutcome {
  /** Targets that were attempted, in order. */
  targets: string[];
  /** Target ids whose publish/unpublish threw. */
  failures: string[];
  /** Containment proceeded with incomplete audit evidence for these targets. */
  auditFailures?: string[];
  /**
   * Set when the page never reached an adapter. Either it is a submission
   * mirror — publishing one would upsert the original live row it shares a uuid
   * with, and unpublishing/trashing one would DELETE that live row — or it holds
   * regulated data, which is never published, or deployment write containment
   * prevents any publication.
   */
  refused?: boolean;
  /** Which refusal it was, for the message the admin sees. */
  refusedReason?: PublishRefusal;
}

export interface BulkPublishOutcome {
  targets: string[];
  failures: string[];
  /** Pages handed to the targets, in input order. */
  published: Page[];
  /** Pages skipped before an adapter: all input under deployment containment;
   * otherwise submission mirrors first, then regulated pages. */
  refused: Page[];
  /** The regulated subset of `refused`. A policy refusal, not a structural one,
   *  so a caller that reports per-page outcomes can say which it was. */
  refusedRegulated: Page[];
  /** Whole-deployment containment; separate from record-level PHI refusals. */
  refusedReason?: 'writes_unavailable';
}

export interface BulkUnpublishOutcome {
  targets: string[];
  failures: string[];
  auditFailures?: string[];
  refusedCount: number;
}

export type DashboardPageRow = Page & { isDraftMissing?: boolean; tagNames?: string[] };

export interface DashboardPublicationQuery {
  pageType?: string;
  requestedPage: number;
  pageSize: number;
  statusFilter: PagePublicationStatus;
  now: Date;
}

export interface PublicationService {
  publishPageToTargets(env: Env, pageId: number, actor?: AuditActor): Promise<PublishOutcome | null>;
  publishPagesToTargets(env: Env, pages: Page[], actor?: AuditActor): Promise<BulkPublishOutcome>;
  unpublishPageFromTargets(env: Env, uuid: string, isSubmission?: boolean, actor?: AuditActor): Promise<PublishOutcome>;
  unpublishPagesFromTargets(env: Env, pages: Array<{ uuid: string; submission_origin?: number | boolean }>, actor?: AuditActor): Promise<BulkUnpublishOutcome>;
  publishTagToTargets(env: Env, tagId: number, actor?: AuditActor): Promise<PublishOutcome>;
  publishTagsToTargets(env: Env, tagIds?: number[], actor?: AuditActor): Promise<PublishOutcome & { count: number; refusedCount?: number }>;
  removeTagFromTargets(env: Env, tagId: number, actor?: AuditActor): Promise<PublishOutcome>;
  isD1Live(env: Env, uuid: string): Promise<boolean>;
  annotateDraftPages(env: Env, pages: Page[], now?: Date): Promise<DraftPublicationRow[]>;
  editorPublicationState(env: Env, page: Page, versions: PromiseLike<{ results: PageVersion[] }>): Promise<EditorPublicationState>;
  filterDraftIdsByStatus(env: Env, pages: Page[], pageTypes: string[], status: PagePublicationStatus, actor?: AuditActor): Promise<number[]>;
  liveMapForDraftPages(env: Env, pages: Page[], actor?: AuditActor): Promise<Map<string, LivePageSnapshot>>;
  filteredDashboardPages(c: AppContext, options: DashboardPublicationQuery): Promise<{
    results: Array<DashboardPageRow & DraftPublicationRow>;
    pagination: { total: number; currentPage: number; totalPages: number; limit: number };
  }>;
  dashboardPublishedTags(c: AppContext, pageIds: number[]): Promise<Array<{ pageId: number; name: string }>>;
  submissionMirrorIds(db: D1DatabaseClient, pageIds: number[]): Promise<Set<number>>;
  ingestSubmissions(env: Env, actor?: AuditActor): Promise<{ scanned: number; created: number; more: boolean }>;
  eraseSubmissionSources(env: Env): Promise<number>;
  publishFlash(outcome: PublishOutcome): string;
}
