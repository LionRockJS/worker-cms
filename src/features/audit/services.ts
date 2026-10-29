// The audit feature's runtime service entry.
//
// src/generated/services.ts includes this only when the feature is enabled, so
// an install without it keeps recording audit events and simply never archives
// or prunes them. Core calls the neutral dispatcher in src/features/services.ts
// and never imports this module.

import type { FeatureServiceEntry } from '../services';
import type { Env } from '../../types';
import { sweepAuditEvents } from './sweep';

export const auditServices: FeatureServiceEntry = {
  id: 'audit',

  /**
   * One bounded archive-and-prune pass per cron tick. Silent when there is
   * nothing to do, so the scheduled handler's log stays readable.
   */
  async scheduled(env: Env): Promise<string | null> {
    const result = await sweepAuditEvents(env);
    if (result.skipped) return null;
    return `audit sweep: ${JSON.stringify(result)}`;
  },
};
