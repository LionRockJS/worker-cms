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
import { readForm } from './registration-form';
import { pluginViewSource } from './view-source';
import { preparePluginRegistrationMutation, PluginRegistrationConflictError } from './registration-evidence';

/** CMS-owned keys a plugin's config carries; set per CMS, never transferred. */
const CMS_CONFIG_KEYS = ['cmsTrustedUi', 'cmsViewSource'];

function configObject(raw: string | null | undefined): Record<string, unknown> {
  try { const parsed = JSON.parse(raw || '{}'); return isRecord(parsed) ? parsed : {}; } catch { return {}; }
}

function portableConfig(raw: string | null | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(configObject(raw)).filter(([key]) => !CMS_CONFIG_KEYS.includes(key)));
}

export const pluginConfigTransferSection: ConfigTransferSection = {
  id: 'plugins',
  labelKey: 'settings.transfer.sections.plugins',
  order: 10,
  permission: 'plugin:manage',
  noteKey: 'settings.transfer.notes.plugins',
  async exportItems(c) {
    const plugins = await listPlugins(c.env.DB);
    recordTableReads('config.export-read', 'plugins', plugins.map((plugin) => plugin.id));
    return plugins.map((plugin) => ({
      url: plugin.url,
      label: plugin.label,
      enabled: !!plugin.enabled,
      sortOrder: plugin.sort_order,
      viewSource: pluginViewSource(plugin.config),
      config: portableConfig(plugin.config),
    }));
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
      form.set('view_source', typeof raw.viewSource === 'string' ? raw.viewSource : 'host');
      form.set('config', JSON.stringify(raw.config));
      const parsed = readForm(form, !!c.env.PLUGIN_VIEWS_BUCKET, !!c.env.PLUGIN_LOCAL_VIEWS);
      if (!parsed.input) { plans.push(skipItem(label, parsed.error ?? 'Invalid plugin entry.')); continue; }
      const before = existing.find((plugin) => plugin.url === parsed.input!.url);
      // Keep this CMS's own trust decision for a plugin it already has.
      if (before && configObject(before.config).cmsTrustedUi === true) {
        form.set('trusted_ui', '1');
      }
      const input = readForm(form, !!c.env.PLUGIN_VIEWS_BUCKET, !!c.env.PLUGIN_LOCAL_VIEWS).input!;
      const comparable = (value: { label: string; enabled: boolean | number; config?: string | null; sort_order?: number }) => ({
        label: value.label, enabled: !!value.enabled, config: configObject(value.config), sortOrder: value.sort_order ?? 0,
      });
      plans.push(planChange(input.url, before && comparable(before), comparable(input), async () => {
        const mutation = await preparePluginRegistrationMutation(c);
        try {
          if (before) {
            if (!mutation.row(before.id)) throw new ConfigTransferItemError(`${input.url} changed during import.`);
            await mutation.update(before.id, input);
          } else {
            await mutation.create(input);
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
