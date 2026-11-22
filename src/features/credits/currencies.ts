/**
 * Currency catalog owned entirely by the credits feature.
 *
 * Storage is row-based, shared contracts accept opaque strings, and the admin
 * shell renders contributed wallet rows. Adding a currency therefore means
 * adding one entry here plus its translations; core code and SQL stay fixed.
 */
export const CREDIT_CURRENCY_DEFINITIONS = [
  {
    id: 'credit',
    default: true,
    fallbackLabel: 'credits',
    sidebarClass: 'text-amber-400',
    sidebarIcon: 'coins',
    showInSidebarWhenEmpty: true,
  },
  {
    id: 'diamond',
    default: false,
    fallbackLabel: 'diamonds',
    sidebarClass: 'text-violet-400',
    sidebarIcon: 'diamond',
    showInSidebarWhenEmpty: false,
  },
] as const;

export type CreditCurrency = typeof CREDIT_CURRENCY_DEFINITIONS[number]['id'];

export const CREDIT_CURRENCIES: readonly CreditCurrency[] =
  CREDIT_CURRENCY_DEFINITIONS.map((definition) => definition.id);

export const DEFAULT_CREDIT_CURRENCY: CreditCurrency =
  CREDIT_CURRENCY_DEFINITIONS.find((definition) => definition.default)?.id ?? 'credit';

const DEFINITIONS = new Map<string, typeof CREDIT_CURRENCY_DEFINITIONS[number]>(
  CREDIT_CURRENCY_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function isCreditCurrency(value: unknown): value is CreditCurrency {
  return typeof value === 'string' && DEFINITIONS.has(value);
}

export function creditCurrencyDefinition(currency: CreditCurrency): typeof CREDIT_CURRENCY_DEFINITIONS[number] {
  return DEFINITIONS.get(currency) ?? CREDIT_CURRENCY_DEFINITIONS[0];
}

/** The currency named by `value`, or 'credit' when it names none. Use for
 *  form fields and manifest input where the default is the sane fallback;
 *  declaredCredits() drops an unknown currency instead. */
export function asCreditCurrency(value: unknown): CreditCurrency {
  return isCreditCurrency(value) ? value : DEFAULT_CREDIT_CURRENCY;
}

/** Translation key for a currency's name as a heading: "Credits" / "Diamonds". */
export function currencyLabelKey(currency: CreditCurrency): string {
  return `credits.currency.${currency}`;
}

/** Translation key for a currency after a number: "25 credits" / "25 diamonds". */
export function currencyUnitKey(currency: CreditCurrency): string {
  return `credits.unit.${currency}`;
}

/** English fallback name, for log lines and non-translated surfaces. */
export function currencyLabel(currency: CreditCurrency): string {
  return creditCurrencyDefinition(currency).fallbackLabel;
}

/** A zero-filled per-currency map, so callers can total without presence checks. */
export function emptyCurrencyTotals(): Record<CreditCurrency, number> {
  return Object.fromEntries(CREDIT_CURRENCIES.map((currency) => [currency, 0])) as Record<CreditCurrency, number>;
}
