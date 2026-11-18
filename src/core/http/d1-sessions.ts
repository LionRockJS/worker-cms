import type { Env, WorkerEnv } from '../../types';
import { featureInstalled } from '../../features';

/**
 * Create one sequentially consistent D1 session per database binding for a
 * single Worker request or background job.
 *
 * Starting on the primary preserves the CMS's existing freshness semantics;
 * later queries in the same session may be served by a sufficiently current
 * replica while still observing earlier writes.
 */
export function withD1Sessions(env: WorkerEnv): Env {
  return {
    ...env,
    DB: env.DB.withSession('first-primary'),
    PUBLISHED_DB: featureInstalled('publish') ? env.PUBLISHED_DB?.withSession('first-primary') : undefined,
  };
}
