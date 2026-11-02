# Durable local page lifecycle evidence

Local W4b continuation, 2 November 2026, following `45cf496`. The neutral core service `src/core/pages/lifecycle-mutation-evidence.ts` owns the private-D1 transaction. Host delete routes, inline/claimed-job bulk delete and optional trash routes use it. Core imports no optional feature implementation. No schema change or regulated-write bypass is added.

## Covered operations

| Operation | Local state and evidence |
|---|---|
| Single/bulk draft trash | Move selected pages, versions and tag links to trash, remove their draft rows and commit one exact `page.delete` receipt per bounded slice. |
| Single/filtered/all restore | Move selected trash pages, versions and links into draft and commit `page.restore` or `page.restore_all`. Detach unselected children before removing their trash parent. |
| Single/filtered/all purge | Delete the selected trash pages and full recursive descendant closure, including versions and links, with `page.purge` or `page.purge_all`. Descendants outside a filter remain part of its existing cascade behavior and are explicitly recorded. |

Evidence uses page UUID targets, authoritative complete target counts and a bounded full `detail.sources` manifest. Each source records numeric/UUID identity, prior parent references, all history IDs/UUIDs and all link IDs/UUIDs/tag IDs/weights. Detail also records initial selection versus cascade IDs, detached child references, matching destination identities, a generated operation ID and queued claim correlation when present. Indexed target IDs are capped at 200; the full manifest remains authoritative. No page names, slugs, bodies, history content/actions, taxonomy labels or actor profile values enter mutation detail.

A zero-match operation rechecks authority, policy and selection without inventing a mutation event. Missing storage or invalid/oversized state refuses generically as 503/no-store rather than falling back to hard deletion. The three trash tables are required for these host paths even when an optional feature was disabled on a fresh schema.

## Identity and parent preservation

Transfers preserve source page, history and association UUIDs. A destination page with the same UUID can retain its existing numeric ID and creation time; its observed content is captured and guarded before the existing overwrite behavior. New page creation uses the source numeric ID. Unrelated numeric ID collisions refuse. Existing destination histories/links are retained; a same-UUID history or link is reused only when ownership and semantic payload match. Conflicting payloads or unrelated ID collisions refuse instead of silently ignoring the source.

All selected destination pages are created before their parent links are resolved. Parent mapping uses UUIDs where source identity is available, and the actual destination numeric ID. An unselected child left in trash is detached, preserving its history/links and recording the restored parent's actual numeric ID for a later restore. Missing legacy parent provenance cannot be reconstructed by this service. Live draft child references keep their existing independent-page semantics when a parent is trashed.

Purge explicitly selects a recursive, cycle-safe descendant closure. Selected parent links are detached before deletion, so row-count checks and the receipt account for every removed page rather than relying on an invisible foreign-key cascade. Restoring a parent does not accidentally invoke that cascade on children staying in trash.

## Guards, classification and bounds

The transaction checks current account/session/role/grant catalogue authority and the exact classification generation. It checks the selected set, full source and destination pages, versions, links, current parent identities/types, unselected trash children, tag taxonomy identities, retained UUID floors and optional table presence. Final conditions check copied content and parent identity, complete version/link unions, removed sources, surviving detached children, exact receipts, current authority/policy and sensitivity-floor retention. Ignored/rewritten business or audit statements cannot leave a successful local receipt.

Classification conservatively takes the highest applicable table, page type, parent/child type, related taxonomy and retained UUID protection. Strict classified body-read evidence is awaited before mutation. Full private snapshots, including page/history bodies, are used only for guards and copy verification. SQL computes each snapshot's row and UTF-8 JSON byte budget before returning it to the Worker. Each snapshot and bound manifest is limited to 5,000 rows and 1,000,000 UTF-8 bytes; oversized work refuses before business mutation. Bulk-delete slices remain limited to 100 pages. Production latency/query/statement budgets require deployment acceptance.

HTTP/direct execution requires the owning session and current capability: `content:delete`, `trash:restore` or `trash:purge`. Claimed bulk-delete work checks the persisted job lease and current account/grants at admission and completion. The original JWT expiry is not the delegation lease; initiating session provenance is retained. Job events use `acting_via = job:<id>`, explicit job/attempt references and no fabricated HTTP context.

## Outcomes and remaining work

Local page/version/link state and the exact success receipt share one private-D1 batch. External publication/withdrawal and hooks happen after that commit; their failure does not roll it back. The covered callers suppress duplicate legacy best-effort page mutation logs. A lost acknowledgment returns unavailable even if the transaction committed, emits incomplete coarse health evidence when available and does not claim rollback. Reconcile retained state and receipts before retrying.

Operation IDs are generated for correlation; they do not make new requests idempotent. Job cursor/result persistence, cross-slice recovery, external delivery/reconciliation and shared uncertain-result lookup remain R4/R5. Legacy DB-only trash helpers used by plugin APIs remain outside this guarded host slice under R3. Host API page-tag association writers remain R1. See the [six-package scope register](w4b-remaining-scope-2026-11-02.md).

No production migration, deployment, push or compliance sign-off occurred. Regulated business writes remain blocked; this is local repository evidence.

## Validation

Validation: **107 new lifecycle regressions** pass. The focused lifecycle/routes/features run passed **389 tests**; the complete serial suite passed **2,072 tests across 79 files**. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. The full run and complete current route run emitted one uncaught Worker request-cancellation diagnostic near the advanced-search queue tests, despite reporting all tests passed. The isolated four-test inline/queue/render sequence was clean; two parent-commit route runs (250 tests each, including one with matching developer-variable loading) were also clean. Its cause remains unresolved and these results do not establish clean runtime/release acceptance. No runtime fix is claimed; retain this diagnostic for R6 investigation before release. These are local results, not deployed acceptance.
