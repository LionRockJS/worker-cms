import type { Env } from '../../types';

/** A read-only D1 batch assertion. SQLite short-circuits CASE; deliberately
 * malformed JSON throws only when the invariant fails, aborting the batch.
 * The predicate must be fixed trusted SQL; supply all variable values as binds. */
export function abortIf(env: Pick<Env,'DB'>, predicate: string, bindings: readonly (string | number | null)[] = []): D1PreparedStatement {
  return env.DB.prepare(`SELECT CASE WHEN (${predicate}) THEN json('{') ELSE NULL END`).bind(...bindings);
}
