import { queryFingerprint, recordRead, ReadAuditUnavailableError } from '../http/access-log';

/** Return a count and its sensitivity from the same source statement. The
 * namespace scan also protects zero-result probes of a type holding floors. */
export async function countPageMetadata(db: D1DatabaseClient, where: string, params: unknown[], options: {
  types?: string[]; source?: 'pages' | 'trash_pages'; action?: string;
} = {}): Promise<number> {
  const source = options.source ?? 'pages';
  const scope = options.types ? 'AND container_key IN (SELECT value FROM json_each(?))' : '';
  const pageScope = options.types ? "WHERE COALESCE(sp.page_type, 'default') IN (SELECT value FROM json_each(?))" : '';
  const bindings = options.types ? [JSON.stringify(options.types), JSON.stringify(options.types), ...params] : params;
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE((SELECT MAX(level) FROM (
    SELECT level FROM data_class_floors WHERE container_kind = 'page_type' ${scope}
    UNION ALL SELECT f.level FROM ${source} sp JOIN page_sensitivity_floors f ON f.uuid = sp.uuid ${pageScope}
  )), 0) AS source_level FROM ${source} p WHERE ${where || '1'}`).bind(...bindings).first<{ total: number; source_level: number }>();
  if (!row || ![0, 1, 2].includes(row.source_level)) throw new ReadAuditUnavailableError();
  const single = options.types?.length === 1 ? options.types[0] : undefined;
  recordRead({ action: options.action ?? (source === 'trash_pages' ? 'page.trash-count' : 'page.count'),
    kind: single ? 'page_type' : 'table', key: single ?? source, targetType: 'query', ids: [], count: row.total,
    minimumClass: row.source_level === 2 ? 'phi' : row.source_level === 1 ? 'pii' : undefined,
    queryFingerprint: await queryFingerprint(JSON.stringify([source, where, params, options.types])),
  });
  return row.total;
}

