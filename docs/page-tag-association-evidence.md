# Durable host API page-tag association evidence

Local W4b continuation after `0583366`, 2 November 2026. `src/core/pages/tag-association-evidence.ts` owns guarded transactions for the always-on host API. It imports no optional feature implementation and requires no new schema.

## Covered API contracts

| Endpoint | Behavior and receipt |
|---|---|
| `POST /admin/api/page/:pageId/tag/:tagId` | Insert one association, touch the owning page and commit `page.tag-add`. Return the actual numeric association ID. An existing association returns the prior duplicate response (`success:false`, `message:"tag exist"`, existing ID), without a timestamp change or mutation event. |
| `DELETE /admin/api/page_tag/:id` | Remove exactly the selected association, touch its owner and commit `page.tag-remove`. Preserve other links, including legacy duplicates and their weights. |
| `DELETE /admin/api/page/remove/page_tag/:id` | Same guarded removal and response contract as the shorter alias. |

Deleting an already missing ID remains successful without a mutation event or timestamp change; absence is checked inside the batch. Invalid, partial, nonpositive or unsafe numeric IDs return 400. Missing new page/tag targets return 404 after guarded absence checks. An orphan legacy association without a valid current owner refuses as unavailable rather than inventing page attribution.

Receipts use the stable page UUID as target, internal page ID/UUID, affected association ID/UUID/page/tag/weight/timestamps and complete before/after association manifests. They include operation correlation, classification generation, authenticated actor/session and actual HTTP request attribution. Names, slugs, page/tag bodies, labels and actor profile values are excluded. Neither history creation nor publication/hooks are added to these endpoints.

## Transaction and protection

Admission checks current account/session/grant catalogue and `content:write`, the classification generation, the owning page identity/type/timestamp, every current link, related tag identities/taxonomy ownership and the retained page UUID floor. The delete path also rechecks the selected link independently, preventing a moved link from being deleted under stale owner attribution. Duplicate and missing-target paths validate their captured state without creating a success receipt.

Classification conservatively takes the highest applicable pages/page_tags/tags/taxonomies table class, owning page type, all related taxonomies (including a newly added tag), and retained UUID floor. Classified metadata-read evidence is awaited before business mutation. SQL snapshots contain only identity/association metadata, with a 5,000-row and 1,000,000 UTF-8 JSON-byte budget enforced before returning data to the Worker. Each bound manifest and the complete event detail also has a 1,000,000-byte limit. Larger legacy scopes refuse for review. These bounds are not production latency or query-budget acceptance.

The link write, page timestamp and exact receipt share one private-D1 batch. Final guards compare the full expected association set, owner identity/type, timestamp within the captured start and database transaction time, tag identities/taxonomies, current authority/policy and retained floor. Newly applicable type/taxonomy protection must be retained; deleting an association cannot erase its prior sensitivity. Ignored or rewritten business/audit writes and unexpected trigger changes roll back the transaction. Page timestamp updates use database execution time so a second boundary between snapshot and execution does not produce a false mismatch with the existing timestamp trigger.

New association UUIDs are generated before the transaction. The proposed numeric ID is above the observed stored maximum and legacy time/nonce floor, with a positive safe-integer check. A concurrent collision refuses atomically; no ID or payload is silently replaced. This does not migrate other legacy ID writers.

Generic failures return `page_tag_change_unavailable`, 503/no-store, and attempt coarse incomplete health evidence without SQL/body values. A lost commit acknowledgment can return unavailable while the link, timestamp and receipt remain committed. There is no automatic replay or claim of rollback; reconcile retained state and receipt before retrying. Generated operation IDs do not supply request idempotency or general uncertain-result lookup (R5).

## Remaining scope

This slice covers host HTTP associations only; plugin/service, ingestion and collaboration writers remain R3, with external effects under R4. During the remaining writer inventory, the host quick-create alias `POST /admin/pages/new_post/:pageType` in `src/routes/admin/pages/dashboard.ts` was confirmed to still use separate page/history writes and a best-effort event. R1 remains open for that alias and final writer reconciliation. The legacy exported history-delete helper has no current production caller, but belongs in the inventory if reused. Use the [current six-package scope register](w4b-remaining-scope-2026-11-02.md).

No schema change, production migration, push, deployment or compliance sign-off occurred. Regulated writes remain blocked.

## Validation

Validation: **87 new association regressions** pass, covering all three endpoints, no-ops, attribution/redaction, retained and newly raised sensitivity, ignored/rewritten writes, stale policy/session/grants/metadata, row/byte limits, numeric allocation/collision/overflow and lost acknowledgments. The focused API/new-regression run passed **337 tests**; the final serial suite passed **2,159 tests across 80 files**, with no uncaught request-cancellation or unhandled-error diagnostic in that full-run log. The tightened collision assertion also passed in the final standalone 87-test run. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. The previously recorded intermittent Worker cancellation recurred near advanced-search queue tests in the earlier focused route run; its cause remains unresolved under R6, and no runtime fix or release acceptance is claimed. These are local results, not deployed acceptance.
