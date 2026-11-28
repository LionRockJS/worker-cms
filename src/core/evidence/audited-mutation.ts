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
 *   4. decide     writer's plan; its only database access goes through the
 *                 runner: the transaction clock (with trusted extra columns,
 *                 such as a next ID, reused as the timestamp baseline) and
 *                 follow-up snapshots that depend on the first rows, read
 *                 and guarded exactly like step 3
 *   5. commit     one D1 batch:
 *                   admission  authority, policy, every snapshot unchanged
 *                   writes     each followed by its exact changes() check
 *                   evidence   audit write + exact receipt guard
 *                   expect     writer's postconditions
 *                   re-admit   authority and policy again, so business
 *                              triggers inside the batch cannot slip past
 *                   returning  optional final SELECT, returned by commit
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
  /** Fixed trusted SQL run last in the batch; its first row is returned. */
  returning?: { sql: string; args: Binding[] };
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
  /** Snapshots that depend on the first rows. `classify` adds containers to
   *  both these reads and the change's evidence. Guarded at admission. */
  snapshot(specs: SnapshotSpec[], classify?: Containers): Promise<Array<Array<Record<string, Binding>>>>;
}

export interface AuditedMutation<S> {
  rows: Snapshots<S>;
  commit(decide: (rows: Snapshots<S>, tools: DecideTools) => MutationPlan | null | Promise<MutationPlan | null>): Promise<Record<string, Binding> | undefined>;
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
    let containers: Containers = [];
    const classOf = (more: Containers = []) => strongestClass([...containers, ...more].map(([kind, key]) => classFor(policy, kind, key)));
    const guards: Array<() => D1PreparedStatement> = [];
    const read = async (specs: SnapshotSpec[], classify: (rows: Array<Array<Record<string, Binding>>>) => Containers) => {
      const results = await c.env.DB.batch<{ snapshot: string }>([
        classificationPolicyGuard(c.env, policy),
        ...specs.map(({ table, fields, where, args, order }) => snapshotStatement(c, table, fields, where, args, order)),
      ]);
      const captured = specs.map((s, index) => snapshotRows<Record<string, Binding>>(s.fields, results[index + 1].results[0]));
      containers = [...containers, ...classify(captured)];
      const dataClass = classOf();
      const reads: PendingRead[] = [];
      for (const [index, { read: { id, ...pending } }] of specs.entries()) {
        reads.push({ minimumClass: dataClass === 'none' ? undefined : dataClass, ...pending,
          ids: await Promise.all(captured[index].map(id)), count: captured[index].length });
      }
      await auditBackgroundReads(c.env, reads, contextActor(c), { policy });
      if (await flushReadAudit(c)) throw new Error('Mutation read evidence unavailable');
      specs.forEach(({ table, fields, where, args }, index) => guards.push(() => guard(c, table, fields, captured[index], where, args)));
      return captured;
    };
    const names = Object.keys(spec.snapshot) as Array<keyof S>;
    const rows = {} as Snapshots<S>;
    await read(names.map(name => spec.snapshot[name]), captured => {
      names.forEach((name, index) => { rows[name] = captured[index]; });
      return typeof spec.classify === 'function' ? spec.classify(rows) : spec.classify;
    });

    const admission = () => [authority.guard(), classificationPolicyGuard(c.env, policy), ...guards.map(g => g())];
    prepared = { authority, policy, classOf, rows, admission, read };
  } catch (error) {
    return fail(error);
  }
  const { authority, policy, classOf, rows, admission, read } = prepared;

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
          snapshot: (specs, classify = []) => read(specs, () => classify),
        };
        const plan = await decide(rows, tools);
        json(plan?.writes ?? []);
        if (await flushReadAudit(c)) throw new Error('Mutation read evidence unavailable');
        if (!plan?.writes.length) {
          await c.env.DB.batch(admission());
          return undefined;
        }

        // 5. commit
        const since = clock ?? await tools.clock();
        const { entry, targetIds } = plan.evidence;
        const receipt = attributedMutationAuditEvidence(c.env, c.get('user'),
          { ...entry, detail: { operation_id: crypto.randomUUID(), ...entry.detail } },
          classOf(plan.classify), policy, { context: c, targetIds });
        const results = await c.env.DB.batch([
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
          ...(plan.returning ? [c.env.DB.prepare(plan.returning.sql).bind(...plan.returning.args)] : []),
        ]);
        if (!plan.returning) return undefined;
        const returned = results.at(-1)?.results[0] as Record<string, Binding> | undefined;
        if (!returned) throw new Error('Mutation result unavailable');
        return returned;
      } catch (error) {
        return fail(error);
      }
    },
  };
}
