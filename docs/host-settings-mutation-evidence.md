# Durable host system settings evidence

Local W4b continuation after `d373fdf`, 2 November 2026. `POST /admin/settings/system` now uses a guarded core transaction instead of independent preference writes and a best-effort audit event. This covers five fixed host keys; it does not turn the generic settings store into an audited writer for every feature.

| Host preference | Fixed storage key |
|---|---|
| Branding: name, icon, colour and font | `admin.app_branding` |
| Admin home destination | `admin.home` |
| System timezone | `admin.system_timezone` |
| Credit-summary display preference | `admin.show_credits` |
| Sidebar visibility, order, icons and translated labels | `admin.sidebar_menu.hidden_items` |

## Transaction contract

`src/core/db/settings-mutation-evidence.ts` captures all five keys, including absent keys, and uses their exact values/creation/update metadata as transaction preconditions. The stored-value snapshot is capped at 1,000,000 UTF-8 JSON bytes in SQL before values return to the Worker. Write manifests have the same byte limit and allow at most the five unique host keys. Other keys, duplicate entries and oversized plans refuse.

The route builds preserved timezone/sidebar state from that same snapshot. Existing normalization rules are shared as pure functions with the legacy helper APIs: name length/defaults, allowed icons/fonts, colour normalization, admin home filtering, weights, locked System visibility, labels and legacy menu format remain. Missing timezone/credit fields and unsubmitted labels retain their existing preservation rules. Disabled features retain their saved menu state. Optional locale/sidebar providers still define the rendered option catalogue; this is not a transaction-bound versioning contract for their registration or remote manifests.

Only changed stored values are upserted. Their writes, page-independent preference metadata and one exact classified `settings.system.update` receipt share a single private-D1 batch. The event uses `admin.system` as its scalar target and the complete changed fixed-key list as indexed targets/count. Detail contains a generated operation ID, classification generation, and a complete key/create-or-update manifest. It excludes raw or hashed values, branding/label text, URLs/query strings, plugin sidebar keys, secrets and actor profile values.

Classification follows the current effective `settings` table policy, including retained policy floors. Current account/session, `menu:manage`, role/grant catalogue and classification generation are checked inside the transaction, both before and after business writes. Classified snapshot reads are audited before mutation, and pending strict request reads are flushed. Final assertions verify the complete five-key membership, expected values, preserved creation times, transaction-time update bounds and exact unchanged rows, including preferences omitted from the form. Skipped/rewritten business or audit statements, unexpected policy/authority changes and stale values/metadata refuse the entire save.

An unchanged save validates its snapshot, authority and policy without changing timestamps or inventing a mutation event. Invalid submitted timezones retain the existing 303 error redirect before persistence; the legacy menu POST remains a redirect without a mutation. Successful system saves retain the existing redirect. Permission and regulated containment gates remain.

## Failure and remaining scope

A guarded failure returns `settings_change_unavailable`, 503/no-store, and attempts coarse incomplete health evidence without values or source errors. If the commit acknowledgment is lost, the save and its receipt can remain committed despite that response; no rollback claim, automatic retry or shared receipt lookup is added. R5 still owns request identity and uncertain-result recovery.

The legacy `saveSetting` and individual preference helpers remain for existing callers and tests; they are not authorized substitutes for this guarded host HTTP contract. Only this host system save is migrated. Runtime page/block types and blueprint extensions, locale/message administration, plugin registration/configuration/secrets/approvals and financial administration remain R2; plugin/service writers remain R3, external effects R4 and global/deployed acceptance R6. Read-only credit summaries and display visibility do not change pricing or ledger permissions.

No schema change, production migration, push, deployment or compliance sign-off occurred. Regulated writes remain blocked. The [scope register](w4b-remaining-scope-2026-11-02.md) retains five open W4b packages and the provisional 23–41 person-day range pending the rest of the R2 inventory.

## Validation

Validation: **51 new settings regressions** pass, covering classified attribution/redaction, all five insert/update failure points, exact audit failure/ignore/rewrite rollback, current and final authority/policy checks, stale values/metadata, no-op snapshots, omitted preferences, unrelated secrets, invalid inputs, byte bounds, transaction timestamps and lost acknowledgments. The focused run passed **392 tests across seven files**; the complete serial run passed **2,246 tests across 82 files**. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. Runtime tests were explicitly scoped with `--dir test` after an earlier filtered run discovered an unrelated nested checkout under `.claude/worktrees`; that broader run was interrupted and is not used as acceptance evidence. The final full run emitted the previously recorded uncaught Worker request-cancellation diagnostic near advanced-search queue tests despite reporting all tests passed. Its cause remains unresolved under R6; this is not clean runtime/release acceptance and no fix is claimed. These are local repository results, not deployed acceptance.
