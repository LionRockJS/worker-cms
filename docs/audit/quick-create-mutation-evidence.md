# Durable quick-create evidence and host writer reconciliation

Local W4b continuation after `8f6861a`, 2 November 2026. `POST /admin/pages/new_post/:pageType` now uses the existing core `saveDraftContent` transaction. No new schema or optional-feature implementation dependency is added.

## Quick-create behavior

The page, initial `create` history snapshot, empty tag membership and exact classified `page.create` receipt commit together. The receipt targets the new page UUID, retains the generated history UUID, field names, tag count, classification generation and actual actor/session/request metadata. It excludes names, slugs, body values, labels and actor profile values. The redirect still names the created page's numeric ID and opens its editor.

Quick-create retains its existing form contract: default name from the URL page type, slug generation and existing-slug suffixes, blueprint/language/Lect metadata, weight, creator and normalized editors. Parent, start/end, timezone and tags stay empty even if full-editor-only fields are submitted. Slug selection remains a pre-transaction lookup, not a new concurrent-uniqueness guarantee. Quota checks and credit reservation still occur before the content call, and retain their refusal contracts.

The shared service rechecks current session/account/grants and policy generation in the write transaction, then verifies page values, history identity/body/action, tag membership and sensitivity bounds. This continuation also adds an end-of-save authority assertion to the shared service: a business trigger revoking the authorizing session cannot leave a successful save receipt. Ordinary editor saves use that same final assertion. Audit or business statements that abort, silently skip or rewrite expected state roll back the covered transaction.

Create notifications run only after the content service succeeds, with the durable-evidence flag suppressing duplicate best-effort mutation logging. Notification initiation is outside the reservation-refund catch: a synchronous hook failure cannot refund content that already committed. Hook delivery is still an external outcome (R4); an asynchronous listener failure retains existing best-effort handling.

A failed content call returns the existing generic content-unavailable 503/no-store and attempts coarse incomplete health evidence. A lost acknowledgment can leave both page/history and the exact receipt committed while returning unavailable; it does not emit the success notification. No automatic retry or rollback claim is added.

## Reservation boundary

Credit reservation and refund remain separate commits. Confirmed local transaction rollback retains the existing refund behavior. The existing refund is also attempted when the content call throws after an ambiguous acknowledgment; therefore committed content and a compensating credit entry may coexist. This is not atomic billing, idempotency or uncertain-result recovery. Reconcile content, receipt and reservation/refund ledger before retrying; shared charge/compensation correlation remains R5. A refund failure retains its separate failure contract. This continuation does not silently claim those recovery semantics complete.

## R1 host route register

The source reconciliation covered the mounted host draft-editor, tag/taxonomy and trash routes, plus host bulk dispatch. These inventoried local editorial writers now use guarded mutation services:

| Host entry points | Guarded implementation |
|---|---|
| `POST /pages` and `/pages/new_post/:pageType` | `saveDraftContent`; page, initial history, tags and exact create receipt. |
| `POST /pages/:id`, including structured edits and history restore | `saveDraftContent`; complete local edit/history/tag receipt. |
| History removal actions on `POST /pages/:id` | `removeDraftHistory`; exact selected history removal. |
| Single/batch page weights and reorder | `updateDraftWeights` from `src/core/pages/batch-mutation-evidence.ts`. |
| Host page-tag POST and both DELETE aliases | `mutateHostPageTag`. |
| Tag/taxonomy create/edit/delete and tag weights | `saveTag`, `deleteTag`, `saveTaxonomy`, `deleteTaxonomy`, `updateTagWeights`. |
| Single draft deletion and trash restore/purge | `mutatePageLifecycle`. |
| Local bulk text/tag/delete slices through search and claimed jobs | `applyBulkPageAction` dispatches to the guarded batch/lifecycle services; trusted claims retain current authority and lease checks. |

Source anchors are `src/routes/admin/pages/{crud,dashboard,lifecycle}.ts`, `src/routes/admin/{api,tags}.ts`, `src/features/trash/routes.ts`, `src/features/search/routes.ts` and `src/features/jobs/runner.ts`. The exported legacy `deletePageVersion` helper in `pages/editor.ts` has no production caller; routed history removal uses the guarded service. Legacy DB-only page/history/trash helpers remain reachable through plugin APIs, ingestion and published pull/materialization and retain their R3/R4 inventory entries. They are not approved substitutes for guarded host writers.

R1's inventoried local engineering scope is complete. Global writer/actor reconciliation and deployment acceptance remain R6. Publication, withdrawal, tag sync and published pull/materialization stay R4, including their local steps; media, contributor/service/collaboration and other background writers remain R3/R4. Host configuration/access changes remain R2. Direct SQL/import/migration operators still need explicit evidence contracts. See the [remaining scope register](w4b-remaining-scope-2026-11-02.md): five packages (R2–R6), provisionally 23–41 engineering person-days plus external acceptance time.

No production migration, deployment, push or compliance sign-off occurred; regulated writes remain blocked.

## Validation

Validation: **36 new quick-create regressions** pass, including private classified receipts, history/payload rollback, current and final authority/policy checks, preserved defaults, quota/reservation refusals, actual credit spend/refund behavior, hook ordering and lost acknowledgments. The complete serial suite passed **2,195 tests across 81 files**, with no uncaught request-cancellation or unhandled-error diagnostic in its log. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. The previously recorded intermittent Worker cancellation appeared in the initial focused route run; it remains an R6 investigation item, and no runtime fix is claimed. The initial focused run's viewer-refusal assertion was corrected to its existing browser redirect contract; the final suite passes that assertion. These are local repository results, not deployed acceptance.
