// ============================================================
// Database-defined block types.
//
// A row in `block_types` is the runtime-editable equivalent of a
// block defined in cms-config.ts `blocks`: a named blueprint that
// merges into the effective CmsConfig's `blocks` map via
// resolveCmsConfig() (src/core/db/content-config.ts).
// ============================================================

import type { BlueprintEntry } from '../../cms-config';
import type { BlockType } from '../../types';
import type { ContributedContentTypes } from '../extensions';

/** Loads database-defined block types, including retained rows in disabled profiles. */
export async function listDbBlockTypes(db: D1DatabaseClient): Promise<BlockType[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM block_types ORDER BY weight ASC, name ASC')
      .all<BlockType>();
    return results;
  } catch (error) {
    // Fresh profiles without runtime content types omit this table.
    if (error instanceof Error && /no such table: block_types(?:[:\s]|$)/i.test(error.message)) return [];
    throw error;
  }
}

/** Parses a JSON column into the expected shape, or returns the fallback. */
function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Converts a block_types row into a content-type fragment that contributes a
 * single named block, so it flows through the same mergeContentTypes() path as
 * plugin fragments. Malformed JSON is treated as empty rather than throwing.
 */
export function dbBlockTypeToContentTypes(row: BlockType): ContributedContentTypes {
  return {
    blocks: { [row.slug]: parseJson<BlueprintEntry[]>(row.blueprint, []) },
  };
}
