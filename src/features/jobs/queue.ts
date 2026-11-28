// The admin_jobs table: creating, claiming and completing a durable job.
//
// The queue message shape is core's (src/core/extensions.ts) because the
// Worker's `queue()` handler and the ADMIN_JOBS_QUEUE binding type belong to
// the entrypoint; everything about what a job *is* belongs here.

import type { Env, JWTPayload } from '../../types';
import { captureAccessAuthorization, captureSelfAuthorization } from '../../core/auth/access-authorization';
import { contextActor, serviceMutationAuditEvidence } from '../../core/db/audit';
import { classFor, resolveDataClasses } from '../../core/db/data-classes';
import { abortIf } from '../../core/db/transaction-guard';
import type { AppContext } from '../../core/http/context';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
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
  userJson: string | null;
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

// Include the saved request in the private compare-and-swap, but never in the receipt.
const jobFields = ['id', 'type', 'status', 'plugin_id', 'method', 'path', 'content_type', 'body', 'user_json',
  'attempts', 'result_status', 'result_location', 'error', 'created_at', 'updated_at', 'started_at', 'completed_at'] as const;
const exactJob = jobFields.map(field => `${field} IS ?`).join(' AND ');
const jobValues = (row: AdminJobRow) => jobFields.map(field => row[field]);

function jobStateGuard(env: Env, row: AdminJobRow) {
  return abortIf(env, `NOT EXISTS (SELECT 1 FROM admin_jobs WHERE ${exactJob})`, jobValues(row));
}

export async function createPluginAdminActionJob(env: Env, input: PluginAdminActionInput, context?: AppContext): Promise<AdminJobRecord> {
  return enqueue(env, input.user, {
    type: 'plugin_admin_action', plugin_id: input.pluginId, method: input.method, path: input.path,
    content_type: input.contentType, body: input.body,
  }, context);
}

export async function createAdvancedSearchBulkActionJob(env: Env, input: AdvancedSearchBulkActionInput, context?: AppContext): Promise<AdminJobRecord> {
  const { user, ...payload } = input;
  const capability = input.action === 'publish' || input.action === 'unpublish' ? 'content:publish'
    : input.action === 'delete' ? 'content:delete' : 'content:write';
  return enqueue(env, user, {
    type: 'advanced_search_bulk_action', plugin_id: null, method: null, path: null, content_type: null,
    body: JSON.stringify(payload),
  }, context, capability);
}

async function enqueue(env: Env, user: JWTPayload,
  payload: Pick<AdminJobRow, 'type' | 'plugin_id' | 'method' | 'path' | 'content_type' | 'body'>,
  context?: AppContext, capability?: 'content:publish' | 'content:delete' | 'content:write'): Promise<AdminJobRecord> {
  assertRegulatedWritesAllowed(env);
  const principal = context?.get('user') ?? user;
  const authority = context && (capability
    ? await captureAccessAuthorization(env, principal, capability)
    : await captureSelfAuthorization(env, principal));
  if (authority && !authority.allowed) throw new Error('Job enqueue authority unavailable');
  const now = jobTimestamp();
  const row: AdminJobRow = {
    ...payload, id: crypto.randomUUID(), status: 'queued', user_json: JSON.stringify(principal), attempts: 0,
    result_status: null, result_location: null, error: null, created_at: now, updated_at: now,
    started_at: null, completed_at: null,
  };
  const policy = await resolveDataClasses(env, true);
  const actor = context ? contextActor(context) : { userId: user.sub, roles: user.role, sessionSid: user.sid ?? null, via: null };
  const receipt = serviceMutationAuditEvidence(env, {
    action: 'job.enqueue', entityType: 'admin_job', entityId: row.id, detail: { job_type: row.type, status: row.status },
  }, actor, classFor(policy, 'table', 'admin_jobs') ?? 'none', policy, context);
  await env.DB.batch([
    ...(authority ? [authority.guard()] : []),
    env.DB.prepare(`INSERT INTO admin_jobs (${jobFields.join(', ')}) VALUES (${jobFields.map(() => '?').join(', ')})`).bind(...jobValues(row)),
    abortIf(env, 'changes() <> 1'), receipt.write, receipt.guard, jobStateGuard(env, row),
    ...(authority ? [authority.guard()] : []),
  ]);
  return rowToRecord(row);
}

export async function claimAdminJob(env: Env, id: string): Promise<AdminJobRecord | null> {
  assertRegulatedWritesAllowed(env);
  const { DB: db } = env;
  const select = () => db.prepare('SELECT * FROM admin_jobs WHERE id = ?').bind(id).first<AdminJobRow>();
  const before = await select();
  if (before?.status !== 'queued') return null;
  if (!Number.isSafeInteger(before.attempts + 1) || before.attempts < 0) throw new Error('Invalid job attempt');

  const now = jobTimestamp();
  const claimId = crypto.randomUUID();
  const row: AdminJobRow = {
    ...before, status: 'running', attempts: before.attempts + 1, error: null,
    started_at: before.started_at ?? now, updated_at: now,
  };
  const policy = await resolveDataClasses(env, true);
  const receipt = serviceMutationAuditEvidence(env, {
    action: 'job.claim', entityType: 'admin_job', entityId: id,
    detail: { job_type: row.type, job_attempt: row.attempts, claim_id: claimId, status: row.status },
  }, { userId: null, roles: null, sessionSid: null, via: 'system:admin-job-runner' },
  classFor(policy, 'table', 'admin_jobs') ?? 'none', policy);
  try {
    await db.batch([
      db.prepare(`UPDATE admin_jobs SET status = 'running', attempts = ?, error = NULL, started_at = ?, updated_at = ?
        WHERE ${exactJob}`).bind(row.attempts, row.started_at, now, ...jobValues(before)),
      abortIf(env, 'changes() <> 1'), receipt.write, receipt.guard, jobStateGuard(env, row),
    ]);
  } catch (error) {
    // A duplicate consumer may have won while this worker was preparing the
    // claim. Only the worker whose receipt committed can recover a lost acknowledgement.
    const current = await select();
    if (current?.status === 'running' && jobFields.every(field => current[field] === row[field])) {
      const acknowledged = await db.prepare(`SELECT 1 FROM audit_events WHERE action = 'job.claim'
        AND target_type = 'admin_job' AND target_id = ? AND json_extract(detail, '$.claim_id') = ?`).bind(id, claimId).first();
      if (acknowledged) return rowToRecord(current);
    }
    if (current?.status !== 'queued' || current.attempts > before.attempts) return null;
    throw error;
  }
  return rowToRecord(row);
}

/** A stale worker must not overwrite a newer claim or changed payload. */
export const claimedJobSql = " AND status='running' AND attempts=? AND body IS ? AND updated_at IS ? AND user_json IS ?";
export const claimedJobBindings = (claim: AdminJobRecord) => [claim.attempts, claim.body, claim.updatedAt, claim.userJson];

export async function completeAdminJob(
  db: D1DatabaseClient,
  id: string,
  resultStatus: number,
  resultLocation: string | null,
  claim?: AdminJobRecord,
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
     WHERE id = ?${claim ? claimedJobSql : ''}`,
  ).bind(resultStatus, resultLocation, now, now, id,...(claim ? claimedJobBindings(claim):[])).run();
}

export async function requeueAdminJob(
  db: D1DatabaseClient,
  id: string,
  body: string,
  claim?: AdminJobRecord,
): Promise<boolean> {
  const now = jobTimestamp();
  const result = await db.prepare(
    `UPDATE admin_jobs
     SET status = 'queued',
         body = ?,
         error = NULL,
         updated_at = ?
     WHERE id = ?${claim ? claimedJobSql : ''}`,
  ).bind(body, now, id,...(claim ? claimedJobBindings(claim):[])).run();
  return changes(result)===1;
}

export async function failAdminJob(db: D1DatabaseClient, id: string, error: unknown, claim?: AdminJobRecord): Promise<void> {
  const now = jobTimestamp();
  await db.prepare(
    `UPDATE admin_jobs
     SET status = 'failed',
         error = ?,
         updated_at = ?
     WHERE id = ?${claim ? claimedJobSql : ''}`,
  ).bind(errorText(error), now, id,...(claim ? claimedJobBindings(claim):[])).run();
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
    userJson: row.user_json,
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
