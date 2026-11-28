import type { FeatureServiceEntry } from '../services';
import type { Env } from '../../types';
import { serviceMutationAuditEvidence } from '../../core/db/audit';
import { classFor, resolveDataClasses } from '../../core/db/data-classes';
import { abortIf } from '../../core/db/transaction-guard';
import { cmsAdminJobMessage } from './queue';

const CLEAR_LIMIT = 500;
const RESEND_LIMIT = 25;
const RESEND_AFTER_MS = 60_000;
type FinishedJob = { id: string; status: 'done' | 'failed'; updated_at: string };

async function clearExpiredPayloads(env: Env, cutoff: string): Promise<number> {
  const eligible = "status IN ('done', 'failed') AND updated_at < ? AND (body IS NOT NULL OR user_json IS NOT NULL)";
  const { results } = await env.DB.prepare(`SELECT id, status, updated_at FROM admin_jobs
    WHERE ${eligible} ORDER BY updated_at, id LIMIT ?`).bind(cutoff, CLEAR_LIMIT).all<FinishedJob>();
  if (!results.length) return 0;
  const jobs = JSON.stringify(results);
  const match = "admin_jobs.id = json_extract(j.value, '$.id') AND admin_jobs.status IS json_extract(j.value, '$.status') AND admin_jobs.updated_at IS json_extract(j.value, '$.updated_at')";
  const policy = await resolveDataClasses(env, true);
  const receipt = serviceMutationAuditEvidence(env, {
    action: 'job.retention-clear', entityType: 'admin_job',
    detail: { cutoff, jobs: results.map(row => row.id), count: results.length, cleared_fields: ['body', 'user_json'] },
  }, { userId: null, roles: null, sessionSid: null, via: 'system:job-retention' },
  classFor(policy, 'table', 'admin_jobs') ?? 'none', policy);
  await env.DB.batch([
    env.DB.prepare(`UPDATE admin_jobs SET body = NULL, user_json = NULL
      WHERE ${eligible} AND EXISTS (SELECT 1 FROM json_each(?) j WHERE ${match})`).bind(cutoff, jobs),
    abortIf(env, 'changes() <> ?', [results.length]),
    receipt.write, receipt.guard,
    abortIf(env, `EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (
      SELECT 1 FROM admin_jobs WHERE ${match} AND body IS NULL AND user_json IS NULL))`, [jobs]),
  ]);
  return results.length;
}

async function resendQueuedSlices(env: Env): Promise<number> {
  const queue = env.ADMIN_JOBS_QUEUE;
  if (!queue) return 0;
  // Only previously claimed jobs are eligible. Initial submissions may have
  // been resubmitted after their response was lost and need a separate contract.
  const cutoff = new Date(Date.now() - RESEND_AFTER_MS).toISOString();
  const { results } = await env.DB.prepare(`SELECT id FROM admin_jobs WHERE status = 'queued' AND attempts > 0
    AND updated_at < ? ORDER BY updated_at, id LIMIT ?`).bind(cutoff, RESEND_LIMIT).all<{ id: string }>();
  let resent = 0;
  for (const { id } of results) {
    try { await queue.send(cmsAdminJobMessage(id)); resent++; }
    catch { console.error('Job continuation signal unavailable', { jobId: id }); }
  }
  return resent;
}

export const jobsServices: FeatureServiceEntry = {
  id: 'jobs',

  async scheduled(env: Env): Promise<string | null> {
    const resent = await resendQueuedSlices(env);
    const days = Number(env.JOB_RETENTION_DAYS);
    const cleared = Number.isSafeInteger(days) && days > 0
      ? await clearExpiredPayloads(env, new Date(Date.now() - days * 86_400_000).toISOString())
      : 0;
    if (!cleared && !resent) return null;
    return [cleared ? `job retention: cleared ${cleared}` : '', resent ? `job continuations: signaled ${resent}` : ''].filter(Boolean).join(', ');
  },
};
