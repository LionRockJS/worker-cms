import { exportRows } from '../../core/config-export';
import type { PluginRecord } from './types';
// Plugin registrations for settings export/import. Only the registry row
// travels: the shared secret is per CMS (a plugin keys it by this CMS's
// origin), so an imported plugin gets a fresh secret and must be connected
// again. Trusted-UI and the plugin's approvals are security decisions made on
// each CMS, so they are never imported.

import {
  ConfigTransferItemError, isRecord, planChange, skipItem,
  type ConfigTransferPlanItem, type ConfigTransferSection,
} from '../../core/config-transfer';
import { recordTableReads } from '../../core/http/access-log';
import { listPlugins } from './store';
import { normalizeUrl, readForm } from './registration-form';
import { transferManifest } from './registry';
import { getIdentityForRow } from './identity';
import type { AppContext } from '../../core/http/context';
import { preparePluginRegistrationMutation, PluginRegistrationConflictError } from './registration-evidence';

const LOCAL_KEYS = new Set(['cmsTrustedUi', 'cmsViewSource', '__proto__', 'prototype', 'constructor']);

function configObject(raw: string | null | undefined): Record<string, unknown> {
  try { const parsed = JSON.parse(raw || '{}'); return isRecord(parsed) ? parsed : {}; } catch { return {}; }
}

async function portableConfig(c: AppContext, url: string, config: Record<string, unknown>, rowId?: number) {
  if (!Object.keys(config).some(key => !LOCAL_KEYS.has(key)) || normalizeUrl(url)[1]) return {};
  const manifest = await transferManifest(url);
  const fields = manifest?.portableConfigFields;
  if (!manifest || !Array.isArray(fields) || !fields.every(key => typeof key === 'string')) return {};
  const pin = rowId === undefined ? null : await getIdentityForRow(c.env.DB, rowId);
  if (pin && pin.manifest_id !== manifest.id) return {};
  return Object.fromEntries(fields.filter(key => !LOCAL_KEYS.has(key) && Object.hasOwn(config, key))
    .map(key => [key, config[key]]));
}

export const pluginConfigTransferSection: ConfigTransferSection = {
  id: 'plugins',
  labelKey: 'settings.transfer.sections.plugins',
  order: 10,
  permission: 'plugin:manage',
  noteKey: 'settings.transfer.notes.plugins',
  async *exportRecords(c, after) {
    const rows = exportRows<PluginRecord>(c, `SELECT id, url, label, enabled, sort_order, config FROM plugins
      WHERE id > CAST(? AS INTEGER) ORDER BY id LIMIT ?`, after, plugin => {
      recordTableReads('config.export-read', 'plugins', [plugin.id]);
      return { key: String(plugin.id), label: plugin.label, item: plugin };
    });
    for await (const row of rows) {
      const plugin = row.item as PluginRecord;
      yield { key: row.key, label: row.label, item: {
        url: plugin.url, label: plugin.label, enabled: !!plugin.enabled, sortOrder: plugin.sort_order,
        config: await portableConfig(c, plugin.url, configObject(plugin.config), plugin.id),
      } };
    }
  },
  async plan(c, items) {
    const existing = await listPlugins(c.env.DB);
    const plans: ConfigTransferPlanItem[] = [];
    for (const raw of items) {
      const label = isRecord(raw) && typeof raw.url === 'string' ? raw.url : '?';
      if (!isRecord(raw) || typeof raw.url !== 'string' || !isRecord(raw.config)) { plans.push(skipItem(label, 'Invalid plugin entry.')); continue; }
      const form = new FormData();
      form.set('url', raw.url);
      form.set('label', typeof raw.label === 'string' ? raw.label : '');
      if (raw.enabled === true) form.set('enabled', 'on');
      form.set('sort_order', String(typeof raw.sortOrder === 'number' ? raw.sortOrder : 0));
      const parsed = readForm(form, !!c.env.PLUGIN_VIEWS_BUCKET, !!c.env.PLUGIN_LOCAL_VIEWS);
      if (!parsed.input) { plans.push(skipItem(label, parsed.error ?? 'Invalid plugin entry.')); continue; }
      const input = parsed.input;
      const before = existing.find(plugin => plugin.url === input.url);
      const incoming = raw.config;
      const merge = async (local: string | null | undefined) => {
        const imported = await portableConfig(c, input.url, incoming, before?.id);
        return Object.keys(imported).length ? JSON.stringify({ ...configObject(local), ...imported }) : local;
      };
      // A preview only contacts plugins already registered on this CMS.
      if (before) input.config = await merge(before.config);
      const comparable = (value: { label: string; enabled: boolean | number; config?: string | null; sort_order?: number }) => ({
        label: value.label, enabled: !!value.enabled, config: configObject(value.config), sortOrder: value.sort_order ?? 0,
      });
      plans.push(planChange(input.url, before && comparable(before), comparable(input), async () => {
        const mutation = await preparePluginRegistrationMutation(c);
        try {
          if (before) {
            const current = mutation.row(before.id);
            if (!current || current.uuid !== before.uuid || current.url !== before.url || current.config !== before.config) throw new ConfigTransferItemError(`${input.url} changed during import.`);
            await mutation.update(before.id, { ...input, config: await merge(current.config) });
          } else {
            await mutation.create({ ...input, config: await merge(input.config) });
          }
        } catch (error) {
          if (error instanceof PluginRegistrationConflictError) throw new ConfigTransferItemError(error.message);
          throw error;
        }
      }));
    }
    return plans;
  },
};
