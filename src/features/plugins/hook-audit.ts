import type { Env, JWTPayload } from '../../types';
import type { AuditActor } from '../../core/db/audit';
import { writeBackgroundAuditRows } from '../../core/db/audit';
import { prepareReadAudits, type PendingRead } from '../../core/http/access-log';
import { resolveDataClasses } from '../../core/db/data-classes';
import { listPageTypeApprovals, pageTypeScopeAllows } from './page-types';
import type { ResolvedPlugin } from './types';
import type { HookEvent, HookPage } from './hooks';

/** Persist the delivery intent before bytes leave the host. A hook subscription
 * alone never grants PHI access; reuse declared, host-approved page scopes. */
export async function auditHookDelivery(
  env: Env, plugin: ResolvedPlugin, user: JWTPayload | undefined,
  event: HookEvent, pages: HookPage[], actor: AuditActor,
): Promise<void> {
  const classes = await resolveDataClasses(env, true);
  if (!classes.ok) throw new Error('Hook classification unavailable');
  const missingTypes = pages.filter(page => page.page_type == null);
  const resolved = new Map<number, string>();
  if (missingTypes.length) {
    const rows = await env.DB.prepare('SELECT id, page_type FROM pages WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(missingTypes.map(page => page.id))).all<{ id: number; page_type: string | null }>();
    for (const row of rows.results) resolved.set(row.id, row.page_type ?? 'default');
  }
  const types = new Map<string, string[]>();
  for (const page of pages) {
    let type = page.page_type;
    if (type == null) {
      type = resolved.get(page.id);
      if (type == null && (classes.size || env.REGULATED_MODE === 'true')) throw new Error('Hook page classification unknown');
    }
    const key = type ?? 'default';
    const ids = types.get(key) ?? [];
    ids.push(String(page.id));
    types.set(key, ids);
  }
  const detail = { destination: plugin.manifest.id, operation: event, delivery_id: crypto.randomUUID(), phase: 'intent' };
  const reads: PendingRead[] = [...types].map(([key, ids]) => ({
    action: event === 'delete' ? 'page.trash-hook' : 'page.hook', kind: 'page_type', key,
    targetType: 'page', ids, count: ids.length, actor, detail, eventClass: 'export',
    uuidById: Object.fromEntries(pages.filter(page => page.uuid && ids.includes(String(page.id))).map(page => [String(page.id), page.uuid!])),
  }));
  // Ingestion has not copied published tag links into the new draft. Preserve
  // that source's taxonomy classification when disclosing its metadata.
  if (event === 'submission') {
    for (const [key, ids] of types) {
      const uuids = pages.filter(page => ids.includes(String(page.id)) && page.uuid).map(page => page.uuid!);
      if (uuids.length) reads.push({ action: 'submission.hook', kind: 'page_type', key, targetType: 'published_page',
        ids: uuids, count: uuids.length, actor, detail, eventClass: 'export' });
    }
  }
  reads.push({ action: 'plugin.hook', kind: 'plugin', key: plugin.manifest.id,
    targetType: 'plugin', ids: [plugin.manifest.id], count: 1, actor, detail, eventClass: 'export' });
  if (user) reads.push({ action: 'user.hook', kind: 'table', key: 'users', targetType: 'users',
    ids: [user.sub], count: 1, actor, detail, eventClass: 'export' });
  const groups = await prepareReadAudits(env, reads, actor);
  if (groups.some(group => group.strict)) {
    const approvals = await listPageTypeApprovals(env.DB, plugin.manifest.id);
    const approved = new Set(approvals.filter(a => a.access === 'read' || a.access === 'write').map(a => a.page_type));
    const declared = new Set([
      ...Object.keys(plugin.manifest.contentTypes?.blueprint ?? {}),
      ...(plugin.manifest.contentTypes?.readTypes ?? []), ...(plugin.manifest.contentTypes?.writeTypes ?? []),
    ]);
    if ([...types.keys()].some(type => !pageTypeScopeAllows(approved, type) || !pageTypeScopeAllows(declared, type))) {
      throw new Error('PHI hook destination is not approved for the page types');
    }
  }
  // Outbound transfers await even PII audit writes. A failed evidence sink
  // cannot silently downgrade a disclosure to best-effort delivery.
  for (const group of groups) await writeBackgroundAuditRows(env, group.rows, group.actor, true);
}
