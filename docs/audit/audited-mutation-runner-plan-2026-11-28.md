# Audited mutation runner: porting plan

**Status: planned. Wave 0 (host settings) is done in `e10487f` and `7b42787`.** This is an engineering refactor plan, not compliance evidence. It changes how writers are structured, not what they prove.

## Goal

Every audited D1 write states the same four things and lets one runner, [`audited-mutation.ts`](../../src/core/evidence/audited-mutation.ts), do the rest in a fixed order:

| The writer declares | The runner owns |
|---|---|
| **Actor**: who is acting and which capability they need | Regulated-writes gate |
| **Classify**: which containers decide the evidence class | Fresh authority, with the classification policy read once |
| **Snapshot**: the rows the decision depends on, and how their read is logged | Bounded snapshots batched behind a policy guard, then read evidence |
| **Decide**: a pure plan of writes, receipts and expected final state | Commit batch: admission → writes with `changes()` checks → receipts → postconditions → re-admission |
| | Failure: coarse outage incident, then the writer's own error |

Today about 45 files and 5,000 lines build these steps by hand, in different orders and under different names. Once a writer has moved, it reads as a declaration. Later changes, such as the audit-recording-off switch or one shared policy read, then happen in one place.

## Rules for every port

1. **Behavior is preserved.** Each writer's existing tests pass **unchanged**, apart from imports. A test that has to change is a behavior change: stop and decide it separately.
2. **One writer per commit**, with any runner extension it needs in the same commit. Nothing speculative: a runner extension only lands with the first writer that uses it.
3. **Mutation sanity check.** Before committing, disable one guard the runner now emits (for example the re-admission guard or a snapshot guard) and confirm a test fails. Restore it, then commit.
4. **Full suite and repository checks** (`npm test`) pass at every commit.
5. **Record round trips** before and after for the writer's main path, using a throwaway counting test. Note them in the commit message. A port must not add round trips.
6. **Escape hatch.** If a writer would need more than one bespoke hook in the runner, it stays as it is and the reason is recorded in the table below. The runner must not grow into a copy of every writer.
7. **Docs.** If a `docs/audit/*-evidence.md` record describes the steps by file or function name, update the reference in the same commit.

## Runner extensions

Each extension is added by the first writer that needs it (named in the "First user" column).

| # | Extension | What it adds | First user |
|---|---|---|---|
| E1 | Several receipts per plan | `evidence` becomes a list. One operation ID is shared across the receipts, plus an optional per-receipt `targetIds` | Taxonomies (to confirm) |
| E2 | Classification from rows | `classify` may be a function of the snapshot rows, and a plan may add containers, for page types, taxonomies and tag sets known only after reading | Runtime types (done) |
| E3 | Read logging options | `read` becomes optional per snapshot, and can carry `uuidById` and page-type kinds so floor-aware page reads keep their exact evidence | Draft content |
| E4 | Extra admission guards | `admit(rows)` returns more statements emitted with the admission guards and again at re-admission (page access, floors, version sets) | Page access |
| E5 | Actor adapters | `sessionUser(permission)` exists. Adds `self()`, `job(lease, capability)`, `pluginCredential(auth, storeTable?)` and `system(via)`. Each returns the actor, its guards and how receipts are attributed (attributed vs service) | `self`: tag association; `job`: batch; `plugin`: automatic identity; `system`: job retention |
| E6 | Result rows | `returning` statement appended last; its first row comes back from `commit` | Plugin registration (done) |
| E7 | Trailing statements | `tail(plan)` adds statements after the postconditions, such as job checkpoints and delegation guards | Batch edits |
| E8 | Sinks | `primary` (default), `outbox` (containment operations that must succeed during a primary audit outage, with delivery after commit) and `planned` (counter projections with a final guard) | `outbox`: identity disconnect; `planned`: plugin sequences |
| E9 | Error passthrough | `passthrough(error)` lets the writer's own errors escape unchanged, with no outage incident | Locales (done) |
| E10 | External inputs | Reads from another database (`PUBLISHED_DB`, R2) are passed into `decide` as unguarded input, because they cannot share the private D1 batch | Published-to-draft pull |
| E11 | Lost-acknowledgment reconcile | `reconcile(plan)` checks for the writer's own receipt after an uncertain commit, returning the result or rethrowing; it never replays the write | Trash lifecycle |
| E13 | Follow-up snapshots | `decide` may snapshot rows that depend on the first ones (for example a plugin's owned approvals). They are read, logged and guarded at admission exactly like the first snapshot | Plugin registration (done) |
| E12 | Decide clock | `decide` may read the transaction clock once, with trusted extra columns such as a next ID; the runner reuses it as the timestamp baseline. A `null` plan means no change | Runtime types (done) |

## Waves

Line counts are the current file sizes. Estimates are engineering days, rough, and include the full-suite run and the review of each commit.

### Wave 0: done

| Writer | Tests | Result |
|---|---|---|
| [Host settings](../../src/core/evidence/settings-mutation-evidence.ts) | `settings-mutation-evidence` | 70 → 49 lines. Round trips 7 → 5 (no-op 6 → 4) after reading the policy once |

### Wave A1: signed-in admin, simple shape (about 1–1.5 days)

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Runtime types and blueprint extensions](../../src/features/runtime-content-types/mutation-evidence.ts) | 96 | `runtime-type-mutation-evidence` | E2, E12 | **Done.** Three operations with one receipt each. Round trips: create 9 → 5, no-op 8 → 4, remove 8 → 5 |
| [Locales and messages](../../src/features/i18n/mutation-evidence.ts) | 106 | `locale-mutation-evidence`, `i18n` | E9 | **Done** (`e642aab`). Message save 8 → 5, no-op 8 → 4 |
| [Plugin registration](../../src/features/plugins/registration-evidence.ts) | 102 | `plugin-registration-evidence` | E6, E9, E12, E13 | **Done.** Create, toggle and remove 7 → 5. `capturePluginMutationContext` stays until approval and settings move |
| [Plugin approval](../../src/features/plugins/approval-evidence.ts) | 212 | `plugin-approval-evidence` | E1 | Builds on the registration snapshot. Also guards before disclosing to the plugin |
| [Plugin financial settings](../../src/features/plugins/settings-evidence.ts) | 68 | `plugin-financial-settings-evidence` | — | Builds on the registration snapshot |
| [Credits administration](../../src/features/credits/admin-mutation.ts) | 118 | `financial-administration-evidence` | E5 `self` | Uses both access and self authority |
| [Published-to-draft pull](../../src/features/publish/pull.ts) | 131 | `sensitive-read-coverage` | E10 | Published database read is external input |
| [Page access policy](../../src/routes/admin/pages/access.ts) | 151 | `page-access` | E4, E5 `self` | |

### Wave A2: content writers (about 2–3 days)

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Page–tag association](../../src/core/evidence/tag-association-evidence.ts) | 102 | `page-tag-association-evidence` | E2, E5 `self` | |
| [Taxonomies and tags](../../src/core/evidence/taxonomy-mutation-evidence.ts) | 188 | `taxonomy-mutation-evidence` | E1, E2 | Five receipts in one file; port one operation per commit |
| [Draft content and history](../../src/core/evidence/mutation-evidence.ts) | 147 | `content-mutation-evidence`, `quick-create-mutation-evidence` | E2, E3, E4, E6, E9 | The largest guard set (versions, tags, floors, access policy). Port `removeDraftHistory` first, then `saveDraftContent` |
| [Trash routes](../../src/features/trash/routes.ts) | 232 | `page-lifecycle-mutation-evidence` | E4 | |
| [Audit administration](../../src/features/audit/routes.ts) | 319 | `audit-review`, `classification-policy-version` | — | One receipt (`data_class.set`); keep its read recording as is |

### Wave A3: users and roles (about 1–2 days; decision first)

[`role-writes.ts`](../../src/features/users-roles/role-writes.ts), [`roles.ts`](../../src/features/users-roles/routes/roles.ts), [`users.ts`](../../src/features/users-roles/routes/users.ts) and [`ip-access.ts`](../../src/features/users-roles/routes/ip-access.ts) (about 700 lines; tests `role-mutation-audit`, `role-store`, `ip-access`, `initial-user-roles`). These build receipts with `mutationAuditSelect`, which writes one receipt per affected row from SQL inside the batch (for example, every user losing a deleted role). **Decision gate:** add a receipt-from-SQL variant to the runner (E1b), or leave this family as is. Recommendation: leave it unless Wave A2 shows the declarations staying small, because its SQL-projected receipts are already a single coherent pattern.

### Wave B: queued jobs (about 2 days)

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Batch weights, reorder and bulk edits](../../src/core/evidence/batch-mutation-evidence.ts) | 204 | `page-batch-mutation-evidence`, `bulk-publish-round-trips` | E5 `job`, E1, E2, E7 | Per-page receipts. The round-trip budget test must not get worse |
| [Job progress checkpoint](../../src/features/jobs/local-bulk-checkpoint.ts) | 47 | `page-batch-mutation-evidence` | E7 | Becomes the batch writer's `tail` |
| [Trash, restore and purge lifecycle](../../src/features/trash/lifecycle-mutation-evidence.ts) | 236 | `page-lifecycle-mutation-evidence`, `record-lifecycle`, `plugin-page-delete-evidence` | E5 `job`, E1, E11 | Same-invocation reconcile before published withdrawal |

### Wave C: plugin credential (about 3–4 days)

All of these authenticate a plugin by its registry row, secret and identity pin ([`evidence-common.ts`](../../src/features/plugins/evidence-common.ts)). That helper becomes the `pluginCredential` adapter (E5), and `capturePluginStoreAuthority` becomes its store-table option.

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Automatic plugin identity](../../src/features/plugins/automatic-identity-evidence.ts) | 52 | `plugin-registration-evidence` | E5 `plugin` | Smallest; introduces the adapter |
| [Plugin state](../../src/features/plugins/state-evidence.ts) | 54 | `plugin-state-mutation-evidence`, `plugin-state` | store option | |
| [Record holds](../../src/features/plugins/hold-evidence.ts) | 119 | `plugin-holds` | store option, E1 | |
| [Taxonomy ensure](../../src/features/plugins/taxonomy-ensure.ts) | 109 | `plugin-tag-ensure-evidence` | — | |
| [Tag ensure](../../src/features/plugins/tag-ensure-evidence.ts) | 88 | `plugin-tag-ensure-evidence` | E1 | Per-tag and batch receipts |
| [Page update](../../src/features/plugins/page-update-evidence.ts) | 185 | `plugin-page-update-evidence` | E2, E4 | Uses the highest audit `seq` as a concurrency witness; keep it as an admission guard |
| [Page create and duplicate](../../src/features/plugins/page-create-evidence.ts) | 199 | `plugin-page-create-evidence`, `plugin-page-duplicate-evidence` | E1, E2, E4 | Seven receipts and 21 guards: the hardest in this wave. Escape hatch candidate |
| [Page delete](../../src/features/plugins/page-delete-evidence.ts) | 113 | `plugin-page-delete-evidence` | Wave B lifecycle | Delegates to the trash lifecycle, so it follows Wave B |
| [Metered debits](../../src/features/credits/debit-evidence.ts) and [contributor credits API](../../src/features/credits/routes/contributor-api.ts) | 506 | `plugin-credits`, `credits`, `diamond-credits` | E1 | Keyed replay must still prove the stored response in the debit batch |
| [Plugin publish API](../../src/features/plugins/routes/publish-api.ts) | 157 | `outbound-publication-audit` | — | |
| [Submission ingestion](../../src/features/publish/submission-ingest.ts) | 276 | `submission-ingest` | E10, `system` or `plugin` | Two entry points: scheduled service and plugin |

### Wave D: system cron (about 1–2 days)

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Job retention](../../src/features/jobs/services.ts) | 65 | `record-lifecycle` | E5 `system` | Introduces the adapter |
| [Job enqueue, claim and outcome](../../src/features/jobs/queue.ts) | 318 | `page-batch-mutation-evidence`, `sensitivity-floors` | E5 `system`, E11 | Claim recovery looks up its own `job.claim` receipt |
| [Recurring billing](../../src/features/credits/subscriptions.ts) | 416 | `credit-subscriptions` | E5 `system` and `plugin`, E1 | Paid and schedule-only settlement, plus usage reports |

### Wave E: outbox and counter sinks (about 1–2 days)

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Identity disconnect and display name](../../src/core/auth/self-profile.ts) | 160 | `self-profile-mutation-audit` | E8 `outbox`, E5 `self` | Disconnect uses the outbox; a name edit uses the primary sink |
| [Session removal](../../src/core/evidence/session-evidence.ts) | 99 | `session-lifecycle-evidence` | E8 `outbox`, `system` | Up to 50 receipts in one batch; delivery is left to the sweeper |
| [Authentication denials](../../src/core/auth/denials.ts) | 58 | `auth-denial-evidence` | E8 | Standalone refusals with no business write. **Probably stays as is**: there is nothing for the runner to guard |
| [Plugin sequences](../../src/features/plugins/sequence-evidence.ts) | 74 | `plugin-sequence-mutation-evidence`, `plugin-sequences` | E8 `planned` | Counter values live in the receipt detail |

### Wave F: sign-in flows (half a day to evaluate)

[`sessions.ts`](../../src/core/auth/sessions.ts), [`oauth-account.ts`](../../src/core/auth/oauth-account.ts) and [`registration.ts`](../../src/core/auth/registration.ts) (535 lines). These run before a CMS session exists, or create one, with bespoke envelopes and token handling. **Recommendation: keep them as they are**, unless Waves A–E leave the adapters able to express them with no new hooks. Record the decision here either way.

### Out of scope: best-effort `logAudit` callers

These write their audit row after the change, not in the same transaction: [`page-events.ts`](../../src/core/page-events.ts), [`bulk-action.ts`](../../src/core/pages/bulk-action.ts) summaries, media [upload](../../src/features/media/routes/upload.ts) and [files](../../src/features/media/routes/files.ts), plugin [hooks](../../src/features/plugins/hooks.ts) and [hook API](../../src/features/plugins/api/hooks.ts), [plugin management](../../src/features/plugins/routes/manage.ts) and [publish routes](../../src/features/publish/routes.ts). Moving them onto the runner would make them refuse the change when audit is unavailable. That is a behavior change belonging to the W4b R3–R6 scope, not this refactor, and needs its own decision.

## Order and dependencies

```text
Wave 0 (done) ─┬─ A1 ─ A2 ─┬─ A3 (decision)
               │           └─ B ─┬─ C (page delete after B)
               │                 └─ D
               └──────────────────── E (after A1 introduces E5 self)
F: evaluate after E
```

Waves must run in this order within one checkout, because each wave extends the same runner file. Parallel sessions would conflict on `audited-mutation.ts`.

## Estimate and done criteria

Rough total: **12–17 engineering days** for Waves A1–E, plus half a day to decide on A3 and F. The plan is done when:

- Every writer in Waves A1–E either uses the runner or has a recorded escape-hatch reason in this file.
- Every original test file passes unchanged, and `npm test` passes at each commit.
- Round trips for each ported writer are recorded, and none got worse.
- The runner's header comment still describes the full recipe, including every extension E1–E11 that landed.

## Enabled afterwards

- **Audit recording off:** one switch in the runner can skip classification, read evidence, receipts and postconditions for every ported writer (Waves A1–C), cutting a settings save from 5 round trips to 3. Writers that use `audit_events` as working data (job claims, session rotation, plugin sequences, role deletion, the plugin `seq` witness) need their state moved first.
- **Generated evidence records:** once writers are declarations, the per-writer `docs/audit/*-evidence.md` files could be generated from them.
