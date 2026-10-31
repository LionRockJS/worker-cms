// ============================================================
// Which media objects may never be served publicly.
//
// Classifying a media prefix used to make its deliveries *audited* and nothing
// more, so an ordinarily uploaded object under a `phi` prefix stayed publicly
// fetchable by anyone holding the URL, under a one-year cache header. Recording
// a disclosure is not preventing one.
//
// Two layers, because neither alone is enough:
//
//   - this classification lookup, which covers objects already in the bucket
//     when their prefix is classified;
//   - the `cmsPrivate` object marker written at upload time, which survives
//     independently of the table and is what the public route has always
//     honoured.
//
// The lookup FAILS CLOSED: a classification it cannot read yields `unknown`,
// and the caller withholds rather than guesses. The cost is loud — public media
// stops on a database that never ran the `data_classes` migration — which is
// the point: an installation that cannot say which objects are regulated should
// not be handing objects to anonymous callers. The fix is the migration it
// already owes, and the failure says so instead of leaking quietly.
// ============================================================

import { inventoried } from '../../core/http/regulated-profile';
import type { Env } from '../../types';
import { classFor, resolveDataClasses } from '../../core/db/data-classes';

/** What may be done with one object on an unauthenticated route. */
export type MediaDisposition =
  /** Not regulated: serve it as before. */
  | 'public'
  /** Regulated: the public routes must not serve it at all. */
  | 'withheld'
  /** Classification could not be read, so neither can be ruled out. */
  | 'unknown';

/** The class withheld from public delivery. `pii` is not: the CMS legitimately
 *  serves public photographs of people, and withholding those would make the
 *  classification screen unusable for ordinary contact data. */
const REGULATED_CLASS = 'phi';

/**
 * One classification lookup (already cached for the request by the read path),
 * returning a synchronous verdict per key. Prefix matching is longest-first, so
 * `upload/records/private/` beats `upload/`.
 */
export async function mediaClassifier(env: Env): Promise<(key: string) => MediaDisposition> {
  const map = await resolveDataClasses(env);
  if (!map.ok) return () => 'unknown';
  return (key) => !inventoried(env, 'media_prefix', key) ? 'unknown'
    : (classFor(map, 'media_prefix', key) === REGULATED_CLASS ? 'withheld' : 'public');
}

/** The verdict for a single key. */
export async function mediaDisposition(env: Env, key: string): Promise<MediaDisposition> {
  return (await mediaClassifier(env))(key);
}
