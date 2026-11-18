import { DEFAULT_CONTENT_LANGUAGE, LocaleInputValidationError, normalizeLocaleCode, type LocaleRecord } from '../../core/i18n';

const MESSAGE_KEY = /^[a-z0-9][a-z0-9_.:-]{0,199}$/i;

export function normalizeLocaleInput(input: Record<string, unknown>, currentDefault: string, existingCode?: string) {
  const code = normalizeLocaleCode(existingCode ?? input.code);
  const label = String(input.label ?? '').trim().slice(0, 100);
  if (!label) throw new LocaleInputValidationError('Language label is required');
  const contentEnabled = code === currentDefault ? 1 : truthy(input.content_enabled);
  const uiEnabled = code === DEFAULT_CONTENT_LANGUAGE ? 0 : truthy(input.ui_enabled);
  const direction: LocaleRecord['direction'] = input.direction === 'rtl' ? 'rtl' : 'ltr';
  const fallback = input.fallback_code ? normalizeLocaleCode(input.fallback_code) : null;
  if (fallback === code) throw new LocaleInputValidationError('A locale cannot fall back to itself');
  const weight = finiteInteger(input.weight);

  return { code, label, content_enabled: contentEnabled, ui_enabled: uiEnabled, direction, fallback_code: fallback, weight };
}

export function normalizeLocaleMessageInput(localeCode: unknown, keyValue: unknown, messageValue: unknown) {
  const code = normalizeLocaleCode(localeCode);
  const key = String(keyValue ?? '').trim();
  const value = String(messageValue ?? '').trim().slice(0, 4000);
  if (!MESSAGE_KEY.test(key)) throw new LocaleInputValidationError('Translation key contains unsupported characters');
  if (!value) throw new LocaleInputValidationError('Translation value is required');
  if (value.includes('{{') || value.includes('{%') || /[<>]/.test(value)) {
    throw new LocaleInputValidationError('Translation values must be plain text');
  }
  return { code, key, value };
}

function truthy(value: unknown): number {
  return value === true || value === '1' || value === 'on' ? 1 : 0;
}

function finiteInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
