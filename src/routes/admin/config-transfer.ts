// Settings export/import screen (/admin/settings/transfer).
import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import type { Env, Variables } from '../../types';
import type { AppContext } from '../../core/http/context';
import { requirePermission } from '../../core/auth/guards';
import { userCan } from '../../core/auth/permissions';
import { exportConfigPart, ExportHierarchyError, OversizedConfigRecord, type ExportPosition } from '../../core/config-export';
import {
  MAX_CONFIG_BUNDLE_BYTES,
  ConfigTransferItemError, configBundleBytes, parseConfigBundle,
  type ConfigTransferBundle, type ConfigTransferPlanItem, type ConfigTransferSection,
} from '../../core/config-transfer';
import { TagParentCycleError } from '../../core/evidence/taxonomy-mutation-evidence';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { flushReadAudit } from '../../core/http/access-log';
import { renderPage } from '../../core/render/chrome';
import {
  configTransferPage,
  type ConfigTransferPreviewSection,
  type ConfigTransferResult,
} from '../../core/templates/config-transfer';
import { featureConfigTransferSections } from '../../features/services';
import { systemSettingsSection } from './config-transfer/system-settings';
import { tagsSection } from './config-transfer/tags';
import { taxonomiesSection } from './config-transfer/taxonomy';

/** Changes applied per request; D1 calls per change are bounded, the total is not. */
export const MAX_CHANGES_PER_REQUEST = 25;

/** Every section this CMS can export or import, in apply order. */
export function configTransferSections(): ConfigTransferSection[] {
  return [systemSettingsSection, taxonomiesSection, tagsSection, ...featureConfigTransferSections()].sort((a, b) => a.order - b.order);
}

async function permittedSections(c: AppContext): Promise<ConfigTransferSection[]> {
  const sections = configTransferSections();
  const allowed = await Promise.all(sections.map((section) => userCan(c, section.permission)));
  return sections.filter((_, index) => allowed[index]);
}

const ACTION_KEYS: Record<ConfigTransferPlanItem['action'], string> = {
  create: 'settings.transfer.actions.create',
  update: 'settings.transfer.actions.update',
  unchanged: 'settings.transfer.actions.unchanged',
  skip: 'settings.transfer.actions.skip',
};

async function previewSections(c: AppContext, bundle: ConfigTransferBundle): Promise<ConfigTransferPreviewSection[]> {
  const all = configTransferSections();
  const permitted = new Set((await permittedSections(c)).map((section) => section.id));
  const known = all.filter((section) => Object.hasOwn(bundle.sections, section.id));
  const unknown = Object.keys(bundle.sections).filter((id) => !all.some((section) => section.id === id));
  const rows: ConfigTransferPreviewSection[] = [];
  for (const section of known) {
    const items = bundle.sections[section.id];
    const empty = { create: 0, update: 0, unchanged: 0, skip: 0 };
    if (!permitted.has(section.id)) {
      rows.push({ id: section.id, labelKey: section.labelKey, unavailableKey: 'settings.transfer.unavailable.no_permission',
        noteKey: '', changes: 0, counts: empty, items: [] });
      continue;
    }
    const plans = await section.plan(c, items);
    const counts = { ...empty };
    for (const plan of plans) counts[plan.action] += 1;
    rows.push({
      id: section.id, labelKey: section.labelKey, unavailableKey: '', noteKey: section.noteKey ?? '',
      changes: counts.create + counts.update, counts,
      items: plans.map((plan) => ({ label: plan.label, action: plan.action, actionKey: ACTION_KEYS[plan.action], note: plan.note ?? '' })),
    });
  }
  for (const id of unknown) {
    rows.push({ id, labelKey: '', unavailableKey: 'settings.transfer.unavailable.not_installed', noteKey: '', changes: 0,
      counts: { create: 0, update: 0, unchanged: 0, skip: 0 }, items: [] });
  }
  return rows;
}

/** Applies planned changes section by section, re-planning each section after
 *  the previous one so later sections see what earlier ones created. */
export async function applyConfigBundle(c: AppContext, bundle: ConfigTransferBundle, selected: ReadonlySet<string>,
  budget = MAX_CHANGES_PER_REQUEST): Promise<ConfigTransferResult> {
  assertRegulatedWritesAllowed(c.env);
  const result: ConfigTransferResult = { applied: 0, remaining: 0, failed: [], stopped: '' };
  const attemptId = crypto.randomUUID();
  let item = 0;
  for (const section of await permittedSections(c)) {
    if (!selected.has(section.id) || !Object.hasOwn(bundle.sections, section.id)) continue;
    const plans = (await section.plan(c, bundle.sections[section.id])).filter((plan) => plan.apply);
    for (const plan of plans) {
      if (result.stopped || result.applied >= budget) { result.remaining += 1; continue; }
      c.set('configImport', { attempt_id: attemptId, section: section.id, item: ++item });
      try {
        await plan.apply!();
        result.applied += 1;
      } catch (error) {
        if (error instanceof ConfigTransferItemError || error instanceof TagParentCycleError) {
          result.failed.push({ sectionLabelKey: section.labelKey, label: plan.label, message: error.message });
        } else {
          // Audit or policy outages refuse every later write too; stop rather than retry each.
          console.error('[cms] settings import stopped', error);
          result.stopped = `${plan.label}: this change could not be saved.`;
          result.remaining += 1;
        }
      } finally {
        c.set('configImport', undefined);
      }
    }
  }
  return result;
}

async function readBundle(form: FormData): Promise<ConfigTransferBundle | null> {
  const upload = form.get('bundle');
  let text = typeof form.get('bundle_json') === 'string' ? String(form.get('bundle_json')) : '';
  if (upload instanceof File && upload.size) {
    if (upload.size > MAX_CONFIG_BUNDLE_BYTES) return null;
    text = await upload.text();
  }
  if (!text || configBundleBytes(text) > MAX_CONFIG_BUNDLE_BYTES) return null;
  return parseConfigBundle(text);
}

export const configTransferRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

configTransferRoutes.use('/settings/transfer', requirePermission('menu:manage'));
configTransferRoutes.use('/settings/transfer/*', requirePermission('menu:manage'));

async function renderTransfer(c: AppContext, extra: Omit<Parameters<typeof configTransferPage>[1], keyof import('../../core/render/layout').BaseTemplateProps | 'exportSections'>, status?: 400) {
  const exportSections = (await permittedSections(c)).map((section) => ({ id: section.id, labelKey: section.labelKey }));
  return renderPage(c, configTransferPage, { exportSections, ...extra }, c.env.VIEWS, status);
}

configTransferRoutes.get('/settings/transfer', (c) => renderTransfer(c, {}));

configTransferRoutes.post('/settings/transfer/export', async (c) => {
  const form = await c.req.formData();
  const allowed = await permittedSections(c);
  let chosen = form.getAll('sections').map(String);
  let start: ExportPosition | undefined;
  let part = 1;
  let exportedAt = new Date().toISOString();
  const cursor = form.get('cursor');
  const key = `settings-export-v1:${c.env.JWT_SECRET}`;
  if (cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length > 16384) return c.text('Invalid export cursor.', 400);
    const data = await verify(cursor, key, 'HS256').catch(() => null);
    if (!data || data.sub !== c.get('user').sub || !Array.isArray(data.sections) ||
        !data.sections.every(id => typeof id === 'string' && allowed.some(section => section.id === id)) ||
        typeof data.part !== 'number' || typeof data.exportedAt !== 'string' ||
        typeof data.section !== 'string' || !data.sections.includes(data.section) || typeof data.after !== 'string') {
      return c.text('Export permissions or cursor changed. Start a new export.', 400);
    }
    chosen = data.sections;
    part = data.part;
    exportedAt = data.exportedAt;
    start = { section: data.section, after: data.after };
  }
  const selected = allowed.filter(section => chosen.includes(section.id));
  let result;
  try {
    result = await exportConfigPart(c, selected, start, exportedAt);
  } catch (error) {
    if (error instanceof ExportHierarchyError) return c.text(error.message, 409);
    if (!(error instanceof OversizedConfigRecord)) throw error;
    return c.text(`The record "${error.label}" in ${error.section.id} exceeds the 2 MB file limit.`, 400);
  }
  const refused = await flushReadAudit(c, { destination: 'download', operation: 'config.export' });
  if (refused) return refused;
  const next = result.next && await sign({
    sub: c.get('user').sub, sections: selected.map(s => s.id), part: part + 1,
    exportedAt, ...result.next, exp: Math.floor(Date.now() / 1000) + 86400,
  }, key, 'HS256');
  const suffix = next || part > 1 ? `-part-${String(part).padStart(3, '0')}` : '';
  return new Response(result.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="cms-settings-${exportedAt.slice(0, 10)}${suffix}.json"`,
      'Cache-Control': 'no-store',
      ...(next ? { 'X-Next-Cursor': next } : {}),
    },
  });
});

configTransferRoutes.post('/settings/transfer/preview', async (c) => {
  const bundle = await readBundle(await c.req.formData());
  if (!bundle) return renderTransfer(c, { errorKey: 'settings.transfer.invalid_file' }, 400);
  return renderTransfer(c, { preview: { source: bundle.source, exportedAt: bundle.exportedAt, bundleJson: JSON.stringify(bundle),
    sections: await previewSections(c, bundle) } });
});

configTransferRoutes.post('/settings/transfer/apply', async (c) => {
  const form = await c.req.formData();
  const bundle = await readBundle(form);
  if (!bundle) return renderTransfer(c, { errorKey: 'settings.transfer.invalid_file' }, 400);
  const selected = form.getAll('sections').map(String);
  const result = await applyConfigBundle(c, bundle, new Set(selected));
  return renderTransfer(c, {
    result,
    selected,
    preview: { source: bundle.source, exportedAt: bundle.exportedAt, bundleJson: JSON.stringify(bundle), sections: await previewSections(c, bundle) },
  });
});
