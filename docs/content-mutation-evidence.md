# Durable draft-editor content evidence

Local W4b continuation, 2 November 2026, after `38aa132`. The core request service is `src/core/pages/mutation-evidence.ts`; the native/plugin-form admin editor uses it through `src/routes/admin/pages/crud.ts`. This is the first content-writer slice, not completion of all content mutations.

| Covered operation | Atomic evidence and state |
|---|---|
| Create draft | Explicit stable page UUID, page insert, initial history UUID/snapshot, selected tags and `page.create`. The numeric page ID remains database-generated. |
| Save draft | Existing page snapshot and tag/history membership checks, page metadata/body update, history snapshot, tag replacement and `page.update`. Structured editor and save-before-publish paths use this same service. |
| Restore history | Selected version ownership/UUID/body check, page working-copy update, new `restore` snapshot and `page.restore`; existing tag membership is preserved from the service's snapshot. |
| Remove one history row | Exact selected row removal and `page.version.delete`; the working copy and tag membership remain checked. |
| Remove all history | Full selected version-ID manifest, exact affected-row assertion and `page.versions.delete`. Empty history is a no-op without an invented success event. |

Success evidence identifies a page by its internal stable UUID. Historical and other writer events can still use numeric page IDs; investigators must resolve the corresponding identity rather than assume a uniform identifier format. Detail contains field names, generated version UUIDs, source/removed version IDs, counts and classification generation. It excludes page names/slugs, document bodies, form actions, taxonomy labels and profile values. Private history retains its existing snapshot/action behavior.

## Classification, authority and transaction guards

Classification is the highest applicable table, prior/new page-type, prior/selected tag-taxonomy and retained UUID floor. The service snapshots page-tag membership, tag taxonomy ownership, UUID floor and version IDs. A changed association/taxonomy/floor/history set, stale page snapshot, revoked/expired session, actor-role/grant change or policy generation invalidates the transaction. Existing sensitivity retype restrictions retain their reviewed-declassification 409 response. Strict pending protected-read evidence is flushed before mutation.

Page data, tags, new history and the exact success row share one D1 batch. Final checks reject ignored/rewritten audit or business writes, missing/mismatched snapshots, incomplete tags and incompatible final UUID sensitivity. History deletion checks the exact selected affected count before its receipt and checks remaining membership afterward. A page/version/tag write cannot become successful merely because a statement returned without throwing.

The supported HTTP actor must retain `content:write`; core authorization now supports that capability. Direct plugin/service callers need their own verified actor/delegation contract and remain outside this request-only service. Manifest work is refused above 5,000 history or tag rows; production statement/query budgets can be lower and require representative deployment testing. These are bounded single transactions, not resumable bulk operations.

Creation/update notifications run after the local commit and suppress the old duplicate best-effort page audit, including its free-text metadata. Optional hooks, collaboration notifications, credit reservations/compensation and publication remain separate operations. Their durability or failure does not retroactively make the content transaction atomic with another service. Existing publication protection is retained.

## Failure and retry semantics

Failed/uncertain operations return generic 503/no-store and use the existing incomplete coarse monitoring incident. Exceptions identifying the existing sensitivity-reduction refusal retain 409. No success announcement is sent when the local batch is unavailable. A lost commit acknowledgment can leave a committed page/history/event; the service does not automatically replay it or assert rollback. Reconcile by page/version UUID and event before retrying. The create-credit reservation/refund flow is pre-existing and separate; coordinating compensation with uncertain content outcomes remains R5 work.

No new schema or migration is added. The prior outbox/classification-version upgrades are still prerequisites for existing installations. Regulated business writes remain blocked at HTTP and direct service admission.

Validation: **69 new content regressions** pass. The final serial suite passed **1,760 tests across 76 files**, with no cancellation, uncaught-exception or unhandled-error diagnostic in its log. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. These are local results, not deployed acceptance.

## Remaining scope

Weight/batch-weight/reorder, bulk text/tag workflows, taxonomy/tag administration, trash/delete/restore/purge, publication/pull/withdrawal, plugin/service APIs, ingestion and background writes still need their own coverage/recovery work. Other host configuration/access writers and general operation identities remain open. The [six-package scope register](w4b-remaining-scope-2026-11-02.md) gives the remaining estimate and release dependencies. No production migration, deployment, push or compliance sign-off occurred.
