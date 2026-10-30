// ============================================================
// The publication gate for regulated containers.
//
// PHI is not published. Minimization (projection.ts) thins what a published
// consumer receives, but it is declared by plugins and returns the whole lect
// when no rule exists, so it cannot carry this: a disabled plugin would silently
// restore full disclosure. This gate is host-owned, runs before any snapshot is
// built, and refuses the page outright.
//
// A page is regulated when either container it belongs to is classified `phi`:
//
//   - its page type, the obvious case;
//   - a taxonomy any of its tags belongs to, because the *association* is the
//     regulated fact — a page tagged from a classified taxonomy discloses it
//     even when the page's own type is ordinary, and tag links travel in the
//     snapshot.
//
// This gate fails CLOSED, as do classified reads. Publication is
// an explicit, non-reversible disclosure: refusing it until
// classification can be read again costs an operator a retry, while guessing
// costs a breach. Nothing gates *un*publication — withdrawing a page that was
// published before it was classified has to stay possible.
// ============================================================

import type { Env, Page } from '../../types';
import { classFor, resolveDataClasses, type DataClassMap } from '../db/data-classes';

/** Why publication was refused. `regulated` and `classification_unavailable`
 *  are this gate's; `submission` is the pre-existing structural refusal. */
export type PublishRefusal = 'submission' | 'regulated' | 'classification_unavailable';

/** The class that may never be published. */
const REGULATED_CLASS = 'phi';

/** Bound-parameter budget for one read, shared between page ids and taxonomies. */
const BOUND_PARAM_BUDGET = 90;

export interface RegulatedPages {
  /** Ids that may not be published. Meaningless when `unavailable` is set. */
  ids: Set<number>;
  /** Classification could not be established, so no page can be shown to be
   *  clean and the caller must refuse all of them. */
  unavailable: boolean;
}

/** Taxonomy slugs classified as regulated. Usually none, which costs no query. */
function regulatedTaxonomies(map: DataClassMap): string[] {
  const prefix = 'taxonomy:';
  return [...map.exact.entries()]
    .filter(([key, dataClass]) => dataClass === REGULATED_CLASS && key.startsWith(prefix))
    .map(([key]) => key.slice(prefix.length));
}

/**
 * Which of these pages hold regulated data. One classification lookup (already
 * cached for the request by the read path) plus, only when a taxonomy is
 * classified, one tag read per chunk.
 */
export async function regulatedPages(env: Env, pages: Page[]): Promise<RegulatedPages> {
  const ids = new Set<number>();
  if (!pages.length) return { ids, unavailable: false };

  const map = await resolveDataClasses(env);
  if (!map.ok) return { ids, unavailable: true };

  for (const page of pages) {
    if (classFor(map, 'page_type', page.page_type ?? '') === REGULATED_CLASS) ids.add(page.id);
  }

  const taxonomies = regulatedTaxonomies(map);
  if (!taxonomies.length) return { ids, unavailable: false };

  // Pages already refused on their type need no tag read.
  const candidates = pages.filter((page) => !ids.has(page.id)).map((page) => page.id);
  const chunkSize = Math.max(1, BOUND_PARAM_BUDGET - taxonomies.length);
  for (let index = 0; index < candidates.length; index += chunkSize) {
    const chunk = candidates.slice(index, index + chunkSize);
    try {
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT pt.page_id FROM page_tags pt
           JOIN tags t ON t.id = pt.tag_id
          WHERE pt.page_id IN (${chunk.map(() => '?').join(',')})
            AND t.taxonomy_slug IN (${taxonomies.map(() => '?').join(',')})`,
      ).bind(...chunk, ...taxonomies).all<{ page_id: number }>();
      for (const row of results) ids.add(row.page_id);
    } catch (error) {
      // A tags table predating `taxonomy_slug` — the legacy shape the tags
      // admin probes for — cannot answer this, and a taxonomy IS classified,
      // so nothing in the slice can be shown to be clean.
      console.error('Publish gate: taxonomy classification unavailable for this schema', error);
      return { ids, unavailable: true };
    }
  }

  return { ids, unavailable: false };
}
