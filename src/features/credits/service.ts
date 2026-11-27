// ============================================================
// Credit system — manifest-declared costs, admin-configured prices,
// host-charged, ledger-logged.
//
// A plugin's manifest declares which chargeable actions exist
// (PluginManifest.credits): 'page_create' costs are charged automatically by
// the host at every page-create path (the /__cms write-back API and the
// built-in admin editor); 'metered' costs are reported by the plugin via
// POST /__cms/credits/charge for actions the host can't observe. The CMS
// stores configured prices in the `settings` table (`plugin.credits.<id>`),
// keeps each user's balances in credit_wallets, and appends every change to
// credit_ledger.
//
// Pricing semantics:
//   - configured number  → that's the price (0 = explicitly free)
//   - not configured     → the manifest `default`, or 0 (free) if none
//   - if several plugins price the same page type (via delegated writeTypes),
//     the effective cost is the SUM of all effective prices
//
// Charging is atomic and overdraft-proof: the ledger INSERT and the balance
// UPDATE share a `credits >= amount` guard and run in one DB.batch (a D1
// transaction), so concurrent spends can never take a balance below zero and
// the ledger can never disagree with the balance.
//
// Shared pool: besides per-user balances there is one site-wide pool per
// currency (`shared_credits`, one row each) with its own append-only ledger
// (`shared_credit_ledger`). spendCredits() tries the user's balance first and
// falls back to the pool for the FULL amount when the user can't cover it
// (all-or-nothing per pool — never split). Pool movements are recorded only in
// the shared ledger, with user_id as the beneficiary. Users holding the
// 'credits:share' permission may move pool credits to a user's balance
// (transferSharedCredits); admins top the pool up via adjustSharedCredits.
//
// Currencies: every function here takes a CreditCurrency, defaulting to
// 'credit'. A currency is a wallet of its own — its own credit_wallets row,
// shared pool row and ledger lines — and nothing converts between
// them: a diamond cost is refused when the diamond balance is short, however
// many credits the user holds. 'diamond' is the premium wallet for costs an
// operator pays real money for (SMS and WhatsApp delivery). Supported
// currencies live only in ./currencies.ts; storage is row-based and needs no
// schema change when one is added.
//
// The code lives in ./pricing.ts, ./balances.ts and ./movements.ts; this module
// is the feature's credit API. balances.ts's internal plugin-wallet writers
// stay unexported here.
// ============================================================

export * from './pricing';
export * from './movements';
export {
  adjustCredits,
  adjustSharedCredits,
  chargeCredits,
  chargeSharedCredits,
  countCreditLedger,
  forfeitPluginCredits,
  getCreditBalance,
  getCreditBalances,
  getPluginCreditBalance,
  getPluginCreditBalances,
  getSharedCreditBalance,
  getSharedCreditBalances,
  grantPluginCredits,
  listCreditLedger,
  listPluginCreditLedger,
  listSharedCreditLedger,
} from './balances';
export type {
  CreditChargeInput,
  CreditChargeResult,
  CreditLedgerRow,
  CreditSource,
  PluginCreditLedgerRow,
  PluginGrantResult,
  SharedCreditLedgerRow,
  SharedCreditResult,
} from './balances';
export {
  asCreditCurrency,
  currencyLabel,
  currencyLabelKey,
  currencyUnitKey,
  emptyCurrencyTotals,
} from './currencies';
