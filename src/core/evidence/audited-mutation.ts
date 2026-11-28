import type { AppContext } from '../http/context';
import type { AccessAuthorization } from '../auth/access-authorization';
import { captureMutationAuthority } from './mutation-authority';
import { classFor, classificationPolicyGuard, strongestClass, type ContainerKind, type DataClass, type DataClassMap } from '../db/data-classes';
import { attributedMutationAuditEvidence, contextActor, serviceMutationAuditEvidence, type AuditActor, type AuditEntry } from '../db/audit';
import { abortIf } from '../db/transaction-guard';
import { json, snapshotStatement, snapshotRows, guard } from '../db/bounded-mutation';
import { auditBackgroundReads, flushReadAudit, recordRead, type PendingRead } from '../http/access-log';
import { recordAuditOutage } from '../db/audit-outages';
import { assertRegulatedWritesAllowed } from '../http/regulated-writes';

/**
 * The standard recipe for one audited request mutation. A writer declares:
 *
 *   permission  who may make the change: a capability of the session user,
 *               or 'self' for the user acting on their own account. A service
 *               writer supplies its captured credential principal and checks.
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
 *                 evidence uses the policy in force at the read. Background
 *                 evidence is raised to the change's class. Request reads
 *                 use the request audit buffer and keep their own class.
 *   4. decide     writer's plan; its only database access goes through the
 *                 runner: the transaction clock (with trusted extra columns,
 *                 such as a next ID, reused as the timestamp baseline) and
 *                 follow-up snapshots that depend on the first rows, read
 *                 and guarded exactly like step 3. A follow-up may also be a
 *                 source: an aggregate (such as a page) that reads its own
 *                 rows and states how they are classified, logged and guarded
 *   5. commit     one D1 batch:
 *                   admission  authority, policy, every snapshot unchanged,
 *                              plus the plan's own pre-write checks
 *                   writes     each followed by its exact changes() check
 *                   evidence   audit write + exact receipt guard
 *                   expect     writer's postconditions
 *                   re-admit   authority and policy again, so business
 *                              triggers inside the batch cannot slip past
 *                   returning  optional final SELECT, returned by commit
 *   Service plans can group writes with individually classified receipts in
 *   transaction order. A group can record a denial without a business write.
 *   All receipts are verified again before returning the result rows.
 *   6. fail       any error: coarse outage incident, then the writer's error.
 *                 Errors the writer marks as its own (validation, policy
 *                 refusals) pass through unchanged, with no incident.
 *
 * A null plan or a session plan without writes commits only the admission
 * guards. A service plan can also verify an empty result.
 */

type Binding = string | number | null;
type WriteBinding = Binding | { document: string };

export interface SnapshotSpec {
  table: string;
  fields: string[];
  /** Fixed trusted SQL; values go in args. */
  where: string;
  args: Binding[];
  /** Fixed trusted SQL; defaults to the first field. */
  order?: string;
  /** How reading these rows is logged before the change; null when another
   *  read (such as the page they belong to) is the logged one. */
  read: (Omit<PendingRead, 'ids' | 'count'> & { id: (row: Record<string, Binding>) => string | Promise<string> }) | null;
}

/** What a source hands back: its rows, the containers that classify them,
 *  the reads to log and its admission guards. Request reads keep the usual
 *  page-read classification and attribution from the request buffer. */
export interface LoadedSource<T> {
  value: T;
  classify: Containers;
  reads: PendingRead[];
  readMode?: 'request';
  guards: () => D1PreparedStatement[];
}

/** An aggregate that loads its own consistent snapshot. Its reads should share
 *  a batch with `policyGuard()` so they happened under the guarded policy. */
export interface SnapshotSource<T> {
  load(context: { c: AppContext; authority: AccessAuthorization; policy: DataClassMap; policyGuard: () => D1PreparedStatement }): Promise<LoadedSource<T>>;
}

export interface PlannedWrite {
  /** Fixed trusted SQL; values go in args. */
  sql: string;
  /** A document payload is bound directly without counting its
   *  contents against the row manifest budget. */
  args: WriteBinding[];
  /** Rows this statement must change; defaults to 1. */
  changes?: number;
}

/** A container to classify, or a class the writer derived from `tools.policy`
 *  (for example every page type a wildcard grant covers). */
type Containers = Array<[ContainerKind, string] | DataClass>;

interface MutationChecks {
  /** Checks run after admission and before the writes, such as an ID
   *  allocator still matching what decide read. */
  admit?: D1PreparedStatement[];
  /** Postconditions after the writes. `since` is the database clock read just
   *  before the batch, for rows whose timestamps the transaction sets. */
  expect: (since: string) => D1PreparedStatement[];
  /** Fixed trusted SQL run last in the batch. */
  returning?: { sql: string; args: Binding[] };
}

export interface MutationPlan extends MutationChecks {
  writes: PlannedWrite[];
  evidence: { entry: AuditEntry; targetIds?: string[] };
  /** Containers the change itself touches, raising the evidence class. */
  classify?: Containers;
}

export interface ServiceMutationGroup {
  check?: D1PreparedStatement[];
  writes?: PlannedWrite[];
  evidence: { entry: AuditEntry; dataClass: DataClass | 'none' };
}

export interface ServiceMutationPlan extends MutationChecks {
  /** The writer bounds its business manifests before submitting the groups. */
  groups: ServiceMutationGroup[];
}

interface SnapshotMutationSpec<S extends Record<string, SnapshotSpec>> {
  classify: Containers | ((rows: Snapshots<S>) => Containers);
  snapshot: S;
  /** The writer's own refusal, so its route keeps its existing 503 body. */
  unavailable: () => Error;
  /** Errors that are the writer's own answer, such as invalid input. */
  passthrough?: (error: unknown) => boolean;
}

export interface MutationSpec<S extends Record<string, SnapshotSpec>> extends SnapshotMutationSpec<S> {
  permission: Exclude<AccessAuthorization['capability'], 'authenticated'> | 'self';
  /** Record a writer's existing policy denial when fresh authority refuses it. */
  onDenied?: () => Promise<void>;
}

type Row = Record<string, Binding>;
export type Snapshots<S> = { [K in keyof S]: Row[] };

export interface DecideTools {
  /** Transaction clock, read once; `columns` is fixed trusted SQL. */
  clock(columns?: string): Promise<{ now: string } & Record<string, Binding>>;
  /** Snapshots that depend on the first rows. `classify` (fixed, or from the
   *  rows just read) adds containers to both these reads and the change's
   *  evidence. Guarded at admission. */
  snapshot(specs: SnapshotSpec[], classify?: Containers | ((rows: Array<Array<Record<string, Binding>>>) => Containers)): Promise<Array<Array<Record<string, Binding>>>>;
  /** Load a source as a follow-up snapshot. */
  source<T>(source: SnapshotSource<T>): Promise<T>;
  /** The change's evidence class from everything classified so far. */
  dataClass(): DataClass | 'none';
  /** The classification policy this change is guarded by. Read only. */
  policy: DataClassMap;
}

export interface AuditedMutation<S> {
  rows: Snapshots<S>;
  commit(decide: Decide<S, MutationPlan>): Promise<Row | undefined>;
}

type Decide<S, P> = (rows: Snapshots<S>, tools: DecideTools) => P | null | Promise<P | null>;

interface MutationAuthority {
  policy: DataClassMap;
  check(): D1PreparedStatement[];
  session?: AccessAuthorization;
}

export async function beginAuditedMutation<S extends Record<string, SnapshotSpec>>(c: AppContext, spec: MutationSpec<S>): Promise<AuditedMutation<S>> {
  const mutation = await prepareAuditedMutation(c, spec, async () => {
    const { authority, policy } = await captureMutationAuthority(c, spec.permission, spec.onDenied);
    return { policy, check: () => [authority.guard()], session: authority };
  });
  return {
    rows: mutation.rows,
    async commit(decide) {
      const result = await mutation.commit(decide);
      if (result && !result[0]) return mutation.fail(new Error('Mutation result unavailable'));
      return result?.[0];
    },
  };
}

/** The service writer captures and validates its credential before reading
 *  the request body. Use that same authority throughout the transaction. */
export async function beginServiceAuditedMutation<S extends Record<string, SnapshotSpec>>(c: AppContext, spec: SnapshotMutationSpec<S>,
  authority: MutationAuthority & { actor: AuditActor }) {
  const mutation = await prepareAuditedMutation(c, spec, async () => authority, authority.actor);
  return {
    rows: mutation.rows,
    async commit(decide: Decide<S, ServiceMutationPlan>): Promise<Row[]> {
      return await mutation.commit(decide) ?? [];
    },
  };
}

async function prepareAuditedMutation<S extends Record<string, SnapshotSpec>>(c: AppContext, spec: SnapshotMutationSpec<S>,
  authorize: () => Promise<MutationAuthority>, serviceActor?: AuditActor) {
  const actor = serviceActor ?? contextActor(c);
  const fail = async (error: unknown): Promise<never> => {
    if (spec.passthrough?.(error)) throw error;
    await recordAuditOutage(c.env, 'health', [], actor, undefined, { captureIncomplete: true });
    throw spec.unavailable();
  };

  // 1. gate (outside the try: a refusal here is reported by the caller's route)
  assertRegulatedWritesAllowed(c.env);

  let prepared;
  try {
    // 2. authorize
    const authority = await authorize();
    const { policy, session } = authority;

    // 3. snapshot: one round trip for every snapshot, behind the policy guard
    let containers: Containers = [];
    const classOf = (more: Containers = []) => strongestClass([...containers, ...more].map(item => typeof item === 'string' ? item : classFor(policy, item[0], item[1])));
    const guards: Array<() => D1PreparedStatement[]> = [];
    /** Classify, log and guard what was read; shared by table snapshots and sources. */
    const settle = async (classify: Containers, reads: PendingRead[], admit: () => D1PreparedStatement[], mode?: 'request') => {
      containers = [...containers, ...classify];
      if (mode === 'request') {
        reads.forEach(recordRead);
      } else if (reads.length) {
        const dataClass = classOf();
        const raised = reads.map(read => ({ minimumClass: dataClass === 'none' ? undefined : dataClass, ...read }));
        await auditBackgroundReads(c.env, raised, actor, { policy });
      }
      if ((reads.length || mode === 'request') && await flushReadAudit(c)) throw new Error('Mutation read evidence unavailable');
      guards.push(admit);
    };
    const read = async (specs: SnapshotSpec[], classify: (rows: Array<Array<Record<string, Binding>>>) => Containers) => {
      const results = specs.length ? await c.env.DB.batch<{ snapshot: string }>([
        classificationPolicyGuard(c.env, policy),
        ...specs.map(({ table, fields, where, args, order }) => snapshotStatement(c, table, fields, where, args, order)),
      ]) : [];
      const captured = specs.map((s, index) => snapshotRows<Record<string, Binding>>(s.fields, results[index + 1].results[0]));
      const reads: PendingRead[] = [];
      for (const [index, { read }] of specs.entries()) {
        if (!read) continue;
        const { id, ...pending } = read;
        reads.push({ ...pending, ids: await Promise.all(captured[index].map(id)), count: captured[index].length });
      }
      await settle(classify(captured), reads, () => specs.map(({ table, fields, where, args }, index) => guard(c, table, fields, captured[index], where, args)));
      return captured;
    };
    const load = async <T>(source: SnapshotSource<T>) => {
      if (!session) throw new Error('Snapshot source requires session authority');
      const loaded = await source.load({ c, authority: session, policy, policyGuard: () => classificationPolicyGuard(c.env, policy) });
      await settle(loaded.classify, loaded.reads, loaded.guards, loaded.readMode);
      return loaded.value;
    };
    const names = Object.keys(spec.snapshot) as Array<keyof S>;
    const rows = {} as Snapshots<S>;
    await read(names.map(name => spec.snapshot[name]), captured => {
      names.forEach((name, index) => { rows[name] = captured[index]; });
      return typeof spec.classify === 'function' ? spec.classify(rows) : spec.classify;
    });

    const recheck = () => [...authority.check(), classificationPolicyGuard(c.env, policy)];
    const admission = () => [...recheck(), ...guards.flatMap(g => g())];
    prepared = { policy, classOf, rows, admission, read, load, recheck };
  } catch (error) {
    return fail(error);
  }
  const { policy, classOf, rows, admission, read, load, recheck } = prepared;

  return {
    rows,
    fail,
    async commit(decide: Decide<S, MutationPlan | ServiceMutationPlan>): Promise<Row[] | undefined> {
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
          snapshot: (specs, classify = []) => read(specs, rows => typeof classify === 'function' ? classify(rows) : classify),
          source: load,
          dataClass: () => classOf(),
          policy,
        };
        const plan = await decide(rows, tools);
        if (plan && 'writes' in plan) {
          json(plan.writes.map(write => ({
            ...write,
            args: write.args.map(value => value === null || typeof value !== 'object' ? value : null),
          })));
        }
        if (await flushReadAudit(c)) throw new Error('Mutation read evidence unavailable');
        if (!plan || (!('groups' in plan) && !plan.writes.length)) {
          await c.env.DB.batch(admission());
          return undefined;
        }

        // 5. commit
        const since = clock ?? await tools.clock();
        const operationId = crypto.randomUUID();
        const withOperation = (entry: AuditEntry) => ({ ...entry, detail: { operation_id: operationId, ...entry.detail } });
        const prepareWrites = (writes: PlannedWrite[]) => writes.flatMap(({ sql, args, changes = 1 }) => [
          c.env.DB.prepare(sql).bind(...args.map(value => value !== null && typeof value === 'object' ? value.document : value)),
          abortIf(c.env, 'changes() <> ?', [changes]),
        ]);
        const statements = [...admission(), ...plan.admit ?? []];
        const receiptChecks: D1PreparedStatement[] = [];
        if ('groups' in plan) {
          if (!serviceActor) throw new Error('Mutation groups require service authority');
          for (const { check, writes, evidence } of plan.groups) {
            const receipt = serviceMutationAuditEvidence(c.env, withOperation(evidence.entry), serviceActor, evidence.dataClass, policy, c);
            statements.push(...check ?? [], ...prepareWrites(writes ?? []), receipt.write, receipt.guard);
            receiptChecks.push(receipt.verify());
          }
        } else {
          const { entry, targetIds } = plan.evidence;
          const receipt = attributedMutationAuditEvidence(c.env, c.get('user'), withOperation(entry),
            classOf(plan.classify), policy, { context: c, targetIds });
          statements.push(...prepareWrites(plan.writes), receipt.write, receipt.guard);
        }
        const results = await c.env.DB.batch([
          ...statements,
          ...plan.expect(since.now),
          ...receiptChecks,
          ...recheck(),
          ...(plan.returning ? [c.env.DB.prepare(plan.returning.sql).bind(...plan.returning.args)] : []),
        ]);
        if (!plan.returning) return undefined;
        return results.at(-1)!.results as Row[];
      } catch (error) {
        return fail(error);
      }
    },
  };
}
