# Durable locale and message administration evidence

Local W4b continuation after `181e295`, 2 November 2026, validated on `main` including the separately landed setup change `0302052`. The optional i18n feature owns `src/features/i18n/mutation-evidence.ts`; mandatory locale storage/readers and shared pure normalization stay core. No new schema migration is added.

## Covered mutations

| Host operation | Atomic result and receipt |
|---|---|
| Locale create/update | The locale row and exact `locale.create` or `locale.update` receipt. Code and built-in status remain immutable on update. |
| Locale delete | Selected messages, fallback-reference clears, locale removal and one complete `locale.delete` receipt. |
| Default content language | The `content.default_language` preference and `locale.default.update`. |
| Message override insert/update | Value, verified author's internal ID, timestamps and `locale_message.upsert`. |
| Message override delete | Exact selected removal and `locale_message.delete`. |

Events retain authenticated actor/session/request attribution, classification generation, operation correlation and changed field names. Normalized locale codes remain identifiers. Message targets use `<locale>:message:<SHA-256 of the UTF-8 message key>`; guarded message-read IDs and locale-delete manifests use the same fingerprint form. Raw custom keys, language labels, translation values and prior free-form author fields are excluded. Existing catalog GET readers retain their separate read-audit contract; this does not migrate every translation read path.

Locale-delete evidence records every removed message fingerprint and the complete list of locales whose fallback was cleared. Its primary target count is one locale; the bounded detail's message count/list is authoritative for the cascade. Selected message removal and fallback clears are explicit, counted business statements before the parent deletion. Unrelated locales, messages and default preference state remain guarded.

## State, policy and validation

The service captures the complete locale registry in the same weight/label/code order used for effective default resolution, the selected locale's message overrides and the default-language setting, including absence. Each SQL snapshot is capped at 5,000 rows and 1,000,000 UTF-8 JSON bytes before values return to the Worker. Planned states and complete evidence manifests also have a 1,000,000-byte limit. A locale whose override catalogue exceeds those bounds requires reviewed remediation or another bounded writer; these routes do not silently truncate a cascade or partially apply a save.

Current account/session, `menu:manage`, exact role/grant catalogue and classification generation are checked inside the transaction at admission and completion. Classification takes the highest effective locales/locale_messages/settings table class, including retained policy floors. Classified source reads are awaited and pending strict request reads are flushed before writing. Full preconditions and final catalogue/value/author/creation/update-time checks reject stale source state, skipped or rewritten writes, missing receipts and trigger-induced policy/authority changes. A failed assertion aborts the whole local mutation/evidence batch.

Shared pure normalizers preserve locale-code normalization, label/value truncation, checkbox handling, direction, weight and plain-text translation rules. The captured effective default remains content-enabled on edit; `mis` cannot become a UI language. Default selection must be content-enabled. Built-in, unspecified and effective-default locales cannot be deleted. Fallbacks must exist and cannot reference themselves; existing multi-locale fallback-cycle handling is unchanged.

Both disabling and deleting the last enabled UI locale now refuse, with a final registry-availability assertion as well as the initial policy check. Missing update targets and duplicate creates return explicit validation errors instead of false success evidence. Missing deletes and unchanged values produce no mutation event or timestamp write after snapshot validation. Identical message values preserve their existing author metadata. Successful redirects and validation redirects remain 303.

Named protected-locale, required-default, last-UI and invalid-fallback refusals await the existing exact primary denial receipt or complete outbox envelope. Both-store failure stays refused as 503. Their details use fixed reasons and route patterns, excluding locale labels and message keys. Ordinary syntax/form errors use typed validation messages; database/audit errors cannot become free-text error redirects.

## Outcomes and remaining work

Guarded service failures return `locale_change_unavailable`, 503/no-store, and attempt coarse incomplete health evidence without payload values. Changed commits and unavailable outcomes invalidate this isolate's effective-config cache. Other isolates retain the existing cache TTL; message catalog readers still fetch persisted overrides through their existing path.

A lost acknowledgment can return unavailable after the rows and exact receipt committed. No automatic retry, rollback claim, request idempotency or general receipt lookup is added. Reconcile state and receipt before retrying; shared recovery remains R5.

The DB-only core save/delete helpers remain for tests or future internal callers. A source inventory found no remaining production calls to those writers after the administration routes moved; reusing them does not supply this host actor/evidence contract. Global direct-SQL/import/migration writer acceptance remains R6. This increment covers local locale/message administration, not plugin-provided catalog delivery or all configuration. Five W4b packages remain open; plugin registration/configuration/approvals and financial administration are next under R2. See the [scope register](w4b-remaining-scope-2026-11-02.md).

No production migration, push, deployment or compliance sign-off occurred; regulated writes remain blocked.

## Validation

Validation: **141 new locale/message regressions** pass, covering classified attribution/redaction, all seven create/update/delete branches, exact receipts, full cascade/fallback manifests, stale registry/message/default/authority/policy state, no-ops, last-UI/default/built-in/fallback denials, primary/outbox denial failure, ignored/rewritten writes, normalization, row/byte bounds, transaction-time metadata and lost acknowledgments. The focused run passed **465 tests across seven files**; the complete serial run passed **2,542 tests across 85 files** on `main` including `0302052`. Build, TypeScript, all eight feature profiles, import boundaries, generated consistency and whitespace checks passed. Runtime tests were scoped with `--dir test`. The full run emitted the previously recorded uncaught Worker request-cancellation diagnostic near advanced-search queue tests despite reporting all tests passed. That R6 issue remains unresolved; no runtime fix or clean release acceptance is claimed. These are local repository results, not deployed acceptance.

Post-W6 integration verification on `8215c11` (including independently landed authentication commit `3177779`): refreshed assembled views/CSS, TypeScript, all eight feature profiles, boundaries, generated consistency and whitespace checks passed. The serial suite passed **2,552 tests across 85 files**. Worker request-cancellation diagnostics recurred in the route suite and remain an unresolved R6 issue; no clean runtime/release acceptance is claimed. The earlier 2,542-test result above records the pre-W6 verification.
