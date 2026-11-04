// ============================================================
// Signal delivery and review receipts (W13, A.5.24–A.5.26, A.8.16).
//
// signals.ts detects; until W13 nothing told anyone, and nothing recorded that
// a person had looked. This sends each flagged signal to the audit receiver
// once a day, and records a reviewer's decision as an audit event so the
// review cadence can be shown, alerted on and evidenced.
//
// Alerts carry counts only: which signal, how many rows, the window and the
// threshold. Who and what was flagged stays in the CMS, behind audit:read.
// ============================================================

import type { Env } from '../../types';
import { monitorSource, outageEnabled, OUTAGE_PREFIX } from '../../core/db/audit-outages';
import type { ReviewSignal } from './signals';

export const SIGNAL_REVIEW_ACTION = 'audit.signals-reviewed';
/** The receipt's target type, so the latest one is found through idx_audit_events_target. */
export const SIGNAL_REVIEW_TARGET = 'audit_review';
export const REVIEW_OUTCOMES = ['no-action', 'false-positive', 'incident-opened'] as const;
export type ReviewOutcome = typeof REVIEW_OUTCOMES[number];

/** A case reference, never a name, email or description. */
export const REFERENCE_PATTERN = /^[A-Za-z0-9._:\/#-]{1,120}$/;

/** Days between reviews before one is overdue. AUDIT_REVIEW_INTERVAL_DAYS, default 7. */
export function reviewIntervalDays(env: Env): number {
  const days = Number(env.AUDIT_REVIEW_INTERVAL_DAYS);
  return Number.isSafeInteger(days) && days > 0 ? days : 7;
}

export interface SignalReview {
  at: string;
  by: number | null;
  outcome: string;
  reference: string | null;
}

export async function lastSignalReview(env: Env): Promise<SignalReview | null> {
  const row = await env.DB.prepare(
    'SELECT occurred_at, actor_user_id, detail FROM audit_events WHERE target_type = ? AND action = ? ORDER BY seq DESC LIMIT 1',
  ).bind(SIGNAL_REVIEW_TARGET, SIGNAL_REVIEW_ACTION).first<{ occurred_at: string; actor_user_id: string | number | null; detail: string | null }>();
  if (!row) return null;
  let detail: { outcome?: string; reference?: string | null } = {};
  try { detail = JSON.parse(row.detail ?? '{}'); } catch { /* Shown as unknown. */ }
  return { at: row.occurred_at, by: row.actor_user_id == null ? null : Number(row.actor_user_id),
    outcome: detail.outcome ?? 'unknown', reference: detail.reference ?? null };
}

export function reviewOverdue(env: Env, last: SignalReview | null, now = Date.now()): boolean {
  return !last || now - Date.parse(last.at) > reviewIntervalDays(env) * 86_400_000;
}

const deliveredKey = (signal: string, day: string) => `${OUTAGE_PREFIX}signals/${signal}-${day}.json`;

/**
 * Sends each flagged signal to the receiver at most once per UTC day. The
 * receiver must deduplicate Idempotency-Key as it does for incidents; the
 * journal marker only saves repeat calls. Returns how many were delivered.
 */
export async function deliverSignalAlerts(env: Env, signals: ReviewSignal[], now = new Date()): Promise<number> {
  const source = monitorSource(env);
  if (!outageEnabled(env) || !env.AUDIT_MONITOR || !source) return 0;
  const day = now.toISOString().slice(0, 10);
  let delivered = 0;
  for (const signal of signals) {
    if (!signal.rows.length) continue;
    const key = deliveredKey(signal.id, day);
    try { if (await env.AUDIT_OUTAGE_BUCKET?.head(key)) continue; } catch { /* Deliver; the receiver deduplicates. */ }
    try {
      const response = await env.AUDIT_MONITOR.fetch('https://audit-monitor.internal/signals', {
        method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': `${source}:${signal.id}:${day}` },
        signal: AbortSignal.timeout(2000),
        body: JSON.stringify({ version: 1, kind: 'security-signal', source, signal: signal.id, day,
          flagged: signal.rows.length, windowHours: signal.windowHours, threshold: signal.threshold }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Receiver refused ${response.status}`);
      delivered++;
      try { await env.AUDIT_OUTAGE_BUCKET?.put(key, JSON.stringify({ deliveredAt: now.toISOString() })); } catch { /* A resend is deduplicated by the receiver. */ }
    } catch {
      console.error(JSON.stringify({ event: 'audit.signal-delivery-failed', signal: signal.id }));
    }
  }
  return delivered;
}
