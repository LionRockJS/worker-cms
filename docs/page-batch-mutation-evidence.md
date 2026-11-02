# Durable weights, reorder and local bulk evidence

Local W4b continuation, 2 November 2026, following `2c385b7`. Core implements the shared batch contract in `src/core/pages/batch-mutation-evidence.ts`; admin weight/reorder routes and inline/queued local bulk edits use it. No schema or regulated-write bypass is added.

## Covered changes

| Path | Durable evidence and transaction scope |
|---|---|
| Single draft weight | `page.weight`, exact changed page UUID/ID and before/after weight. An unchanged value produces no mutation event. |
| Batch draft weights | `page.weights`, complete affected-page manifest and exact changed-row count. Duplicate, invalid, oversized or disappeared targets are refused rather than reporting a partial success. |
| Draft reorder | `page.reorder`, complete changed-page manifest. The entire observed type sequence, including equal-weight name tie breakers, is checked before mutation and at completion. One set-based update and receipt replace the previous independently committed chunks. |
| Local bulk text replacement | One `page.update` event and exact generated history UUID per changed page, sharing one operation ID. Names/Lect and all new `bulk-replace` snapshots commit with every receipt in one bounded slice. Per-page events carry the expected operation target count and ordinal so a recovered set can be checked for completeness. Literal replacement and structural-field exclusions are retained. |
| Local bulk tag addition/removal | One `page.update` per changed page, with exact before/after internal tag IDs and a shared operation ID. Tag replacement and page metadata updates commit with every receipt. A repeated no-op does not invent another event. |

Weight/reorder events use an aggregate event with authoritative `target_count`. The indexed `target_ids` list is capped at 200, while `detail.targets` retains the complete bounded ID/UUID/before/after manifest. Local bulk events preserve their existing numeric page target IDs and include operation correlation; version and weight manifests carry stable UUIDs. Investigators must account for these documented identifier forms.

Detail excludes names, slugs, body content, find/replacement strings, taxonomy labels and actor profile values. Tag IDs, version UUIDs, operation IDs and job/attempt identifiers are internal evidence, protected by the event's classification. Hooks follow commit and omit the former duplicate best-effort audit rows with free-text metadata. Hook delivery and collaboration notifications are not made atomic with the local transaction.

## Guards and bounds

Admission rechecks current actor roles/grants, classification generation and the supported authorization context. Snapshot checks cover affected page metadata (full page snapshots for local edits), existing tag memberships, tag taxonomy ownership, retained UUID floors and relevant history membership. Classification conservatively includes applicable content-table/page-type/tag-taxonomy/UUID-floor protection; a local slice can retain a higher common tag ceiling. Tag edits can raise a retained floor but cannot lower it or leave evidence below final sensitivity.

Final guards check affected-row counts, expected page values, complete tag membership/multiplicity, old/new history membership and each inserted history body/action, exact receipts and policy generation. Ignored/rewritten state, a later page's failed receipt, or a stale sequence/association aborts the entire local slice. Text-only changes preserve legacy duplicate links; changed tag sets are normalized without creating duplicate new links.

Weights/reorder accept at most 5,000 unique targets; local bulk slices accept at most 100 pages. Link/tag/history manifests are capped at 5,000 rows, planned final tag memberships at 5,000, and each serialized bound manifest at 1,000,000 UTF-8 bytes. Excess work is refused before the business batch. Weight changes do not load or depend on a page's history. These bounds are not a guarantee of acceptable production latency or D1 query budgets; test representative deployment sizes before release.

The set-based weight statement uses SQLite [UPDATE FROM](https://www.sqlite.org/lang_update.html#update_from). D1's [batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) supplies the rollback boundary; a sequence of separate batches would not supply the same boundary.

## HTTP and deferred authority

HTTP/direct user execution requires a valid owning session, unexpired initiating access authority and current `content:write`. Request attribution is retained when the caller supplies the actual request context. Unavailable batch work returns generic 503/no-store with incomplete coarse monitoring rather than exposing SQL, search text or body values. Failure before the engine or another uncovered caller retains its own response contract.

A trusted queued job is a persisted delegation, not a replayed bearer credential. The optional jobs feature supplies a prepared lease assertion for its current job ID, type, running status, attempt, original body, claim timestamp and initiating user ID. Core checks this with current stored account/role/grant authority in the same business batch, at admission and completion. The old JWT's expiry is not the job's lease; its session ID is initiating provenance. Revoking that original session alone does not cancel a persisted delegation; current account/grant removal or claim invalidation refuses work. Core imports no optional job implementation or schema.

Job events use `acting_via = job:<id>`, null HTTP metadata and explicit job/attempt correlation. Runner completion/requeue/failure updates now compare the claimed job before changing its state, so a stale worker cannot overwrite a newer attempt or modified payload/owner. This also protects runner finalization for other existing job types; it does not add durable external plugin mutation receipts.

Validation: **100 new batch-evidence regressions** pass. The integrated serial suite passed **1,860 tests across 77 files**, with no cancellation, uncaught-exception or unhandled-error diagnostic in its log. The final per-slice completeness assertions also passed in the 100-test focused run. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. These are local results, not deployed acceptance.

## Uncertainty and remaining work

A lost commit acknowledgment returns unavailable even when the local mutation and its receipts committed. There is no automatic local replay, false rollback claim or successful hook emission from that failed return. Reconcile retained events and business state before an operator retry.

A job cursor/result update is still a separate commit from the page mutation. Lost acknowledgment or failure between those commits can leave a committed slice and failed/unadvanced job. An operation ID correlates one execution's events; it is not yet a durable cross-retry business idempotency key. Text replacement can change again on an unsafe retry if replacement contains the original search string. General R5 reconciliation/idempotency and R4 external recovery remain open.

Taxonomy/tag administration is covered by the subsequent [taxonomy record](taxonomy-mutation-evidence.md). Trash/delete/restore/purge, publication/pull/withdrawal, plugin/service API writers, other host configuration and broader job lifecycle evidence remain open. The [scope register](w4b-remaining-scope-2026-11-02.md) keeps all six packages open while narrowing R1. No production migration, deployment, push or compliance sign-off occurred. Regulated content writes remain blocked.

## Subsequent snapshot-allocation fix

Taxonomy validation reproduced an intermittent legacy `page_versions.id` collision during hundred-page replacement. Guarded bulk/editor snapshot inserts now allocate above the stored maximum and legacy time/nonce floor in their D1 transaction, with safe-number overflow refusal. Stable UUID attribution is unchanged. Numeric IDs are not promised never to recur after all historical rows are purged; UUIDs remain the lineage reference. Other legacy writers retain their original allocation until separately migrated. See the [taxonomy continuation](taxonomy-mutation-evidence.md).
