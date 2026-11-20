import type { FeatureServiceEntry } from '../services';
import type { AppContext } from '../../core/http/context';
import {
  ConfigTransferItemError, isRecord, planChange, skipItem,
  type ConfigTransferPlanItem, type ConfigTransferSection,
} from '../../core/config-transfer';
import { LocaleInputValidationError, listLocaleMessages, localeRegistry, type LocaleRecord } from '../../core/i18n';
import { mutateLocaleAdmin } from './mutation-evidence';
import { normalizeLocaleInput, normalizeLocaleMessageInput } from './validation';

const LOCALE_FIELDS = ['label', 'content_enabled', 'ui_enabled', 'direction', 'fallback_code', 'weight'] as const;

/** Runs one locale change, turning a validation refusal into an item error. */
async function mutate(c: AppContext, change: Parameters<typeof mutateLocaleAdmin>[1]): Promise<void> {
  try { await mutateLocaleAdmin(c, change); }
  catch (error) {
    if (error instanceof LocaleInputValidationError) throw new ConfigTransferItemError(error.message);
    throw error;
  }
}

function localeValues(row: Pick<LocaleRecord, typeof LOCALE_FIELDS[number]>) {
  return Object.fromEntries(LOCALE_FIELDS.map((field) => [field, row[field]]));
}

/** Locales whose fallback is also in the bundle come after that fallback. */
function fallbackOrder(items: Record<string, unknown>[]): Record<string, unknown>[] {
  const byCode = new Map(items.map((item) => [String(item.code), item]));
  const ordered: Record<string, unknown>[] = [];
  const visit = (item: Record<string, unknown>, seen: Set<string>) => {
    if (ordered.includes(item) || seen.has(String(item.code))) return;
    seen.add(String(item.code));
    const fallback = byCode.get(String(item.fallback_code ?? ''));
    if (fallback) visit(fallback, seen);
    ordered.push(item);
  };
  for (const item of items) visit(item, new Set());
  return ordered;
}

const localesSection: ConfigTransferSection = {
  id: 'locales',
  labelKey: 'settings.transfer.sections.locales',
  order: 50,
  permission: 'menu:manage',
  async exportItems(c) {
    const { locales, defaultContentLanguage } = await localeRegistry(c.env);
    return [
      // Booleans, because the locale form reads 1/0 numbers as unchecked.
      ...locales.map((locale) => ({ kind: 'locale', code: locale.code, ...localeValues(locale),
        content_enabled: locale.content_enabled === 1, ui_enabled: locale.ui_enabled === 1 })),
      { kind: 'default', code: defaultContentLanguage },
    ];
  },
  async plan(c, items) {
    const { locales, defaultContentLanguage } = await localeRegistry(c.env);
    const existing = new Map(locales.map((locale) => [locale.code, locale]));
    const plans: ConfigTransferPlanItem[] = [];
    const localeItems = items.filter((item): item is Record<string, unknown> => isRecord(item) && item.kind === 'locale');
    for (const item of fallbackOrder(localeItems)) {
      const label = typeof item.code === 'string' ? item.code : '?';
      const before = existing.get(label);
      let values: ReturnType<typeof normalizeLocaleInput>;
      try { values = normalizeLocaleInput(item, defaultContentLanguage, before?.code); }
      catch (error) { plans.push(skipItem(label, error instanceof Error ? error.message : 'Invalid language.')); continue; }
      const { code, ...next } = values;
      plans.push(planChange(code, before && localeValues(before), next, () => mutate(c, before
        ? { action: 'update', code, input: { ...item } }
        : { action: 'create', input: { ...item } })));
    }
    for (const item of items) {
      if (isRecord(item) && item.kind === 'locale') continue;
      if (!isRecord(item) || item.kind !== 'default' || typeof item.code !== 'string') {
        plans.push(skipItem('?', 'Unrecognised language entry.'));
        continue;
      }
      const code = item.code;
      plans.push(code === defaultContentLanguage
        ? { label: `default: ${code}`, action: 'unchanged' }
        : { label: `default: ${code}`, action: 'update', apply: () => mutate(c, { action: 'default', code }) });
    }
    return plans;
  },
};

const translationsSection: ConfigTransferSection = {
  id: 'translations',
  labelKey: 'settings.transfer.sections.translations',
  order: 55,
  permission: 'menu:manage',
  async exportItems(c) {
    const { locales } = await localeRegistry(c.env);
    const messages = await Promise.all(locales.map((locale) => listLocaleMessages(c.env, locale.code)));
    return messages.flat().map((message) => ({ locale: message.locale_code, key: message.message_key, value: message.value }));
  },
  async plan(c, items) {
    const current = new Map<string, Map<string, string>>();
    const messagesFor = async (code: string) => {
      if (!current.has(code)) {
        const { locales } = await localeRegistry(c.env);
        const rows = locales.some((locale) => locale.code === code) ? await listLocaleMessages(c.env, code) : [];
        current.set(code, new Map(rows.map((row) => [row.message_key, row.value])));
      }
      return current.get(code)!;
    };
    const plans: ConfigTransferPlanItem[] = [];
    for (const item of items) {
      const record = isRecord(item) ? item : {};
      const label = `${String(record.locale ?? '?')}: ${String(record.key ?? '?')}`;
      let message: ReturnType<typeof normalizeLocaleMessageInput>;
      try { message = normalizeLocaleMessageInput(record.locale, record.key, record.value); }
      catch (error) { plans.push(skipItem(label, error instanceof Error ? error.message : 'Invalid translation.')); continue; }
      const before = (await messagesFor(message.code)).get(message.key);
      plans.push(planChange(label, before, message.value, () => mutate(c, {
        action: 'message-save', code: message.code, key: message.key, value: message.value,
      })));
    }
    return plans;
  },
};

export const i18nServices: FeatureServiceEntry = {
  id: 'i18n',
  configTransferSections: [localesSection, translationsSection],
};
