import { recordRead, ReadAuditUnavailableError } from '../../core/http/access-log';

/** Each returned type summary carries sensitivity from the same grouped read. */
export async function countTrashMetadataByType(db: D1DatabaseClient): Promise<{ page_type: string | null; cnt: number }[]> {
  const rows = await db.prepare(`SELECT p.page_type, COUNT(*) AS cnt,
    COALESCE((SELECT MAX(level) FROM (
      SELECT level FROM data_class_floors WHERE container_kind = 'page_type' AND container_key = COALESCE(p.page_type, 'default')
      UNION ALL SELECT f.level FROM trash_pages sp JOIN page_sensitivity_floors f ON f.uuid = sp.uuid
        WHERE COALESCE(sp.page_type, 'default') = COALESCE(p.page_type, 'default')
    )), 0) AS source_level
    FROM trash_pages p GROUP BY p.page_type ORDER BY cnt DESC`).all<{ page_type: string | null; cnt: number; source_level: number }>();
  for (const row of rows.results) {
    if (![0, 1, 2].includes(row.source_level)) throw new ReadAuditUnavailableError();
    recordRead({ action: 'page.trash-summary', kind: 'page_type', key: row.page_type ?? 'default', targetType: 'query', ids: [], count: row.cnt,
      minimumClass: row.source_level === 2 ? 'phi' : row.source_level === 1 ? 'pii' : undefined });
  }
  return rows.results.map(({ page_type, cnt }) => ({ page_type, cnt }));
}
