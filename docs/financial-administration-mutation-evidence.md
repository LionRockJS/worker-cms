# Durable plugin limits, pricing and financial administration — 3 November 2026

This continues the [plugin approval slice](plugin-approval-mutation-evidence.md) on `e04957b6`. Seven local HTTP writers now commit state and exact classified audit receipts together. It completes the inventoried local R2 route scope below; W4b and deployment acceptance remain open.

## Covered writers

| Route under `/admin` | Transaction and receipt |
|---|---|
| `/plugins-manage/:id/limits` | Selected limits setting with `plugin.limits.update`. |
| `/plugins-manage/:id/credits` | Selected pricing setting with `plugin.credits.update`. |
| `/users/:id/credits` | User wallet, adjustment ledger and `user.credits.adjust`. |
| `/users/shared-credits` | Shared wallet, adjustment ledger and `credits.shared.adjust`. |
| `/profile/credits/transfer` | Both user wallets, both ledger entries and `user.credits.transfer`. |
| `/profile/credits/shared` | Donor wallet, shared pool, both ledger entries and `user.credits.donate`. |
| `/users/:id/credits/shared` | Shared pool, recipient wallet, both ledger entries and `user.credits.share`. |

`src/features/plugins/settings-evidence.ts` owns plugin configuration writes. `src/features/credits/admin-mutation.ts` owns financial administration and self-service moves. Neutral bounded snapshot/result guards now live in `src/core/db/bounded-mutation.ts`; the preceding plugin registry/approval implementation reuses them without an optional-feature import into core or a sibling feature.

## Limits and pricing

A fresh manifest is inspected without taking automatic identity claims. The enabled/reachable registry row must already match its stored pin. Complete bounded registry/pin snapshots and the selected plugin's page-type approvals are guarded. Allowed limit/price page types preserve the existing effective owned/delegated scope rules, including the restriction that wildcard grants alone do not grant blueprint ownership. The observed manifest fingerprint records a bounded remote observation, not an atomic promise about future remote deployments.

The credits feature supplies a **pure preparation service**, `prepare-admin-pricing`, which owns price normalization and the pricing setting key. The plugin service commits that plan with the selected setting snapshot and receipt. The former mutating `save-pricing` service operation is removed; no production caller remains. Missing credits support is inert: no setting write or false mutation receipt. DB-only `saveCreditValues`/`saveLimitValues` helpers remain for fixtures or future callers that must establish their own evidence contract.

Declared-key filtering, integer truncation, explicit unlimited limits (`null`), zero/free values and blank/default behavior remain. Unsafe numeric overrides are ignored like other invalid overrides. Unsupported credit currencies remain excluded. Unchanged semantic maps validate without timestamp writes/events; absent empty maps do not manufacture empty settings. Clearing an existing override map writes the empty object with evidence. Malformed legacy maps refuse rather than silently replacing unknown state.

Receipts target the stable registry UUID, retain the numeric row ID, operation and policy generation, and record changed-key fingerprints and configured-key counts. They exclude labels, URLs/query strings, credentials, raw setting/override keys and values. Classification includes registry/pin/settings/approval tables, captured plugin scopes and allowed page-type scopes; wildcard coverage includes currently classified types. Protected source reads are awaited and pending strict reads are flushed before writing.

Admission and completion check the current account/session, `plugin:manage`, exact roles/grants and classification generation. Exact statement counts, receipts, preserved creation metadata, transaction-time updates and final registry/pin/approval/setting state reject stale snapshots, ignored writes and trigger rewrites. Successful and uncertain outcomes invalidate this isolate's manifest/effective-configuration caches; other isolates retain their existing cache behavior.

## Financial transactions

Administrative user/pool adjustments require `users:manage`; shared-pool grants require `credits:share`, including for a non-manager holding only that permission. Profile transfers/donations use session-bound self-service authority and derive the source wallet from the verified actor. Caller-supplied source-user IDs or administrative authority are not synthesized.

Each operation captures and guards affected account IDs/email/roles, selected-currency wallets, scoped existing ledger history and any affected shared pool/history. Transfers preserve recipient eligibility (different account, non-administrator) and case-insensitive lookup. Ambiguous case-insensitive matches refuse. Current role/grant/session authority and classification generations are checked before and after the business statements. Recipient reassignment, changed eligibility, concurrent balances, history edits or classification changes invalidate the transaction.

User and shared ledgers retain their established actions, signed deltas, resulting balances, counterpart IDs, private note and initiating internal user ID. Both sides of a move commit together, conserving value; a failed receiving statement rolls back the debit and every ledger/receipt row. The HTTP administration paths no longer use the old debit-then-credit compensation flow. Other engine callers retain their existing contracts.

Amounts, balances, resulting sums and allocated ledger IDs must be safe integers. Balances remain nonnegative. Unknown/missing wallets behave as zero; new destination wallets/pools are created only in a successful transaction. Refused spends no longer create empty zero-wallet rows. Allocation is above both persisted ledger IDs and the stored sequence, with admission and final sequence checks. New ledger timestamps use database transaction time, while existing history remains exactly guarded.

Financial success evidence retains currency, signed amount, note presence, complete ledger IDs, affected internal user IDs and before/after balances. Notes, email/name values and credentials are excluded from the audit receipt and protected source-read metadata. Financial values remain classified by the highest effective users/roles/grants/sessions/wallet/ledger/shared-source table class; this is not a claim that financial values are anonymous.

Insufficient funds, self-transfers and administrator-recipient refusals validate their source snapshot before using fixed `credit_insufficient_balance`, `credit_self_transfer` or `credit_recipient_admin` denial reasons. The shared exact primary receipt or complete durable denial outbox is awaited. Failure of both stores returns unavailable. Ordinary syntax/required-note/unknown-recipient validation keeps existing redirects or missing-target responses; no false financial success event is written.

## Bounds, uncertainty and remaining boundaries

SQL snapshots are capped at 5,000 rows and 1,000,000 UTF-8 JSON bytes before returning values to the Worker. Planned states/manifests have the byte bound; configuration key manifests are capped at 5,000 keys. Financial history guards cover selected currency and affected users, and the selected-currency shared history for pool operations. Growing a scoped history beyond the bound requires a reviewed bounded-history writer or remediation; these routes deliberately refuse rather than truncate or weaken ledger checks. This is an operational limit for R6 capacity/acceptance, not a claim of unbounded ledger support.

Guarded failures return `plugin_settings_change_unavailable` or `credit_administration_unavailable`, 503/no-store, with coarse incomplete health evidence attempted. A lost acknowledgment can follow a complete committed mutation and receipt. A new HTTP request is not idempotent; a blind financial retry could repeat a move. Reconcile the ledger IDs, current balances and receipt before retrying. No automatic compensation or replay is introduced. General operation identity/receipt lookup/recovery remains R5.

Plugin credit charge/usage APIs, page-create reservations/refunds, recurring subscription sweeps, other engine/service/background writers and automatic identity claims remain R3/R5. Remote tenant configuration/enrollment/revocation, media and publication effects remain R4/R5. Direct SQL/import/migration and global actor/writer reconciliation remain R6. The browser-only profile language cookie changes no persistent CMS state. Existing audit/outage maintenance is tracked in its operating-evidence packages, not silently declared complete by this R2 register.

Regulated business writes remain blocked. No migration, production mutation, push, deployment or compliance sign-off occurred.

## R2 local writer register

| Inventoried family | Source and delivered evidence |
|---|---|
| Fixed host system preferences | `src/routes/admin/settings.ts`; [settings record](host-settings-mutation-evidence.md). |
| Runtime page/block types and blueprint-extension selections | `src/features/runtime-content-types/routes.ts`; [runtime type record](runtime-type-mutation-evidence.md). |
| Locale/default/message administration | `src/features/i18n/routes.ts`; [locale/message record](locale-message-mutation-evidence.md). |
| Local plugin registry/configuration/credential lifecycle | `src/features/plugins/routes/manage.ts`; [registry record](plugin-registration-mutation-evidence.md), plus limits/pricing above. |
| Explicit plugin identity/capability approvals | Same route module; [approval record](plugin-approval-mutation-evidence.md). |
| Financial administration and profile balance moves | All five mutation routes in `src/features/credits/routes/panels.ts`, covered above; credit settings overview is read-only. |
| User/role access-management foundations | `src/features/users-roles/routes/{users,roles}.ts`; [shared mutation record](w4b-durable-mutation-evidence.md). |

The source inventory reconciles the currently registered host configuration and financial routes, including the redirects/read-only/cookie-only surfaces and the explicitly deferred remote/service boundaries above. **R2's inventoried local engineering scope is complete; global/deployed acceptance remains R6.** Together with R1's local completion, this leaves **four open packages R3–R6**, provisionally **18–32 engineering person-days** plus external acceptance lead time. This removes R2's former 5–9-day planning allowance; it is not measured elapsed effort or certification progress. See the [scope register](w4b-remaining-scope-2026-11-02.md).

## Validation

**189 new regressions** (126 financial and 63 configuration) pass. The focused run passed **580 tests across seven files**, including previous plugin registry/approval evidence and existing credits, diamonds and limits contracts. Coverage includes none/PII/PHI receipts, both currencies, paired-ledger conservation, receipt/business failure rollback, stale authority/policy/accounts/approvals/settings/history, ignored writes, trigger-induced rewrites, safe amounts/IDs, allocation races, private source reads, durable denials/outbox failure, no-ops, normalization, absent metering, row/byte/key bounds, transaction-time metadata and uncertain outcomes.

Build, TypeScript, all eight feature profiles, import boundaries, generated consistency, the merged W8 inventory check and whitespace checks passed. The local upgrade drill from `f9719a3` matches fresh private/published schemas, reports zero rollback hazards and lists 13 existing private triggers for review. This is fixture/schema validation, not deployed rollback acceptance. The final serial run on integration baseline `4e3a889a` plus this increment passed **3,032 tests across 89 files**, scoped with `--dir test`. This includes independently merged W8 inventory/control tooling. No uncaught Worker request-cancellation diagnostic appeared in the final full log. The previously recorded intermittent cancellation still remains an R6 investigation item; no runtime fix or clean release acceptance is claimed.
