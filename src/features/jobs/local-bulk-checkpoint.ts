import type { Env, JWTPayload } from '../../types';
import { serviceMutationAuditEvidence } from '../../core/db/audit';
import { classFor, resolveDataClasses, strongestClass, type DataClass } from '../../core/db/data-classes';
import { abortIf } from '../../core/db/transaction-guard';
import { appendQuery } from '../../core/http/forms';
import { signedNotice } from '../../core/http/notice';
import { bulkActionFlash } from '../../core/pages/bulk-action';
import { claimedJobBindings, claimedJobSql, type AdminJobRecord, type AdvancedSearchBulkActionPayload } from './queue';

export async function prepareLocalBulkCheckpoint(env: Env, job: AdminJobRecord, user: JWTPayload,
  input: AdvancedSearchBulkActionPayload, from: number, to: number, changed: number, dataClass: DataClass | 'none') {
  const policy = await resolveDataClasses(env, true);
  const queued = to < input.ids.length;
  const updated = (input.updated ?? 0) + changed;
  const body = JSON.stringify({ ...input, cursor: to, updated });
  const location = queued ? null : appendQuery(input.returnTo, await signedNotice(env.JWT_SECRET, user.sub,
    bulkActionFlash(input.action, updated, input.refused, input.failedTargets)));
  const now = new Date().toISOString();
  const status = queued ? 'queued' : 'done';
  const resultStatus = queued ? null : 200;
  const completedAt = queued ? null : now;
  const exactState = `FROM admin_jobs WHERE id = ? AND type = 'advanced_search_bulk_action'
    AND status = ? AND attempts = ? AND body IS ? AND updated_at IS ?
    AND result_status IS ? AND result_location IS ? AND completed_at IS ? AND error IS NULL
    AND user_json = ?`;
  const expected = [job.id, status, job.attempts, body, now, resultStatus, location, completedAt, job.userJson];
  const receipt = serviceMutationAuditEvidence(env, {
    action: 'job.bulk-slice', entityType: 'admin_job', entityId: job.id,
    detail: { job_attempt: job.attempts, action: input.action, cursor_before: from, cursor_after: to, changed, status },
  }, { userId: user.sub, roles: user.role, sessionSid: user.sid ?? null, via: `job:${job.id}` },
  strongestClass([dataClass, classFor(policy, 'table', 'admin_jobs')]), policy);
  const statements = [
    env.DB.prepare(`UPDATE admin_jobs SET status = ?, body = ?, updated_at = ?, result_status = ?,
      result_location = ?, completed_at = ?, error = NULL WHERE id = ? AND type = 'advanced_search_bulk_action'${claimedJobSql}`)
      .bind(status, body, now, resultStatus, location, completedAt, job.id, ...claimedJobBindings(job)),
    abortIf(env, 'changes() <> 1'),
    receipt.write,
    receipt.guard,
    abortIf(env, `NOT EXISTS (SELECT 1 ${exactState})`, expected),
  ];
  return {
    queued, statements,
    async committed() {
      return !!await env.DB.prepare(`SELECT 1 ${exactState}`).bind(...expected).first();
    },
  };
}
