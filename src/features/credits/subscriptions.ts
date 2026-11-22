// ============================================================
// Recurring credit billing — plugin-reported usage, cron-swept charges.
//
// A plugin declares a 'recurring' cost in its manifest (price per `per` units
// per month, billed in 'advance' or 'arrears') and reports each user's usage
// via POST /__cms/credits/usage. The host keeps one subscription row per
// (user, plugin, cost) and the cron sweep bills due rows monthly through
// spendCredits(), so recurring charges get the same ledger rows and
// shared-pool fallback as every other spend.
//
// Billing modes:
//   - advance  → bill ceil(quantity / per) * price for the COMING month; the
//                first charge lands on the sweep right after the subscription
//                is created (next_charge_at starts at now).
//   - arrears  → bill ceil(peak_quantity / per) * price for the ELAPSED
//                month; the high-water mark since the last charge, so usage
//                can't dodge the bill by shrinking just before the boundary.
//                First charge lands one month after creation.
//
// The debit, ledger entry, and period advance share one transaction. The
// wallet writes require the subscription snapshot to still match, so a
// concurrent sweep or a new usage report invalidates the old calculation.
//
// Mode switches (manifest changed between charges) use last_mode:
//   - advance → arrears: the elapsed period was pre-paid, so the first
//     arrears boundary charges nothing.
//   - arrears → advance: the boundary owes both the elapsed month (arrears,
//     on peak) and the coming month (advance, on quantity); they are billed
//     as ONE combined spend so a partial failure can't half-bill the switch.
//
// Failure handling: insufficient credits flips the row to 'past_due' and
// retries daily while preserving the billing state; an unreachable plugin
// defers the row an hour without changing
// status; a manifest that no longer declares the cost cancels the row. When
// usage drops to zero the sweep settles any arrears at the boundary and then
// cancels; a later usage report reactivates the row as a fresh subscription.
// ============================================================

import type { Env } from '../../types';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import type { CreditBillingMode } from './contracts';
import { type EffectiveCredit, creditContributors, currencyLabel, effectiveCreditsFor, spendCredits } from './service';

/** Rows swept per cron tick — bounds sweep time and subrequests. */
const SWEEP_BATCH = 25;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type CreditSubscriptionStatus = 'active' | 'past_due' | 'canceled';

export interface CreditSubscriptionRow {
  id: number;
  user_id: number;
  plugin_id: string;
  credit_key: string;
  /** Latest reported usage (units, e.g. records). */
  quantity: number;
  /** High-water mark since the last successful charge (arrears bills this). */
  peak_quantity: number;
  status: CreditSubscriptionStatus;
  next_charge_at: string;
  last_charged_at: string | null;
  /** Billing mode of the last successful charge — drives mode-switch rules. */
  last_mode: CreditBillingMode | null;
  created_at: string;
  updated_at: string;
}

/** Formats a Date as the SQLite CURRENT_TIMESTAMP format (UTC), so string
 *  comparisons against stored timestamps stay consistent. */
export function sqliteDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseSqliteDate(value: string): Date {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

/** UTC month arithmetic with day-of-month clamping (Jan 31 + 1mo → Feb 28). */
export function addMonthsUTC(date: Date, months: number): Date {
  const target = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

/** Credits owed for `units` at `price` per started block of `per` units. */
export function blockCost(units: number, per: number, price: number): number {
  if (units <= 0 || price <= 0) return 0;
  return Math.ceil(units / Math.max(per, 1)) * price;
}

export type UsageReportResult =
  | { ok: true; subscription: CreditSubscriptionRow | null }
  | { ok: false; error: 'unknown_user' };

/**
 * Upserts the subscription row for a plugin-reported usage snapshot. The
 * caller (the /__cms/credits/usage endpoint) has already resolved `credit` to
 * a recurring cost the plugin's manifest declares.
 *
 * A positive quantity creates the row (advance bills on the next sweep,
 * arrears one month out) or updates it — quantity is replaced, the peak only
 * ratchets up. A canceled row is reactivated as if newly created. Reporting
 * zero never creates a row; on an existing one it lets the sweep settle and
 * cancel at the boundary.
 */
export async function reportSubscriptionUsage(
  env: Env,
  input: { userId: number; credit: EffectiveCredit; quantity: number; now?: Date },
): Promise<UsageReportResult> {
  const now = input.now ?? new Date();
  const quantity = Math.trunc(input.quantity);
  const { pluginId, def } = input.credit;

  if (quantity <= 0) {
    const row = await env.DB.prepare(
      `UPDATE credit_subscriptions SET quantity = 0, updated_at = ?
        WHERE user_id = ? AND plugin_id = ? AND credit_key = ? AND status != 'canceled'
        RETURNING *`,
    ).bind(sqliteDate(now), input.userId, pluginId, def.key).first<CreditSubscriptionRow>();
    return { ok: true, subscription: row ?? null };
  }

  // Advance bills the coming month immediately (the sweep picks the row up on
  // its next tick); arrears bills once the first month has elapsed.
  const firstChargeAt = def.billing === 'arrears' ? addMonthsUTC(now, 1) : now;

  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(input.userId).first<{ id: number }>();
  if (!user) return { ok: false, error: 'unknown_user' };

  const row = await env.DB.prepare(
    `INSERT INTO credit_subscriptions (user_id, plugin_id, credit_key, quantity, peak_quantity, status, next_charge_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(user_id, plugin_id, credit_key) DO UPDATE SET
       quantity = excluded.quantity,
       peak_quantity = CASE WHEN status = 'canceled' THEN excluded.quantity ELSE MAX(peak_quantity, excluded.quantity) END,
       next_charge_at = CASE WHEN status = 'canceled' THEN excluded.next_charge_at ELSE next_charge_at END,
       last_mode = CASE WHEN status = 'canceled' THEN NULL ELSE last_mode END,
       status = CASE WHEN status = 'canceled' THEN 'active' ELSE status END,
       updated_at = excluded.updated_at
     RETURNING *`,
  ).bind(
    input.userId, pluginId, def.key, quantity, quantity,
    sqliteDate(firstChargeAt), sqliteDate(now), sqliteDate(now),
  ).first<CreditSubscriptionRow>();
  return { ok: true, subscription: row ?? null };
}

export async function listSubscriptionsForPlugin(
  env: Env,
  pluginId: string,
  userId?: number,
): Promise<CreditSubscriptionRow[]> {
  const rows = userId === undefined
    ? await env.DB.prepare('SELECT * FROM credit_subscriptions WHERE plugin_id = ? ORDER BY id LIMIT 500')
      .bind(pluginId).all<CreditSubscriptionRow>()
    : await env.DB.prepare('SELECT * FROM credit_subscriptions WHERE plugin_id = ? AND user_id = ? ORDER BY id LIMIT 500')
      .bind(pluginId, userId).all<CreditSubscriptionRow>();
  return rows.results;
}

export interface SweepResult {
  processed: number;
  charged: number;
  pastDue: number;
  canceled: number;
  deferred: number;
  failed: number;
}

/**
 * Bills every due subscription (one bounded batch per call — the cron runs
 * every 5 minutes, so backlogs drain quickly). See the module header for the
 * billing/idempotency/mode-switch rules this implements.
 */
export async function sweepCreditSubscriptions(env: Env, opts: { now?: Date } = {}): Promise<SweepResult> {
  assertRegulatedWritesAllowed(env);
  const now = opts.now ?? new Date();
  const result: SweepResult = { processed: 0, charged: 0, pastDue: 0, canceled: 0, deferred: 0, failed: 0 };

  const due = await env.DB.prepare(
    `SELECT * FROM credit_subscriptions
      WHERE status IN ('active', 'past_due') AND next_charge_at <= ?
      ORDER BY next_charge_at, id LIMIT ?`,
  ).bind(sqliteDate(now), SWEEP_BATCH).all<CreditSubscriptionRow>();
  if (!due.results.length) return result;

  const contributors = new Map((await creditContributors(env)).map((entry) => [entry.id, entry]));
  // Effective prices are per-contributor, not per-row — resolve each once.
  const creditCache = new Map<string, EffectiveCredit[]>();

  for (const row of due.results) {
    result.processed += 1;

    try {
      // Amount and mode were calculated from this snapshot. A report or another
      // sweep can change billing fields between the due query and the write.
      const current = `id = ? AND next_charge_at = ? AND status = ? AND quantity = ?
        AND peak_quantity = ? AND last_charged_at IS ? AND last_mode IS ?`;
      const bindings = [row.id, row.next_charge_at, row.status, row.quantity,
        row.peak_quantity, row.last_charged_at, row.last_mode];

      const contributor = contributors.get(row.plugin_id);
      if (!contributor) {
        // Unreachable or disabled — likely transient, so defer without touching
        // status; a permanently removed plugin keeps deferring hourly until an
        // admin clears it or it comes back.
        const deferred = await env.DB.prepare(
          `UPDATE credit_subscriptions SET next_charge_at = ?, updated_at = ? WHERE ${current} RETURNING id`,
        ).bind(sqliteDate(new Date(now.getTime() + HOUR_MS)), sqliteDate(now), ...bindings).first();
        if (deferred) result.deferred += 1;
        continue;
      }

      let credits = creditCache.get(row.plugin_id);
      if (!credits) {
        credits = await effectiveCreditsFor(env, contributor);
        creditCache.set(row.plugin_id, credits);
      }
      const credit = credits.find((entry) => entry.def.key === row.credit_key);
      if (!credit || credit.def.charge !== 'recurring') {
        // The manifest is authoritative: the cost no longer exists, so the
        // subscription ends. A future usage report recreates it.
        const canceled = await env.DB.prepare(
          `UPDATE credit_subscriptions SET status = 'canceled', updated_at = ? WHERE ${current} RETURNING id`,
        ).bind(sqliteDate(now), ...bindings).first();
        if (canceled) result.canceled += 1;
        continue;
      }

      const mode = credit.def.billing ?? 'advance';
      const { per, unit } = credit.def;
      const money = currencyLabel(credit.def.currency);
      const price = credit.value;

      // What this boundary owes (see module header for the mode-switch rules).
      let amount = 0;
      let note: string;
      if (mode === 'advance') {
        amount = blockCost(row.quantity, per, price);
        note = `advance: ${row.quantity} ${unit} @ ${price} ${money}/${per}/month`;
        if (row.last_mode === 'arrears') {
          const owed = blockCost(row.peak_quantity, per, price);
          amount += owed;
          note = `billing switch: arrears peak ${row.peak_quantity} (${owed}) + ${note}`;
        }
      } else if (row.last_mode === 'advance') {
        // advance → arrears: the elapsed month was pre-paid; charge nothing.
        note = 'billing switch: advance → arrears, period pre-paid';
      } else {
        amount = blockCost(row.peak_quantity, per, price);
        note = `arrears: peak ${row.peak_quantity} ${unit} @ ${price} ${money}/${per}/month`;
      }

      // Advance from the due date to keep the anniversary. Skip missed periods
      // when the resulting date is still past due.
      let nextAt = addMonthsUTC(parseSqliteDate(row.next_charge_at), 1);
      if (nextAt.getTime() <= now.getTime()) nextAt = addMonthsUTC(now, 1);
      const advance = (afterDebit: boolean) => env.DB.prepare(
        `UPDATE credit_subscriptions
            SET next_charge_at = ?, last_charged_at = ?, last_mode = ?, updated_at = ?,
                peak_quantity = quantity,
                status = CASE WHEN quantity = 0 THEN 'canceled' ELSE 'active' END
          WHERE ${current}${afterDebit ? ' AND changes() = 1' : ''}
          RETURNING id`,
      ).bind(sqliteDate(nextAt), sqliteDate(now), mode, sqliteDate(now), ...bindings);

      if (amount > 0) {
        const charge = await spendCredits(env, {
          userId: row.user_id,
          amount,
          // The wallet comes from the cost as declared NOW, so re-denominating a
          // recurring cost takes effect from the next period.
          currency: credit.def.currency,
          action: `${row.plugin_id}:${row.credit_key}`,
          entityType: 'subscription',
          entityId: String(row.id),
          pluginId: row.plugin_id,
          // The plugin's own wallet pays its subscription first.
          scopePluginId: row.plugin_id,
          pluginOnly: credit.def.pluginOnly,
          note,
          createdBy: 'system:cron',
          settlement: {
            eligible: `EXISTS (SELECT 1 FROM credit_subscriptions WHERE ${current})`,
            bindings,
            advance: advance(true),
          },
        });
        if (!charge.ok) {
          // A stale snapshot cannot debit any wallet or change the schedule.
          // A genuine decline keeps the billing state and schedules a retry.
          const status = charge.error === 'unknown_user' ? 'canceled' : 'past_due';
          const retryAt = status === 'canceled' ? row.next_charge_at : sqliteDate(new Date(now.getTime() + DAY_MS));
          const declined = await env.DB.prepare(
            `UPDATE credit_subscriptions SET status = ?, next_charge_at = ?, updated_at = ?
              WHERE ${current} RETURNING id`,
          ).bind(status, retryAt, sqliteDate(now), ...bindings).first();
          if (declined) {
            if (status === 'canceled') result.canceled += 1;
            else result.pastDue += 1;
          }
          continue;
        }
        result.charged += 1;
      } else if (!await advance(false).first()) {
        continue;
      }

      if (row.quantity === 0) result.canceled += 1;
    } catch (error) {
      result.failed += 1;
      console.error('[credits] Subscription sweep failed', { subscriptionId: row.id, error });
    }
  }

  return result;
}
