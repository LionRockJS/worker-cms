import type { AppContext } from '../http/context';
import type { AccessAuthorization } from '../auth/access-authorization';
import { captureMutationAuthority } from './mutation-authority';
import { classFor, classificationPolicyGuard, strongestClass, type ContainerKind } from '../db/data-classes';
import { attributedMutationAuditEvidence, contextActor, type AuditEntry } from '../db/audit';
import { abortIf } from '../db/transaction-guard';
import { json, snapshotStatement, snapshotRows, guard } from '../db/bounded-mutation';
import { auditBackgroundReads, flushReadAudit, type PendingRead } from '../http/access-log';
import { recordAuditOutage } from '../db/audit-outages';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

/**
 * The standard recipe for one audited admin change. A writer declares:
 *
 *   permission  who may make the change (session user + capability)
 *   classify    which containers decide the evidence's data class (fixed,
 *               or from the snapshot rows; a plan may add more)
 *   snapshot    the rows the decision depends on, plus how their read is logged
 *   decide      a pure plan: writes, the evidence entry, the expected final state
 *
 * The runner owns everything else and always runs it in this order:
 *
 *   1. gate       regulated-writes check
 *   2. authorize  fresh authority; its classification policy is read once
 *                 and reused for every later step
 *   3. snapshot   bounded reads batched behind a policy guard, so the read
 *                 evidence is classified by the policy in force at the read,
 *                 and never below the change's own class; flushed at once
 *   4. decide     writer's plan; its only database access is the runner's
 *                 transaction clock (with any trusted extra columns, such
 *                 as a next ID), reused as the timestamp baseline
 *   5. commit     one D1 batch:
 *                   admission  authority, policy, every snapshot unchanged
 *                   writes     each followed by its exact changes() check
 *                   evidence   audit write + exact receipt guard
 *                   expect     writer's postconditions
 *                   re-admit   authority and policy again, so business
 *                              triggers inside the batch cannot slip past
 *   6. fail       any error: coarse outage incident, then the writer's error.
 *                 Errors the writer marks as its own (validation, policy
 *                 refusals) pass through unchanged, with no incident.
 *
 * A null plan, or one without writes, commits only the admission guards and
 * records no event.
 */

type Binding = string | number | null;

export interface SnapshotSpec {
  table: string;
  fields: string[];
  /** Fixed trusted SQL; values go in args. */
  where: string;
  args: Binding[];
  /** Fixed trusted SQL; defaults to the first field. */
  order?: string;
  /** How reading these rows is logged before the change. */
  read: Omit<PendingRead, 'ids' | 'count'> & { id: (row: Record<string, Binding>) => string | Promise<string> };
}

export interface PlannedWrite {
  /** Fixed trusted SQL; values go in args. */
  sql: string;
  args: Binding[];
  /** Rows this statement must change; defaults to 1. */
  changes?: number;
}

type Containers = Array<[ContainerKind, string]>;

export interface MutationPlan {
  writes: PlannedWrite[];
  evidence: { entry: AuditEntry; targetIds?: string[] };
  /** Containers the change itself touches, raising the evidence class. */
  classify?: Containers;
  /** Postconditions after the writes. `since` is the database clock read just
   *  before the batch, for rows whose timestamps the transaction sets. */
  expect: (since: string) => D1PreparedStatement[];
}

export interface MutationSpec<S extends Record<string, SnapshotSpec>> {
  permission: Exclude<AccessAuthorization['capability'], 'authenticated'>;
  classify: Containers | ((rows: Snapshots<S>) => Containers);
  snapshot: S;
  /** The writer's own refusal, so its route keeps its existing 503 body. */
  unavailable: () => Error;
  /** Errors that are the writer's own answer, such as invalid input. */
  passthrough?: (error: unknown) => boolean;
}

export type Snapshots<S> = { [K in keyof S]: Array<Record<string, Binding>> };

export interface DecideTools {
  /** Transaction clock, read once; `columns` is fixed trusted SQL. */
  clock(columns?: string): Promise<{ now: string } & Record<string, Binding>>;
}

export interface AuditedMutation<S> {
  rows: Snapshots<S>;
  commit(decide: (rows: Snapshots<S>, tools: DecideTools) => MutationPlan | null | Promise<MutationPlan | null>): Promise<void>;
}

export async function beginAuditedMutation<S extends Record<string, SnapshotSpec>>(c: AppContext, spec: MutationSpec<S>): Promise<AuditedMutation<S>> {
  const fail = async (error: unknown): Promise<never> => {
    if (spec.passthrough?.(error)) throw error;
    await recordAuditOutage(c.env, 'health', [], contextActor(c), undefined, { captureIncomplete: true });
    throw spec.unavailable();
  };

  // 1. gate (outside the try: a refusal here is reported by the caller's route)
  assertRegulatedWritesAllowed(c.env);

  let prepared;
  try {
    // 2. authorize
    const { authority, policy } = await captureMutationAuthority(c, spec.permission);

    // 3. snapshot: one round trip for every snapshot, behind the policy guard
    const names = Object.keys(spec.snapshot) as Array<keyof S>;
    const results = await c.env.DB.batch<{ snapshot: string }>([
      classificationPolicyGuard(c.env, policy),
      ...names.map(name => {
        const { table, fields, where, args, order } = spec.snapshot[name];
        return snapshotStatement(c, table, fields, where, args, order);
      }),
    ]);
    const rows = {} as Snapshots<S>;
    names.forEach((name, index) => { rows[name] = snapshotRows(spec.snapshot[name].fields, results[index + 1].results[0]); });
    const containers = typeof spec.classify === 'function' ? spec.classify(rows) : spec.classify;
    const classOf = (more: Containers = []) => strongestClass([...containers, ...more].map(([kind, key]) => classFor(policy, kind, key)));
    const dataClass = classOf();
    const reads: PendingRead[] = [];
    for (const name of names) {
      const { read } = spec.snapshot[name];
      const captured = rows[name];
      const { id, ...pending } = read;
      reads.push({ minimumClass: dataClass === 'none' ? undefined : dataClass, ...pending,
        ids: await Promise.all(captured.map(id)), count: captured.length });
    }
    await auditBackgroundReads(c.env, reads, contextActor(c), { policy });
    if (await flushReadAudit(c)) throw new Error('Mutation read evidence unavailable');

    const admission = () => [
      authority.guard(),
      classificationPolicyGuard(c.env, policy),
      ...Object.keys(spec.snapshot).map(name => {
        const { table, fields, where, args } = spec.snapshot[name];
        return guard(c, table, fields, rows[name as keyof S], where, args);
      }),
    ];
    prepared = { authority, policy, classOf, rows, admission };
  } catch (error) {
    return fail(error);
  }
  const { authority, policy, classOf, rows, admission } = prepared;

  return {
    rows,
    async commit(decide) {
      try {
        assertRegulatedWritesAllowed(c.env);

        // 4. decide
        let clock: ({ now: string } & Record<string, Binding>) | undefined;
        const tools: DecideTools = {
          async clock(columns) {
            if (clock) throw new Error('Mutation clock already read');
            clock = await c.env.DB.prepare(`SELECT CURRENT_TIMESTAMP AS now${columns ? `, ${columns}` : ''}`).first() ?? undefined;
            if (!clock) throw new Error('Mutation clock unavailable');
            return clock;
          },
        };
        const plan = await decide(rows, tools);
        json(plan?.writes ?? []);
        if (await flushReadAudit(c)) throw new Error('Mutation read evidence unavailable');
        if (!plan?.writes.length) {
          await c.env.DB.batch(admission());
          return;
        }

        // 5. commit
        const since = clock ?? await tools.clock();
        const { entry, targetIds } = plan.evidence;
        const receipt = attributedMutationAuditEvidence(c.env, c.get('user'),
          { ...entry, detail: { operation_id: crypto.randomUUID(), ...entry.detail } },
          classOf(plan.classify), policy, { context: c, targetIds });
        await c.env.DB.batch([
          ...admission(),
          ...plan.writes.flatMap(w => [
            c.env.DB.prepare(w.sql).bind(...w.args),
            abortIf(c.env, 'changes() <> ?', [w.changes ?? 1]),
          ]),
          receipt.write,
          receipt.guard,
          ...plan.expect(since.now),
          authority.guard(),
          classificationPolicyGuard(c.env, policy),
        ]);
      } catch (error) {
        await fail(error);
      }
    },
  };
}
