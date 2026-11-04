// The jobs feature's runtime service entry (W12 retention).
//
// A finished job keeps its request body and a snapshot of the user who started
// it, and the body of a plugin action or bulk import can carry personal data.
// Neither is read again once a job is done or failed, so after
// JOB_RETENTION_DAYS this clears them and keeps the rest of the row: id, type,
// status, timings and result stay as the record that the job ran. Unset, it
// does nothing.

import type { FeatureServiceEntry } from '../services';
import type { Env } from '../../types';

/** Rows cleared per cron tick. */
const CLEAR_LIMIT = 500;

export const jobsServices: FeatureServiceEntry = {
  id: 'jobs',

  async scheduled(env: Env): Promise<string | null> {
    const days = Number(env.JOB_RETENTION_DAYS);
    if (!Number.isSafeInteger(days) || days <= 0) return null;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = await env.DB.prepare(
      `UPDATE admin_jobs SET body = NULL, user_json = NULL
       WHERE id IN (SELECT id FROM admin_jobs WHERE status IN ('done', 'failed') AND updated_at < ?
         AND (body IS NOT NULL OR user_json IS NOT NULL) LIMIT ?)`,
    ).bind(cutoff, CLEAR_LIMIT).run();
    const cleared = result.meta.changes ?? 0;
    return cleared ? `job retention: cleared ${cleared}` : null;
  },
};
