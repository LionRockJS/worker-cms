// Runtime services contributed by installed features.
//
// This is the service-side twin of ./routers.ts: the concrete entries are
// generated from cms.features.json, while callers depend only on the neutral
// interfaces and dispatch helpers in this file. Core therefore never imports
// a feature implementation or a feature-owned contract directly.

import type { AppContext } from '../core/http/context';
import type { Env } from '../types';
import { featureServiceEntries } from '../generated/services';
import { regulatedWritesBlocked } from '../core/http/regulated-writes';

export type AdminScreenTarget =
  | { screen: 'profile' }
  | { screen: 'users' }
  | { screen: 'user'; userId: number };

export interface PageCreateReservationInput {
  pageTypes: ReadonlyArray<{ pageType: string; count: number }>;
  payerUserId: number | null;
  contributorId?: string;
}

export type FeatureReservation =
  | {
    ok: true;
    charged: number;
    refund(portion?: number): Promise<void>;
  }
  | {
    ok: false;
    status: 400 | 402;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };

export interface FeatureServiceEntry {
  readonly id: string;
  reservePageCreate?(c: AppContext, pageType: string): Promise<FeatureReservation>;
  reservePageCreates?(env: Env, input: PageCreateReservationInput): Promise<FeatureReservation>;
  adminScreenProps?(c: AppContext, target: AdminScreenTarget): Promise<Record<string, unknown>>;
  scheduled?(env: Env): Promise<string | null>;
  /** Audit retention/archival only; business work is denied by default. */
  scheduledDuringWriteContainment?: true;
  /** Health-only work that must run even when regulated admission fails. */
  monitor?(env: Env): Promise<void>;
  call?(operation: string, env: Env, input: unknown): Promise<unknown>;
}

const servicesById = new Map(featureServiceEntries.map((entry) => [entry.id, entry]));

export function freeReservation(): FeatureReservation {
  return { ok: true, charged: 0, refund: async () => {} };
}

async function combineReservations(
  work: Array<() => Promise<FeatureReservation>>,
): Promise<FeatureReservation> {
  const reservations: Array<Extract<FeatureReservation, { ok: true }>> = [];
  for (const run of work) {
    const reservation = await run();
    if (!reservation.ok) {
      for (const prior of reservations.reverse()) await prior.refund();
      return reservation;
    }
    reservations.push(reservation);
  }
  return {
    ok: true,
    charged: reservations.reduce((sum, reservation) => sum + reservation.charged, 0),
    refund: async (portion?: number) => {
      for (const reservation of reservations.slice().reverse()) await reservation.refund(portion);
    },
  };
}

/** Runs every installed feature's page-create reservation hook. */
export function reservePageCreate(c: AppContext, pageType: string): Promise<FeatureReservation> {
  return combineReservations(
    featureServiceEntries
      .filter((entry) => entry.reservePageCreate)
      .map((entry) => () => entry.reservePageCreate!(c, pageType)),
  );
}

/** Batch equivalent used by plugin/server-to-server page creation. */
export function reservePageCreates(env: Env, input: PageCreateReservationInput): Promise<FeatureReservation> {
  return combineReservations(
    featureServiceEntries
      .filter((entry) => entry.reservePageCreates)
      .map((entry) => () => entry.reservePageCreates!(env, input)),
  );
}

/** Merges props contributed to a screen by every installed feature. */
export async function featureAdminScreenProps(
  c: AppContext,
  target: AdminScreenTarget,
): Promise<Record<string, unknown>> {
  const props = await Promise.all(
    featureServiceEntries
      .filter((entry) => entry.adminScreenProps)
      .map((entry) => entry.adminScreenProps!(c, target)),
  );
  return Object.assign({}, ...props);
}

/** Runs bounded scheduled work contributed by installed features. */
export async function runFeatureScheduledWork(env: Env): Promise<string[]> {
  const lines = await Promise.all(
    featureServiceEntries
      .filter((entry) => entry.scheduled && (!regulatedWritesBlocked(env) || entry.scheduledDuringWriteContainment === true))
      .map((entry) => entry.scheduled!(env)),
  );
  return lines.filter((line): line is string => Boolean(line));
}

export async function runFeatureMonitoringWork(env: Env): Promise<void> {
  for (const entry of featureServiceEntries) {
    try { await entry.monitor?.(env); }
    catch { console.error(JSON.stringify({ event: 'feature.monitor-failed', feature: entry.id })); }
  }
}

/**
 * Calls an optional named feature service without importing its module or
 * contract. Callers own their local structural view of the request/result.
 */
export async function callFeatureService<T>(
  featureId: string,
  operation: string,
  env: Env,
  input: unknown,
): Promise<T | undefined> {
  const service = servicesById.get(featureId);
  if (!service?.call) return undefined;
  return await service.call(operation, env, input) as T | undefined;
}
