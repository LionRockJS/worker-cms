// Contracts owned by the credits feature.
//
// Other features communicate with this feature through the generated service
// registry and keep their own structural view of request/result payloads.
// Core never imports this file.

/** How a declared cost is charged. */
export type CreditChargeKind = 'page_create' | 'metered' | 'recurring';

/** When a recurring cost bills. */
export type CreditBillingMode = 'advance' | 'arrears';

/** A currency identifier on the feature-to-feature wire contract. */
export type CreditCurrency = string;

/** A cost declared by a contributor (today, in a plugin manifest). */
export interface ContributedCreditDef {
  key: string;
  label?: string;
  description?: string;
  charge: CreditChargeKind;
  /**
   * Wallet this cost is paid from. Omitted means the metering feature's
   * default. The metering feature rejects identifiers it does not support.
   */
  currency?: CreditCurrency;
  page_type?: string;
  unit?: string;
  default?: number;
  per?: number;
  period?: 'month';
  billing?: CreditBillingMode;
  /** Pay only from the contributor's own wallet; never the member's balance
   *  or the shared pool. Omitted / anything but `true` means false. */
  plugin_only?: boolean;
}

/** Someone who declares priced actions. */
export interface CreditContributor {
  id: string;
  name: string;
  credits: readonly ContributedCreditDef[];
  pricablePageTypes: ReadonlySet<string>;
  manageHref?: string;
}

/** What a charge took, keyed by wallet identifier. */
export type CreditChargeTotals = Partial<Record<CreditCurrency, number>>;

/** Result returned to a feature that asked the metering feature to charge. */
export type CreditChargeOutcome =
  | { ok: true; charged: number; totals: CreditChargeTotals; refund(portion?: number): Promise<void> }
  | { ok: false; reason: 'unknown_user' }
  | {
    ok: false;
    reason: 'insufficient';
    currency: CreditCurrency;
    required: number;
    balance: number;
    sharedBalance: number;
  };

/** One editable price on a contributor's pricing screen. */
export interface CreditPricingRow {
  key: string;
  label: string;
  description: string;
  currency: CreditCurrency;
  currencyKey: string;
  chargeLabel: string;
  chargeKey: string;
  defaultValue: number;
  effectiveValue: number;
  configured: boolean;
  /** Paid only from the contributor's own wallet. */
  pluginOnly: boolean;
}
