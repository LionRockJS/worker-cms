// Readers yield the position immediately after each item. A part which fills mid-page
// resumes after its last delivered item, including when the same cursor is retried.
import type { AppContext } from './http/context';
import {
  configBundleBytes, CONFIG_TRANSFER_FORMAT, CONFIG_TRANSFER_VERSION, MAX_CONFIG_BUNDLE_BYTES,
  type ConfigTransferSection,
} from './config-transfer';

export interface ExportRecord {
  key: string;
  label: string;
  item: unknown;
}

export const EXPORT_READ_BATCH = 8;
const MAX_PART_RECORDS = 64;

export interface ExportPosition {
  section: string;
  after: string;
}

export class ExportHierarchyError extends Error {
  constructor(table: string) { super(`The ${table} hierarchy changed or contains a loop. Check it and restart the export.`); }
}

export class OversizedConfigRecord extends Error {
  constructor(readonly section: ConfigTransferSection, readonly label: string) { super('Settings record exceeds the file limit'); }
}

/** Scan only the next few rows. The SQL orders by the same key it seeks on. */
export async function* exportRows<T>(c: AppContext, sql: string, after: string,
  convert: (row: T) => ExportRecord): AsyncGenerator<ExportRecord> {
  for (;;) {
    const { results } = await c.env.DB.prepare(sql).bind(after, EXPORT_READ_BATCH).all<T>();
    // Conversion also records classified reads for the entire fetched page.
    for (const record of results.map(convert)) {
      after = record.key;
      yield record;
    }
    if (results.length < EXPORT_READ_BATCH) return;
  }
}

/** Indexed preorder traversal. Seek to the first child, or the next sibling of
 * the current node or its nearest ancestor. Only the next node's payload is read. */
export async function* exportTree<T>(c: AppContext, table: 'tags' | 'locales', after: string,
  convert: (row: T) => ExportRecord): AsyncGenerator<ExportRecord> {
  const [id, parent] = table === 'tags' ? ['id', 'parent_tag'] : ['code', 'fallback_code'];
  const fields = table === 'tags' ? 't.*, (SELECT slug FROM tags WHERE id=t.parent_tag) AS parentSlug' : 't.*';
  // rowid follows the parent index's implicit tiebreaker, even when public ids
  // sort differently. The cursor also counts emitted rows to detect legacy cycles.
  const [last, emitted] = after.split(':');
  let previous = Number(last);
  let count = Number(emitted ?? 0);
  const root = `SELECT rowid FROM ${table} WHERE ${parent} IS NULL ORDER BY rowid LIMIT 1`;
  const next = `WITH RECURSIVE ancestors(pos, parent, depth, path) AS (
    SELECT rowid, ${parent}, 0, '/' || rowid || '/' FROM ${table} WHERE rowid=?
    UNION ALL SELECT t.rowid, t.${parent}, a.depth+1, a.path || t.rowid || '/' FROM ${table} t
      JOIN ancestors a ON t.${id}=a.parent WHERE instr(a.path, '/' || t.rowid || '/')=0
  ) SELECT COALESCE(
    (SELECT rowid FROM ${table} WHERE ${parent}=(SELECT ${id} FROM ${table} WHERE rowid=?) ORDER BY rowid LIMIT 1),
    (SELECT sibling FROM (SELECT depth, (SELECT s.rowid FROM ${table} s
       WHERE s.${parent} IS a.parent AND s.rowid>a.pos ORDER BY s.rowid LIMIT 1) AS sibling
     FROM ancestors a) WHERE sibling IS NOT NULL ORDER BY depth LIMIT 1))`;
  for (;;) {
    const row = await c.env.DB.prepare(`SELECT t.rowid AS position, ${fields} FROM ${table} t WHERE t.rowid=(${previous ? next : root})`)
      .bind(...(previous ? [previous, previous] : [])).first<T & { position: number }>();
    if (!row) {
      const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n');
      if (count !== total) throw new ExportHierarchyError(table);
      return;
    }
    previous = row.position;
    count++;
    yield { ...convert(row), key: `${previous}:${count}` };
  }
}

export async function exportConfigPart(c: AppContext, selected: ConfigTransferSection[], start: ExportPosition | undefined, exportedAt: string) {
  const sections: Record<string, unknown[]> = {};
  const bundle = { format: CONFIG_TRANSFER_FORMAT, version: CONFIG_TRANSFER_VERSION, exportedAt,
    source: c.env.CANONICAL_ORIGIN || new URL(c.req.url).origin, sections };
  let bytes = configBundleBytes(JSON.stringify(bundle));
  let count = 0;
  let next: ExportPosition | undefined;
  for (const section of selected.slice(start ? selected.findIndex(s => s.id === start.section) : 0)) {
    let after = start?.section === section.id ? start.after : '';
    const overhead = configBundleBytes(JSON.stringify(section.id)) + 3 + (Object.keys(sections).length ? 1 : 0);
    if (bytes + overhead > MAX_CONFIG_BUNDLE_BYTES) { next = { section: section.id, after }; break; }
    bytes += overhead;
    const items: unknown[] = sections[section.id] = [];
    for await (const record of section.exportRecords(c, after)) {
      const added = configBundleBytes(JSON.stringify(record.item)) + (items.length ? 1 : 0);
      if (count >= MAX_PART_RECORDS || bytes + added > MAX_CONFIG_BUNDLE_BYTES) {
        if (!count && Object.keys(sections).length === 1) throw new OversizedConfigRecord(section, record.label);
        next = { section: section.id, after };
        break;
      }
      items.push(record.item);
      bytes += added;
      count++;
      after = record.key;
    }
    if (next) break;
  }
  return { body: JSON.stringify(bundle), next };
}
