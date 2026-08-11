// The admin_jobs table: creating, claiming and completing a durable job.
//
// The queue message shape is core's (src/core/extensions.ts) because the
// Worker's `queue()` handler and the ADMIN_JOBS_QUEUE binding type belong to
// the entrypoint; everything about what a job *is* belongs here.

import type { JWTPayload } from '../../types';
import type { AdvancedSearchCriterion, AdvancedSearchOperator } from '../../core/db/search';
import type { BulkPageAction } from '../../core/pages/bulk-action';
import type { CmsAdminJobMessage } from '../../core/extensions';

export const CMS_ADMIN_JOB_KIND = 'cms_admin_job' as const;

export type AdminJobType = 'plugin_admin_action' | 'advanced_search_bulk_action';
export type AdminJobStatus = 'queued' | 'running' | 'done' | 'failed';
export type AdvancedSearchBulkScope = 'selected' | 'all';

export interface PluginAdminActionInput {
  pluginId: string;
  method: string;
  path: string;
  contentType: string | null;
  body: string;
  user: JWTPayload;
}

export interface AdvancedSearchBulkActionInput {
  action: BulkPageAction;
  scope: AdvancedSearchBulkScope;
  ids: number[];
  pageTypes: string[];
  criteria: AdvancedSearchCriterion[];
  operator: AdvancedSearchOperator;
  status?: 'draft' | 'scheduled' | 'live' | 'ended';
  targetTagIds: number[];
  searchText: string;
  replacementText: string;
  returnTo: string;
  user: JWTPayload;
}

export interface AdvancedSearchBulkActionPayload extends Omit<AdvancedSearchBulkActionInput, 'user'> {
  resolvedAll?: boolean;
  cursor?: number;
  updated?: number;
  refused?: number;
  failedTargets?: string[];
}

interface AdminJobRow {
  id: string;
  type: AdminJobType;
  status: AdminJobStatus;
  plugin_id: string | null;
  method: string | null;
  path: string | null;
  content_type: string | null;
  body: string | null;
  user_json: string | null;
  attempts: number;
  result_status: number | null;
  result_location: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AdminJobRecord {
  id: string;
  type: AdminJobType;
  status: AdminJobStatus;
  pluginId: string | null;
  method: string | null;
  path: string | null;
  contentType: string | null;
  body: string | null;
  user: JWTPayload | null;
  attempts: number;
  resultStatus: number | null;
  resultLocation: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function cmsAdminJobMessage(jobId: string): CmsAdminJobMessage {
  return { kind: CMS_ADMIN_JOB_KIND, jobId };
}

export function isCmsAdminJobMessage(body: unknown): body is CmsAdminJobMessage {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as { kind?: unknown; jobId?: unknown };
  return candidate.kind === CMS_ADMIN_JOB_KIND && typeof candidate.jobId === 'string' && candidate.jobId.length > 0;
}

export async function createPluginAdminActionJob(db: D1DatabaseClient, input: PluginAdminActionInput): Promise<AdminJobRecord> {
  const now = jobTimestamp();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO admin_jobs (
      id, type, status, plugin_id, method, path, content_type, body, user_json,
      attempts, created_at, updated_at
    ) VALUES (?, 'plugin_admin_action', 'queued', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).bind(
    id,
    input.pluginId,
    input.method,
    input.path,
    input.contentType,
    input.body,
    JSON.stringify(input.user),
    now,
    now,
  ).run();
  const job = await getAdminJob(db, id);
  if (!job) throw new Error(`Unable to read admin job ${id}`);
  return job;
}

export async function createAdvancedSearchBulkActionJob(
  db: D1DatabaseClient,
  input: AdvancedSearchBulkActionInput,
): Promise<AdminJobRecord> {
  const now = jobTimestamp();
  const id = crypto.randomUUID();
  const { user, ...payload } = input;
  await db.prepare(
    `INSERT INTO admin_jobs (
      id, type, status, body, user_json, attempts, created_at, updated_at
    ) VALUES (?, 'advanced_search_bulk_action', 'queued', ?, ?, 0, ?, ?)`,
  ).bind(
    id,
    JSON.stringify(payload),
    JSON.stringify(user),
    now,
    now,
  ).run();
  const job = await getAdminJob(db, id);
  if (!job) throw new Error(`Unable to read admin job ${id}`);
  return job;
}

export async function claimAdminJob(db: D1DatabaseClient, id: string): Promise<AdminJobRecord | null> {
  const now = jobTimestamp();
  const result = await db.prepare(
    `UPDATE admin_jobs
     SET status = 'running',
         attempts = attempts + 1,
         error = NULL,
         started_at = COALESCE(started_at, ?),
         updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  ).bind(now, now, id).run();
  if (changes(result) !== 1) return null;
  return getAdminJob(db, id);
}

export async function completeAdminJob(
  db: D1DatabaseClient,
  id: string,
  resultStatus: number,
  resultLocation: string | null,
): Promise<void> {
  const now = jobTimestamp();
  await db.prepare(
    `UPDATE admin_jobs
     SET status = 'done',
         result_status = ?,
         result_location = ?,
         error = NULL,
         completed_at = ?,
         updated_at = ?
     WHERE id = ?`,
  ).bind(resultStatus, resultLocation, now, now, id).run();
}

export async function requeueAdminJob(
  db: D1DatabaseClient,
  id: string,
  body: string,
): Promise<void> {
  const now = jobTimestamp();
  await db.prepare(
    `UPDATE admin_jobs
     SET status = 'queued',
         body = ?,
         error = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).bind(body, now, id).run();
}

export async function failAdminJob(db: D1DatabaseClient, id: string, error: unknown): Promise<void> {
  const now = jobTimestamp();
  await db.prepare(
    `UPDATE admin_jobs
     SET status = 'failed',
         error = ?,
         updated_at = ?
     WHERE id = ?`,
  ).bind(errorText(error), now, id).run();
}

export async function getAdminJob(db: D1DatabaseClient, id: string): Promise<AdminJobRecord | null> {
  const row = await db.prepare('SELECT * FROM admin_jobs WHERE id = ?').bind(id).first<AdminJobRow>();
  return row ? rowToRecord(row) : null;
}

function rowToRecord(row: AdminJobRow): AdminJobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    pluginId: row.plugin_id,
    method: row.method,
    path: row.path,
    contentType: row.content_type,
    body: row.body,
    user: parseUser(row.user_json),
    attempts: row.attempts,
    resultStatus: row.result_status,
    resultLocation: row.result_location,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseUser(value: string | null): JWTPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as JWTPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function changes(result: D1Result<unknown>): number {
  return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
}

function jobTimestamp(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
