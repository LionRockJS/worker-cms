# Durable runtime type and blueprint-extension evidence

Local W4b continuation after `bd1d4a4`, 2 November 2026. The optional `runtime-content-types` feature now owns its guarded mutation service at `src/features/runtime-content-types/mutation-evidence.ts`. Core supplies neutral audit, authority and policy contracts; no core module imports the optional implementation. No schema migration is added.

## Covered operations

| Host mutation | Durable receipt and local result |
|---|---|
| Database page-type create/update/delete | `page_type.create`, `page_type.update`, `page_type.delete`, atomic with the complete schema row mutation. |
| Database block-type create/update/delete | `block_type.create`, `block_type.update`, `block_type.delete`, atomic with its schema row mutation. |
| Config/plugin page-type additions through `/page_types/view/:slug` | `page_type.extend`, atomic with the shared `content.page_type_extensions` settings row. Other extension entries are preserved. |

CRUD events target stable schema UUIDs and include the actual numeric schema ID. Creates allocate a safe numeric ID above the observed table maximum and legacy time/nonce floor; the old SQLite `last_row_id` was not the generated schema ID. Exhausted IDs refuse new creates; existing safe-ID updates remain possible. Changed field names and an operation ID are retained, with classification generation and existing request/actor/session attribution. Names, slugs, blueprints and selections never enter event detail.

Extension targets use `extension:` followed by SHA-256 of the UTF-8 page-type slug. This is a stable internal identifier for reconciliation, not a blueprint/value hash or request-idempotency key. Detail contains changed field names and before/after block/taxonomy counts, excluding selection values and labels. Original config/plugin-owned selections remain locked; unknown additions are filtered out. Unknown target types retain 404 behavior. Empty additions remove only the selected extension entry; an already empty or unchanged extension produces no mutation event.

## Guards and bounds

Admission captures complete local page/block schema catalogues, taxonomy identity metadata and the extension settings row, including absence. Each snapshot has a 5,000-row and 1,000,000 UTF-8 JSON-byte budget enforced in SQL before returning data to the Worker. Serialized plans and expected states have the same byte limit; oversized catalogues refuse for review. Snapshot values remain private transaction inputs.

Current account/session, `pagetype:write` or `blocktype:write`, exact role/grant catalogue and classification generation are checked inside the business transaction and again at completion. Complete local source snapshots are checked before mutation. Final assertions verify the intended row or extension value, exact catalogue membership, unchanged neighbouring rows and other catalogues, preserved creation times, transaction-time update bounds and the exact receipt. Missing deletes and no-op updates validate captured state without timestamp changes or invented success events. Ignored/rewritten business/audit writes, stale metadata and trigger-induced policy/session/catalogue changes abort the local transaction.

Classification conservatively uses the highest applicable page_types/block_types/settings/taxonomies table class, captured and edited page-type scopes, and captured/old/new taxonomy scopes. Classified blueprint/metadata reads are audited before writing; pending strict request reads are flushed. The complete-catalogue guard can conservatively refuse an unrelated concurrent schema or taxonomy edit. Production capacity/query-budget acceptance remains R6.

Malformed or unsafe extension maps refuse mutation instead of silently discarding other entries. Valid legacy storage still uses existing tolerant core readers; this guarded writer does not migrate those APIs. Row CRUD retains the existing slug normalization, blueprint-array validation, selection serialization and redirect contracts. Type renames/deletes do not rewrite existing pages, selections elsewhere, compiled configuration or classification policy/floors.

## Configuration and outcome boundaries

Extension writes first validate the captured map, invalidate this isolate's effective-config cache, resolve its base again, and preserve locked base lists while checking all captured local state at commit. Plugin manifest delivery and remote/provider cache revisions are not part of that D1 transaction; plugin registration/configuration/approval evidence remains R2, with delivery/reconciliation under R4/R5. This is not a claim of atomic remote configuration versioning.

This isolate's config cache is invalidated after success and uncertain failure so a possibly committed schema write is not hidden behind its previous local snapshot. Other isolates retain the existing cache TTL; no cross-isolate invalidation protocol is added. Errors from external config providers retain their own response contract.

Guarded service failures return `runtime_type_change_unavailable`, 503/no-store, and attempt coarse incomplete health evidence without payload values. A lost acknowledgment can leave the schema and receipt committed while returning unavailable. No automatic replay, rollback claim, general receipt lookup or request idempotency is added. Reconcile state and receipt before retrying; shared operation/recovery contracts remain R5.

Five W4b packages remain open. This completes the named local runtime-type/extension slice of R2, not all host configuration. Locale/message administration is next; plugin/configuration/approval and financial administration still remain. Contributor/service writers, external effects and global/deployment acceptance retain R3–R6 scope. See the [scope register](w4b-remaining-scope-2026-11-02.md).

No production migration, push, deployment or compliance sign-off occurred; regulated writes remain blocked.

## Validation

Validation: **131 new runtime-type regressions** pass across page/block CRUD and extension changes, including private classified receipts, real numeric IDs, ignored/rewritten audit and business statements, stale catalogue/settings/taxonomy/authority/policy snapshots, no-ops, unsafe legacy maps, bounds, cache invalidation and lost acknowledgments. The final focused run passed **138 tests across two files**; the final rebuilt-state serial suite passed **2,401 tests across 84 files**, including the separately merged W5 archive work on `main` (`506ac54`). Build, TypeScript, all eight feature profiles, import boundaries, generated consistency and whitespace checks passed. Tests were scoped to this checkout with `--dir test`. The previously recorded uncaught Worker request-cancellation diagnostic recurred near advanced-search queue tests despite the full run reporting all tests passed; it remains unresolved under R6. No runtime fix or clean release acceptance is claimed. This runtime-type increment adds no schema migration or deployment evidence.
