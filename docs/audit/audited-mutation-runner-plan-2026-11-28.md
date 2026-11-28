# Audited mutation runner: porting plan

**Status (29 November 2026)** Host settings, Wave A1, the page–tag prototype and P1–P6 are implemented. Targeted Workers regressions passed. The standard full suite remains pending.

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
| E1 | Several receipts per plan | Service groups share an operation ID and each carry an exact, individually classified receipt. A group can record a denial without a business write. | Plugin page update (implemented) |
| E2 | Classification from rows | `classify` may be a function of the snapshot rows, and a plan may add containers, for page types, taxonomies and tag sets known only after reading | Runtime types (done) |
| E3 | Read logging options | `read` becomes optional per snapshot, and can carry `uuidById` and page-type kinds so floor-aware page reads keep their exact evidence | Draft content |
| E4 | Pre-write checks | `plan.admit` statements run after admission and before the writes (for example an ID allocator still matching what `decide` read) | Credits administration (done) |
| E5 | Actor adapters | Signed-in writers use a capability or `self`. Request-based plugin writers supply their captured credential principal, classification and guards. Job writers use their captured subject and lease guards with optional request attribution. Store-table and system adapters remain separate. | Credits administration, plugin pages and claimed content jobs |
| E6 | Result rows | `returning` runs last. A session plan returns the first row and a service plan returns all rows. | Plugin registration and plugin page update (implemented) |
| E7 | Trailing statements | A grouped plan can run checkpoint statements after its page receipts and before final state and receipt verification. | Batch edits (implemented) |
| E8 | Sinks | `primary` (default), `outbox` (containment operations that must succeed during a primary audit outage, with delivery after commit) and `planned` (counter projections with a final guard) | `outbox`: identity disconnect; `planned`: plugin sequences |
| E9 | Error mapping | `passthrough(error)` keeps the writer's own errors and skips the outage incident. An async `unavailable` callback can record the writer's failure outcome before the runner reports the outage. | Locales (passthrough), plugin tag ensure (async outcome) |
| E10 | External inputs | Reads from another database (`PUBLISHED_DB`, R2) are passed into `decide` as unguarded input, because they cannot share the private D1 batch | Published-to-draft pull |
| E11 | Lost-acknowledgment reconciliation | The runner can verify exact receipts, state and current authority in a read-only batch after a failed submission. The original write is submitted once. | Trash lifecycle (implemented) |
| E13 | Follow-up snapshots | `decide` may snapshot rows that depend on the first ones (for example a plugin's owned approvals). They are read, logged and guarded at admission exactly like the first snapshot | Plugin registration (done) |
| E14 | Policy-derived classes | `decide` can read `tools.policy` and add raw classes, for rules such as a wildcard page-type grant covering every classified page type. Follow-up snapshots may classify from the rows they read | Plugin financial settings (done) |
| E12 | Decide clock | `decide` may read the transaction clock once, with trusted extra columns such as a next ID; the runner reuses it as the timestamp baseline. A `null` plan means no change | Runtime types (done) |
| E15 | Planned policy advance | Admit against the captured generation. Check the receipt and current authority against the exact expected final generation. Static final checks need no clock read. | Taxonomies and tags (implemented) |

## Waves

Line counts are the current file sizes. Estimates are engineering days, rough, and include the full-suite run and the review of each commit.

### Wave 0: done

| Writer | Tests | Result |
|---|---|---|
| [Host settings](../../src/core/evidence/settings-mutation-evidence.ts) | `settings-mutation-evidence` | 70 → 49 lines. Round trips 7 → 5 (no-op 6 → 4) after reading the policy once |

### Wave A1: signed-in admin, simple shape — done

Five writers moved; plugin approval, the published-to-draft pull and page access stay as they are, with reasons below. Round trips dropped for every moved writer.

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Runtime types and blueprint extensions](../../src/features/runtime-content-types/mutation-evidence.ts) | 96 | `runtime-type-mutation-evidence` | E2, E12 | **Done.** Three operations with one receipt each. Round trips: create 9 → 5, no-op 8 → 4, remove 8 → 5 |
| [Locales and messages](../../src/features/i18n/mutation-evidence.ts) | 106 | `locale-mutation-evidence`, `i18n` | E9 | **Done** (`e642aab`). Message save 8 → 5, no-op 8 → 4 |
| [Plugin registration](../../src/features/plugins/registration-evidence.ts) | 102 | `plugin-registration-evidence` | E6, E9, E12, E13 | **Done.** Create, toggle and remove 7 → 5. `capturePluginMutationContext` stays until approval and settings move |
| [Plugin approval](../../src/features/plugins/approval-evidence.ts) | 212 | `plugin-approval-evidence` | — | **Stays as is (rule 6).** It would need four bespoke hooks: containment revokes that skip the regulated gate, a guard batch mid-plan before fetching asset bytes, next IDs from `sqlite_sequence` with their own guards, and policy scans for overlapping storage prefixes. It keeps `capturePluginMutationContext` |
| [Plugin financial settings](../../src/features/plugins/settings-evidence.ts) | 68 | `plugin-financial-settings-evidence` | E13, E14 | **Done.** Shares `beginPluginRegistryMutation` with registration. Added a wildcard-grant classification test (passes before and after) |
| [Credits administration](../../src/features/credits/admin-mutation.ts) | 118 | `financial-administration-evidence` | E4, E5 `self`, E12, E13 | **Done.** Wallets and ledgers are a follow-up snapshot; ledger IDs come from the clock read. Counted from code: about 9–12 → 6 round trips. The users lookup is now logged as a read even for an unknown recipient (more evidence, not less) |
| [Published-to-draft pull](../../src/features/publish/pull.ts) | 131 | `sensitive-read-coverage` | — | **Stays as is (rule 6).** Its classification comes from the published source's read-evidence rows; its local snapshots are deliberately not logged; the existing-draft path logs a strict read keyed by the row's page type; the sensitivity pin has no fixed change count |
| [Page access policy](../../src/routes/admin/pages/access.ts) | 151 | `page-access` | — | **Stays as is (rules 1 and 6).** A guard failure answers 409 (reload and retry), not an outage 503; evidence is always class `none` with no policy guard; `INSERT OR IGNORE` grants have no fixed change count |

## Fit check after Wave A1 (28 November 2026)

The runner fits writers that snapshot whole tables and log every read. Page-centric writers deliberately log only the page read, keyed by page type and UUID (often through the request read buffer), check page access partway through planning, and some change the classification policy version inside their own batch. **Decision: the page pattern is deferred.** Writers that need it stay as they are until it is designed, rather than growing the runner one writer at a time.

| Group | Writers | Status |
|---|---|---|
| Fits now | Plugin automatic identity, plugin state, record holds, plugin taxonomy ensure | Next, once the `pluginCredential` actor (E5) lands |
| Needs its own check | Metered debits and the plugin publish API (no snapshot), submission ingestion (published source, floor changes), Wave D system writers | Check each before porting |
| Waits for the page pattern | All of Wave A2 and Wave B; plugin page create, update and delete; plugin tag ensure (request-buffered reads) | Deferred |

The page pattern would need, at least: per-snapshot read logging that can be off or custom (including request-buffered page reads), a page-access check in the actor step, writes that move the policy version, and 409 or denial answers next to the 503 path.

## Stopping point: keep the runner simple (28 November 2026)

**Decision: the runner stays at its current scope.** It serves signed-in admin changes that snapshot whole tables and log every read. Six writers use it: host settings, locales, runtime types, plugin registration, plugin limits and pricing, and credits administration. Every one of them dropped round trips (typically 7–9 down to 4–5). The code did not shrink: the runner is 234 lines, and the six writers together grew by 36 lines. What it bought is one fixed order of steps and fewer round trips.

The remaining writers were checked against the code, not just their read patterns. None fits without generalizing the runner's request context, actor or sink, so they stay as they are:

| Writer | Why it stays |
|---|---|
| Plugin state | Captures credential authority before the request body by design; its refusal writes a denied receipt with no business write |
| Plugin automatic identity | Runs with the environment only (no request, user or read buffer); joins a winning concurrent claim |
| Record holds | One receipt per hold, per-hold statuses, conditional updates instead of snapshot guards, one re-plan on a stale extension |
| Plugin taxonomy ensure | Runs under the plugin page-mutation authority (page family) |
| Display name and avatar | Guards only the session and account row; self-service authority would add the IP allowlist (a behavior change) and new read evidence |
| Wave D (job queue, retention, recurring billing) and the rest of Wave E (sessions, denials, outbox, sequences) | Environment-only cron or outbox code, or the planned counter sink |
| Wave F (sign-in flows) | Recommended to stay from the start |

Revisit only together with the deferred page pattern, and only if that design also covers a non-request (environment) context.

## Page pattern prototype (28 November 2026)

Design: an **aggregate** for one draft page ([`page-snapshot.ts`](../../src/core/pages/page-snapshot.ts)), loaded through one small runner seam (**source**). The aggregate owns the rules page writers repeat by hand: write access checked before anything else is read, the one logged page read (keyed by page type and UUID), guards that the page, its links, its tags and its floor are unchanged, ID allocation for a new link, and a final floor that may rise but never fall. The runner gained only the seam (`tools.source`), `read: null` for snapshots that are guarded but not logged, and a read-only `tools.dataClass()`.

First user: [page–tag association](../../src/core/evidence/tag-association-evidence.ts), 102 → 61 lines, with all 87 tests unchanged. Counted from code, an add drops from about 10 round trips to 7. Dropping the aggregate's floor check fails two tests. A new test revokes an editor's page ownership during the change and expects a 503 with no write and no event; it passes on the original writer and on the aggregate, and fails when the aggregate's page-access guard is dropped.

Next candidates for the aggregate are the draft editor and the batch writer, which repeat the same guards. They also need request-buffered page reads, 409 and denial answers, and multi-page snapshots, so each is a separate decision.

## P1 draft editor on the page aggregate

**Goal:** move [`saveDraftContent` and `removeDraftHistory`](../../src/core/evidence/mutation-evidence.ts) (147 lines; the page editor, quick create, restore and history deletion) onto `PageSnapshot`, so the second and largest page writer proves the aggregate generalizes. The runner stays as it is apart from one read mode.

**Why this one next:** it runs inside a signed-in request, like tag association. The batch writer and the trash lifecycle also run from queued jobs with only `env` and a user. That is the environment-only context the runner deliberately excludes, so they wait for a separate decision (P3).

### What changes

| # | Change | Where | Why the draft editor needs it |
|---|---|---|---|
| 1 | **Request read mode.** A source's reads can be `request` (recorded in the request read buffer and flushed, with request attribution) as well as today's background reads | runner `settle()`, about 5 lines | The editor logs `page.mutation-read` through `recordPageReads`, not as a background read |
| 2 | **Content fields.** The aggregate guards the full page row (every content field), not only `id, uuid, page_type, updated_at` | `PageSnapshot` option `fields: 'content'` | The editor's `pageGuard` checks every content field before writing |
| 3 | **Version set.** Optional snapshot of the page's version IDs, with a guard that the set is unchanged and a final check that exactly one new version was added | `PageSnapshot` option `versions: true`, plus an `expect` helper | Each save adds one `page_versions` row; history deletion removes a known subset |
| 4 | **Target tags.** The tags a save will link are passed in, classified, and checked to exist with the same taxonomy | `extraTagIds` exists; add a final "links equal the target set" helper | A save replaces the page's tag set |
| 5 | **New page.** A source for a page that does not exist yet: no row, no access check, only the target tags. A create also inserts the owner's access policy and checks it at the end | `PageSnapshot` returns an empty aggregate for `pageId: null` | Quick create and new pages |
| 6 | **Error mapping.** The writer's unavailable error is `ContentBatchEvidenceUnavailableError`, so routes calling `contentMutationUnavailable` do not record a second outage. `sensitivity_reduction_requires_review` passes through unchanged | writer spec only (`unavailable`, `passthrough`) | The page, dashboard, tag and publish routes already map errors this way |

Not changing: the denial path keeps its current behavior (record `management_permission_changed`, then fail as unavailable), and the save still returns the saved row through `returning`.

### Steps

1. Add the request read mode to the runner. Run every ported writer's tests (nothing should change: they all use background reads).
2. Extend `PageSnapshot` with options 2–5. Tag association keeps its current options and must pass unchanged.
3. Move `removeDraftHistory` first (no new page, no tag replacement). Run `content-mutation-evidence` and the history tests.
4. Move `saveDraftContent` (update, then create, then restore).
5. Mutation sanity checks: dropping the version-set guard, the content-field guard and the new-page policy check must each fail a test. Add a test for any that fails nothing, and confirm it also passes on the original writer, as done for page access.
6. Count round trips before and after for save and history deletion.
7. Full suite, then one commit per step 2–4.

**Tests that must pass unchanged:** `content-mutation-evidence`, `quick-create-mutation-evidence`, `sensitivity-floors`, `page-access`, `page-tag-association-evidence`, and every other ported writer's file.

**Estimate:** 1–1.5 engineering days. **Done when** both functions use the runner and the aggregate, every listed test passes unchanged, each new guard is shown to be covered, and round trips did not rise.

Both functions use the runner and the page aggregate. The runner preserves the editor's policy-denial receipt and binds draft document bodies outside the manifest size calculation.

All **873 tests across the 12 P1 regression files** passed in standalone workerd using local D1 and R2 bindings and the repository migrations. Disabling the version-set, full-content or new-owner-policy guard caused the corresponding request-level regression to fail. Both added regressions also passed against the pre-P1 writer. The ordinary `npm test` command still stops at the self-hosted plugin directory test because the sandbox denies its localhost listener.

The same HTTP fixtures executed the following D1 calls before and after P1. These counts include route and middleware work. For the writer alone, the SQLite harness measured 5 calls for create and 7–8 for update, restore and history deletion.

| Route action | Unclassified before → after | PHI before → after |
|---|---:|---:|
| Create | 18 → 18 | 18 → 18 |
| Update | 20 → 20 | 21 → 21 |
| Restore | 16 → 16 | 17 → 17 |
| Delete one history version | 15 → 15 | 16 → 16 |
| Delete all history | 15 → 15 | 16 → 16 |

### After P1 (each a separate decision)

| Phase | Writers | Status |
|---|---|---|
| P2 | Plugin page update, create and duplicate | Implemented. Targeted verification passed. Standard full-suite verification is pending. |
| P3 | Batch weights and bulk edits, trash lifecycle, plugin page delete | Implemented. Targeted verification passed. Standard full-suite verification is pending. |
| P4 | Taxonomies and tags | Implemented. Targeted verification passed. Standard full-suite verification is pending. |
| P5 | Plugin taxonomy and tag ensure | Implemented. Targeted verification passed. Standard full-suite verification is pending. |
| P6 | Plugin state PUT and DELETE | Implemented. Targeted verification passed. Standard full-suite verification is pending. |

#### P2 fit check

Plugin update and create both run inside requests. Their credential and registry audit-sequence checks are captured before the request body and must survive through the final batch. The request boundary alone leaves several additional contracts for the runner.

| Writer | Transaction behavior to preserve |
|---|---|
| [Plugin page update](../../src/features/plugins/page-update-evidence.ts) | Guard up to 100 selected pages together. Write successful and denied receipts with each page's classification under a shared operation ID. Denial-only requests also write receipts. Return every saved page. |
| [Plugin page create and duplicate](../../src/features/plugins/page-create-evidence.ts) | Keep guarded planning before credit reservation and distinguish known rollback from an uncertain commit for refunds. Preserve per-page receipts and duplicate chunk receipts, provenance and progress. |

The update writer exercises the credential and receipt changes independently of create's reservation and duplicate's chunk processing.

1. Reuse the branded plugin page authority captured before body parsing. Carry its plugin principal and policy into the runner, and keep its registry sequence, credential, pin and approval checks at admission and re-admission.
2. Load the selected pages, links, version metadata, tags and UUID floors as a bounded snapshot with the existing legacy page filter. Preserve protected source and result read attribution to the plugin.
3. Allow a single operation to commit exact, individually classified receipts for mixed or denial-only outcomes. Verify every receipt at the end of the same transaction. Preserve the existing 403, 409 and 503 responses and return successful rows in request order.
4. Run the existing update tests unchanged and compare D1 calls for single, bulk and denial-only requests. Evaluate create and duplicate once the update migration meets those checks.

Plugin PUT/PATCH and batch PATCH now use `beginServiceAuditedMutation`. The route still captures authority before parsing the body. The runner batches the selected snapshots under the captured policy, checks that authority at admission and completion, writes per-page receipts in transaction order, and verifies every receipt again before returning. The plugin writer retains source and result read attribution, per-page classifications, and response order.

| Request fixture | Unclassified before → after | PHI before → after |
|---|---:|---:|
| Single update | 43 → 37 | 48 → 42 |
| Bulk update | 43 → 37 | 48 → 42 |
| Mixed update and denial | 43 → 37 | 48 → 42 |
| Denial only | 22 → 16 | 24 → 18 |

The HTTP fixtures count D1 calls through each request. All **127 existing update tests** passed in standalone workerd. Disabling final receipt verification caused the regression for a later write corrupting an earlier receipt to fail. The updated runner also passed the **873 P1 regression tests** and **209 create and duplicate tests**.

Create and duplicate now use the same service runner for guarded intent and denial receipts and for each content transaction. The creation writer batches its contributor, configuration, parent, tag and floor snapshots under the captured policy. Intent and denial plans use checks that require no clock read. Content plans insert all selected pages before dependent history, link and receipt groups so forward-referenced parents work.

The runner reports whether it submitted the content batch. The plugin writer still determines whether a recorded failure supports a refund, and the existing duplicate workflow advances its cursor only after an acknowledged chunk. The credit reservation and refund orchestration and recovery-result evidence remain with the plugin writer.

| Request fixture | Unclassified before → after | PHI before → after |
|---|---:|---:|
| Single or bulk create | 70 → 61 | 75 → 66 |
| Quota denial | 47 → 38 | 49 → 40 |
| Duplicate 3 pages | 78 → 69 | 85 → 76 |
| Duplicate 101 pages | 97 → 88 | 107 → 98 |

All **209 existing create and duplicate tests** and **1,000 update and P1 regression tests** passed in standalone workerd. Disabling final receipt verification caused four create and duplicate regressions to fail, including a rewrite of a scope denial during the intent transaction. Standard `npm test` remains blocked by the self-hosted plugin directory test's localhost listener.

#### P3 batch and lifecycle transactions

- Batch weights, reorder and local bulk edits use the runner with signed-in user or claimed-job attribution. The worker supplies the current lease, and the runner commits the optional checkpoint with its page writes and receipts, including empty slices. Final guards check the checkpoint's effects on the page transaction.
- Trash, restore and purge batch their dependent snapshots under the captured classification policy. Claimed trash jobs can prove a submitted move by checking the exact receipt, current lease and source and destination state before publication withdrawal.
- Plugin delete passes its captured classification policy and credential guards into the shared lifecycle runner. The route owns selection and the intent receipt reused across chunks. It advances progress and starts external effects after acknowledging each chunk.

| Request fixture | D1 calls before → after |
|---|---:|
| Batch weights | 13 → 11 |
| Reorder | 14 → 12 |
| Inline bulk text replacement | 11 → 9 |
| Inline bulk tag addition | 12 → 10 |
| Claimed bulk edit with checkpoint | 22 → 20 |
| Host trash | 37 → 27 |
| Inline bulk trash | 32 → 22 |
| Restore | 26 → 15 |
| Purge | 23 → 15 |
| Plugin single or batch delete | 60 → 49 |
| Plugin delete children | 49 → 38 |

All **352 existing P3 tests** and **1,209 earlier regressions** passed in standalone workerd. The bulk publication round-trip budget stayed within its existing limits, and removing final receipt verification caused the checkpoint and plugin receipt corruption tests to fail. Standard `npm test` remains blocked by the localhost listener restriction.

#### P4 taxonomy and tag transactions

Taxonomy and tag create, edit and delete, plus batch tag weights, now use the runner. The shared snapshot reads current tag and taxonomy metadata, related draft and trash links, and retained page floors in policy-guarded batches. Existing tag and taxonomy read events keep their request attribution.

A rename with a retained taxonomy floor declares a one-generation advance. The runner admits against the original policy and verifies the exact expected generation in the receipt and final authorization guard. The writer verifies the destination floor. Ordinary writes expect the original generation throughout the transaction. Publication still follows a successful local commit.

| Request fixture | D1 calls before → after |
|---|---:|
| Taxonomy create | 11 → 10 |
| Taxonomy rename | 19 → 18 |
| Classified taxonomy rename | 17 → 16 |
| Taxonomy delete | 19 → 18 |
| Tag create | 18 → 17 |
| Tag edit | 19 → 18 |
| Tag delete | 16 → 15 |
| Batch tag weights | 18 → 17 |

All **166 taxonomy, policy-generation and settings-import tests** and **1,561 earlier regressions** passed in standalone workerd. Disabling the after-write authority check caused the session-revocation regression to fail. Standard `npm test` remains blocked by the localhost listener restriction.

#### P5 plugin taxonomy and tag provisioning

Both ensure routes use the grouped runner and reuse the plugin page authority captured before parsing. The runner guards the bounded snapshots under the captured policy and checks that authority and every receipt again before returning. Taxonomy ensure preserves its separate `taxonomy:create` approval and its guarded reuse path. Tag ensure keeps its per-tag, batch, and denial receipts, ordered results, and optional trash-link checks.

Tag ensure records known rollback or uncertain submission before the outage incident. An acknowledged transaction still precedes catalogue publication, and an error after acknowledgement records the local batch as committed.

| Request fixture | D1 calls before → after |
|---|---:|
| Taxonomy provision | 26 → 25 |
| Classified taxonomy provision | 18 → 17 |
| Taxonomy reuse | 17 → 16 |
| Mixed tag provision and reuse | 27 → 25 |
| Classified mixed tag provision and reuse | 26 → 24 |
| Tag reuse | 27 → 25 |
| Empty tag request | 22 → 20 |
| Tag write-scope denial | 12 → 12 |

All **69 focused plugin API and tag ensure tests** and **1,727 earlier regressions** passed in standalone workerd. Removing the final receipt verification caused both writers' regressions for a later receipt corrupting an earlier receipt to fail. The new taxonomy regression also passed on the original writer. Standard `npm test` remains blocked by the localhost listener restriction.

#### P6 plugin state transactions

The existing service adapter accepts the store authority captured before body parsing. The runner reads the exact selected entry and its metadata-only namespace catalogue together under the captured policy. Catalogue read evidence uses hashed keys and the captured policy. Success plans verify the entry and catalogue, and cap-denial plans verify the unchanged state and exact denial receipt before returning 409. Unchanged PUT and absent DELETE plans recheck the captured state and authority.

| Request fixture | Unclassified D1 calls before → after | PHI D1 calls before → after |
|---|---:|---:|
| Create, update or delete | 14 → 12 | 16 → 14 |
| Unchanged PUT or absent DELETE | 13 → 11 | — |
| Denial at the namespace cap | 13 → 11 | 15 → 13 |

Both plugin state suites passed all **120 existing tests**, and **1,796 earlier regressions** passed in standalone workerd. Disabling the final authority check caused the credential and identity pin rollback tests to fail. Standard `npm test` remains blocked by the localhost listener restriction.

### Wave A2: page and taxonomy writers

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Page–tag association](../../src/core/evidence/tag-association-evidence.ts) | 102 | `page-tag-association-evidence` | page aggregate | **Done** (page pattern prototype) |
| [Taxonomies and tags](../../src/core/evidence/taxonomy-mutation-evidence.ts) | 272 | `taxonomy-mutation-evidence`, `classification-policy-version`, `config-transfer` | E3, E15 | **Done** (P4). Exact generation advance and request-buffered reads. |
| [Draft content and history](../../src/core/evidence/mutation-evidence.ts) | 147 | `content-mutation-evidence`, `quick-create-mutation-evidence` | E2, E3, E4, E6, E9 | **Done** (P1). Uses the page aggregate to guard content, versions, links, floors, and the owner policy. |
| [Trash routes](../../src/features/trash/routes.ts) | 232 | `page-lifecycle-mutation-evidence` | — | **Stays as is.** Hold changes are about six lines with no snapshot and no policy guard; the runner would only add guards |
| [Audit administration](../../src/features/audit/routes.ts) | 319 | `audit-review`, `classification-policy-version` | — | **Stays as is.** `data_class.set` moves the policy version in its batch and answers a declassification with 409; already about 20 lines |

### Wave A3: users and roles (about 1–2 days; decision first)

[`role-writes.ts`](../../src/features/users-roles/role-writes.ts), [`roles.ts`](../../src/features/users-roles/routes/roles.ts), [`users.ts`](../../src/features/users-roles/routes/users.ts) and [`ip-access.ts`](../../src/features/users-roles/routes/ip-access.ts) (about 700 lines; tests `role-mutation-audit`, `role-store`, `ip-access`, `initial-user-roles`). These build receipts with `mutationAuditSelect`, which writes one receipt per affected row from SQL inside the batch (for example, every user losing a deleted role). **Decision gate:** add a receipt-from-SQL variant to the runner (E1b), or leave this family as is. Recommendation: leave it unless Wave A2 shows the declarations staying small, because its SQL-projected receipts are already a single coherent pattern.

### Wave B: queued jobs — P3 implementation

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Batch weights, reorder and bulk edits](../../src/core/evidence/batch-mutation-evidence.ts) | 204 | `page-batch-mutation-evidence`, `bulk-publish-round-trips` | E5 `job`, E1, E2, E7 | Runner handles attributed batch and per-page receipts. Existing round-trip budget passed. |
| [Job progress checkpoint](../../src/features/jobs/local-bulk-checkpoint.ts) | 47 | `page-batch-mutation-evidence` | E7 | Runs in the plan's `tail` before final verification. |
| [Trash, restore and purge lifecycle](../../src/features/trash/lifecycle-mutation-evidence.ts) | 236 | `page-lifecycle-mutation-evidence`, `record-lifecycle`, `plugin-page-delete-evidence` | E5 `job`, E1, E11 | Runner checks exact outcome before publication withdrawal after a lost acknowledgement. |

### Wave C: plugin credential (about 3–4 days)

All of these authenticate a plugin by its registry row, secret and identity pin ([`evidence-common.ts`](../../src/features/plugins/evidence-common.ts)). That helper becomes the `pluginCredential` adapter (E5), and `capturePluginStoreAuthority` becomes its store-table option.

| Writer | Lines | Tests | Needs | Notes |
|---|---|---|---|---|
| [Automatic plugin identity](../../src/features/plugins/automatic-identity-evidence.ts) | 52 | `plugin-registration-evidence` | E5 `plugin` | Smallest; introduces the adapter |
| [Plugin state](../../src/features/plugins/state-evidence.ts) | 100 | `plugin-state-mutation-evidence`, `plugin-state` | E1, E5 | **Done** (P6). Reuses the captured store authority. |
| [Record holds](../../src/features/plugins/hold-evidence.ts) | 119 | `plugin-holds` | store option, E1 | |
| [Taxonomy ensure](../../src/features/plugins/taxonomy-ensure.ts) | 104 | `cms-api` | E1, E5 | **Done** (P5). Separate taxonomy approval and per-taxonomy receipts. |
| [Tag ensure](../../src/features/plugins/tag-ensure-evidence.ts) | 172 | `plugin-tag-ensure-evidence`, `cms-api` | E1, E5, E9 | **Done** (P5). Per-tag and batch receipts, guarded return rows and outcome evidence. |
| [Page update](../../src/features/plugins/page-update-evidence.ts) | 185 | `plugin-page-update-evidence` | E2, E4 | **Done** (P2). Keeps the highest audit `seq` as a concurrency witness. |
| [Page create and duplicate](../../src/features/plugins/page-create-evidence.ts) | 199 | `plugin-page-create-evidence`, `plugin-page-duplicate-evidence` | E1, E2, E4 | **Done** (P2). Keeps quota, credit compensation and progress in the writer. |
| [Page delete](../../src/features/plugins/page-delete-evidence.ts) | 113 | `plugin-page-delete-evidence` | Wave B lifecycle | **Done** (P3). Each content chunk commits through the lifecycle runner. The route retains operation intent and progress. |
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
