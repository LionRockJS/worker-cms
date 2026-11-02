# Durable taxonomy and tag mutation evidence

Local W4b continuation, 2 November 2026, following `714b8a8`. Admin taxonomy/tag mutations now use `src/core/pages/taxonomy-mutation-evidence.ts` for their local D1 changes. Publication follows the local commit and retains its separate protection/recovery contract.

| Covered operation | Atomic local evidence and state |
|---|---|
| Taxonomy creation | Generated stable UUID, inserted taxonomy and `taxonomy.create`. |
| Taxonomy edit/rename | Exact taxonomy update, complete moved-tag ID/UUID manifest, tag regrouping, any retained-floor copy and `taxonomy.update`. |
| Taxonomy deletion | Complete orphaned-tag ID/UUID manifest, regrouping to the default taxonomy, taxonomy removal and `taxonomy.delete`. Existing classification-reduction guards still refuse an unreviewed downgrade. |
| Tag creation | Generated stable UUID, tag metadata/parent/body and `tag.create`. The returned numeric ID is selected by UUID, so later publication uses the actual custom-generated ID rather than SQLite's internal rowid. |
| Tag editing | Exact metadata/parent/taxonomy/body update and `tag.update`, with a fresh target snapshot. |
| Tag deletion | Tag removal, complete live/trash link-removal manifests, complete child-parent-clear IDs/UUIDs and `tag.delete`. Retained page UUID floors survive removed associations. |
| Batch tag weights | One set-based weight update, exact changed-row count and `tag.weights` with the complete ID/UUID/before/after manifest. The indexed target list is capped at 200; detail retains the complete bounded manifest and target count. |

Events use stable taxonomy/tag UUID targets. Known existing numeric IDs and affected tag/page references are included where needed to reconcile those identities and relationship changes. Detail contains field names, internal IDs/UUIDs, link metadata, counts, weight values and policy generations. It excludes labels, slugs, body values and actor profile fields. Related live/trash page identities retain context for association and inherited-sensitivity changes.

## Admission, concurrency and classification

The service requires current `taxonomy:write` or `tag:write` authority as appropriate, with the owning unexpired session/token, stored actor role and complete role/grant catalogue rechecked in the transaction. Taxonomy authority continues to cover its associated regrouping; it does not become a general tag-management grant.

Classification conservatively takes the highest applicable table, prior/new/default taxonomy, related live/trash page-type and retained UUID floor. Snapshot guards cover scoped tag/taxonomy metadata and the edited tag body, live/trash link metadata, related page identity/type, retained floor state and optional-trash schema presence. A scoped taxonomy includes its related tags, so a concurrent edit elsewhere in that scope can conservatively refuse the request. Pending strict protected-read evidence is flushed before mutation.

A classified taxonomy rename legitimately copies its retained floor to the new key. The transaction checks the starting classification generation, permits exactly the expected one-generation increment when that source floor exists, and checks final policy generation plus the destination floor. Its event records starting and final generations. An unrelated policy change, extra trigger write or ignored floor copy refuses the batch. Empty taxonomy values cannot create an invalid retained-policy key.

Final state guards verify all expected local rows and associations, including child-parent clears and retained protection. Ignored/rewritten audit rows, partial link removals, skipped child updates and changed page classifications cannot leave a successful local receipt. Optional trash is handled when its tables exist; core imports no optional feature implementation, and tag deletion works on the tested absent-trash schema as well.

Unrelated tag bodies are excluded from scope snapshots; tag editing separately guards its observed body. Manifests are bounded to 5,000 scoped rows per category and 1,000,000 UTF-8 bytes per serialized bound/evidence detail. Excess work is refused before local mutation and requires a narrower operation or reviewed bulk workflow. These are conservative bounds, not deployed capacity acceptance.

## Responses, publication and uncertain outcomes

Unavailable local transactions return generic 503/no-store with incomplete coarse monitoring. The existing reviewed-declassification refusal remains 409. Publication is not contacted when the local transaction is refused. A lost commit acknowledgment can still leave committed local state/evidence; the response does not prove rollback and does not automatically replay the mutation.

Repeating a tag deletion when the local row is already absent validates current authority/policy and may still request publication withdrawal, preserving the existing cleanup behavior without inventing a second local deletion event. Taxonomy regrouping and tag publication after a successful local commit remain external effects; R4 intent/outbox/reconciliation and R5 general operation identities are still open. A local receipt does not prove publication delivery or third-party cleanup.

The former best-effort create/edit/delete logs, including their label/slug detail, are removed from the covered routes. The explicit tag-catalogue sync route is an external publication operation and remains outside this local slice.

No new schema/migration, deployment, production data change, push or compliance sign-off occurred. Existing outbox/classification-version upgrades remain prerequisites, regulated business writes remain blocked, and deployment capacity/recovery/retention acceptance remains open.

## Snapshot allocation regression found during validation

The full run exposed an existing bulk-history failure: the schema default's 16-bit nonce can collide on `page_versions.id` inside a hundred-row slice. The safe outcome was transaction rollback, but ordinary bulk work could be refused intermittently. A bounded diagnostic reproduced the underlying unique-constraint failure.

Both guarded editor and local-bulk history writers now allocate each numeric snapshot ID above the stored maximum and legacy time/nonce floor, inside the inserting D1 transaction. Safe-integer range checks abort overflow. UUID identity and exact snapshot/evidence guards remain unchanged; there is no automatic mutation replay. Other legacy schema-default writers are not globally migrated by this fix and remain part of the writer inventory.

Validation: **103 new taxonomy/tag regressions and two snapshot-allocation regressions** pass. The final serial suite passed **1,965 tests across 78 files**, with no cancellation, uncaught-exception or unhandled-error diagnostic in its log. After reproducing the legacy ID collision, a bounded stress check passed 100 hundred-page slices (10,000 snapshots) with the guarded allocation. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. These are local results, not deployed acceptance.

The subsequent [lifecycle record](page-lifecycle-mutation-evidence.md) covers host trash/restore/purge. Host API page-tag associations remain open separately from this catalogue-administration slice; use the current [scope register](w4b-remaining-scope-2026-11-02.md).
