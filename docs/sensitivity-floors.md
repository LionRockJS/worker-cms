# Retained sensitivity and historical content

The host retains the highest observed classification until a reviewed declassification process exists. Removing an active policy row, a tag association or a record does not erase its protection. This is containment for COV-10, not an approval to enable regulated writes or a general declassification workflow.

## Implementation

- `data_class_floors` retains each container's highest assigned level: 1 = PII, 2 = PHI. Policy resolution validates both active rows and floors, deduplicates container keys and takes the higher level. A narrower media prefix cannot lower a broader retained PHI boundary.
- `page_sensitivity_floors` retains the highest derived level by UUID, without a foreign key that would erase it on deletion. Core SQL triggers capture page types, tag associations, classification assignments and UUID changes in the statement that changes the source. Feature-owned trash triggers do the same for trash-only content. Core never depends on optional trash tables.
- Retyping a protected page into a lower-class type, or moving a classified tag into a lower-class taxonomy, is refused by SQL triggers. Taxonomy renames retain classification under the new slug. Policy removal/reduction is refused by the admin API; stale/lower direct policy writes still cannot override the retained floor.
- The classification screen shows retained policy-only entries and effective classes. Their reads use the existing classification-policy audit boundary and preserve any stricter policy on the floor metadata itself. There is no application endpoint for clearing floors.
- Read preparation applies UUID floors to draft/trash rows, page versions, live/published UUIDs and deferred metadata with known UUID provenance. Counts and zero-result probes over types containing floored records also retain that protection. Lookups are grouped by source, preserving bounded bulk round trips.
- Publication and live-sync gates consume the floor. A public container declaration cannot override a retained private UUID. Include these exceptions in the actual deployment data inventory; a public type name alone is not evidence that every historic record is public.
- Inline clones copy the source floor in the same D1 batch as the new page/version. Manual published pulls pin the actual audited source class in the copy batch. Ingestion pins observed published-source UUIDs before materializing them, including classifications from a different published tag catalogue. Same-UUID trash/restore and purge retain the existing floor.

Floor metadata contains identities and levels, not document bodies. It remains private operational data. New read evidence uses existing bounded manifests and actor attribution. Mutation receipts and audit/business atomicity remain W4b; classification preservation does not replace them.

## Existing deployment upgrade

Fresh installations receive the schema from the rebuilt baseline. Rebuilding `0001_initial_schema.sql` does **not** upgrade a database that already applied that migration. The reviewed upgrade files are under `migrations/manual`, so normal migration discovery does not apply them automatically:

1. Back up and rehearse against a representative staging copy. Inventory known historic retyping, policy deletion, tag removal, copies and published recipients. Preserve evidence before making changes.
2. Contain affected reads, writes, publication and direct public storage/consumer routes throughout the change. Do not split traffic between old workers that ignore floors and new workers that use them.
3. Apply [the core upgrade](../migrations/manual/2026-10-31_sensitivity_core.sql) using the deployment's reviewed D1 SQL execution procedure. It creates the core tables, views and triggers, then backfills current observable policy/type/tag sensitivity.
4. On deployments with trash tables, apply [the trash upgrade](../migrations/manual/2026-10-31_sensitivity_trash.sql) **after core**. Do not run the trash file against a lean schema without those tables. When enabling trash later, use the normal feature-enable migration generated from the updated fragment.
5. Deploy the matching code before releasing containment. Verify storage/schema failure refusal, active/retained policy resolution, PHI read withholding, history, clone/copy floors, private media and public publication refusal. Verify both core-only and installed-trash behavior as applicable.
6. Update regulated inventory to include retained container keys, including old/new names after taxonomy renames. Verify declared classes against the effective policy. A profile with incomplete or conflicting declarations must stay unavailable; do not automatically turn it off to repair admission.

The upgrade is idempotent, including backfill. Tests execute the actual manual files twice against a simulated pre-upgrade core/trash database and verify retained classifications. This is local migration evidence; no live database was upgraded by this work.

## Historic uncertainty and operating evidence

Backfill establishes floors from classifications and associations **still observable at upgrade**. It cannot reconstruct a policy, source type or association erased before installation, or infer sensitivity from unlabelled bodies. Review backups, previous evidence and recipient inventories. Quarantine unknown history/copies, restore reviewed source classification or apply an approved additive floor backfill from verified UUIDs before accepting regulated use. Never reset/lower existing floors to perform that backfill. Without operator containment, legacy content lacking any remaining classification evidence can still follow its current unclassified container policy; the migration cannot identify those cases automatically. Do not release containment on that assumption.

Read preparation protects observed/source-identified records. Dashboard draft, advanced-search, contributor page-list, quota, clone-estimate and trash counts now capture sensitivity in the same SQL statement as their total, including zero-result probes and grouped trash summaries. Published-dashboard projections, manual pulls and ingestion retain the source type and taxonomy set in the same query as their rows. Copy producers persist that source evidence and propagate the resulting floor. This protects the listed source-change races; it does not claim one transaction spanning source storage, audit, every producer and the response.

Existing public R2/CDN objects and direct published-DB consumers do not acquire protection merely because the CMS retains a floor. Contain/remove or reconcile those copies through their owners. Live-source provenance checks and PHI publication denial remain in force; do not republish PHI to repair metadata.

Floor storage is mandatory for the new code. Classification admission checks the presence of required core tables/views/capture triggers, and trash capture objects whenever trash tables exist. Missing objects or invalid policy/floor values withhold affected reads/publication; the regulated profile also refuses global admission. These are presence checks, not proof against a privileged attacker replacing trigger definitions or deleting metadata. Protect the objects from unreviewed privileged changes and include them in backups, restore drills and access review. Production trigger behavior, migration duration/load, actual copy cleanup and effective inventory still need verification.

There is no automatic rollback that drops floors or removes the new safeguards. Keep containment if rolling code back; older code can ignore retained floors. Clearing floor rows is a governed data/policy transition that needs complete copy/history evidence, authorization, durable audit and approved retention handling. The privileged fixture resets in tests are not a supported production procedure. Retention and controlled floor retirement remain owner/W4b/W5 work; no universal retention period is asserted.
