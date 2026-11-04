# W12 — privacy, retention and deletion

Record for W12 in [the compliance plan](compliance-implementation-plan-2026-10-30.md). The plan asks for these to be approved:
- purposes and transfer rules;
- a retention schedule and holds.

It asks for deletion to be mapped across current data, versions, trash, files, published copies, exports, plugins and backup expiry. Only verified lifecycle omissions are to be implemented, and restoration must respect deletion and holds.

Started 4 November 2026 at `883df7c`. **The deletion map, three fixes, holds, opt-in retention and a synthetic lifecycle test are done. No retention period, purpose or request procedure is approved, so A.5.33, A.5.34 and A.8.10 stay open.**

Controls: A.5.33, A.5.34, A.8.10, plus parts of A.5.12, A.5.14, A.8.11, A.8.12.

## Deletion map

| Data | How it's deleted | Retention today |
|---|---|---|
| Draft page, its versions and tag links (`DB.pages`, `page_versions`, `page_tags`) | Delete moves all three to trash in one guarded batch and unpublishes from every target | Kept while the page exists |
| Trash (`trash_pages`, `trash_page_versions`, `trash_page_tags`) | Purge, by row or in bulk; children cascade | **Until purged by hand.** With `TRASH_RETENTION_DAYS` set, "Purge expired" removes older rows (below) |
| Published copy (`PUBLISHED_DB`, `PUBLISH_BUCKET`) | Removed by unpublish, which delete triggers | Follows the draft |
| **Submission source row** (`PUBLISHED_DB.pages`, written by a public Worker) | **Was never deleted** (fixed below) | Erased when its mirror is purged |
| Media (`media_files`, `MEDIA_BUCKET`) | Delete removes the object and the row | Kept until deleted. Edge caches already holding a public copy (`max-age=31536000`) must be purged at Cloudflare |
| Users (`users`, `sessions`, `user_oauth_identities`) | User removal deletes all three | Pages keep `creator`/`editors` ids; audit keeps actor ids |
| Admin jobs (`admin_jobs`) | Never deleted | **Body and user snapshot kept forever** (fixed below: opt-in clearing) |
| Audit events (`audit_events`) | Archived to R2, then pruned per retention class | Hot copy: 90 days for access and auth, 365 for mutations and config ([sweep.ts](../src/features/audit/sweep.ts)). Archive: the R2 bucket's own lock and lifecycle (W5) |
| Plugin data (`plugin_state`, plugin Workers' own stores) | Written and deleted by the plugin | Each plugin's own rule |
| Exports (`wrangler d1 export`, W10/W11) | Outside the CMS | Must follow the evidence system's retention. An export holds every row |
| Backups (D1 Time Travel) | Expire with the Time Travel window | A deleted row stays recoverable until the window passes. Confirm the window for the plan (W11) |

## What changed

### 1. Deleted submissions came back

Ingest re-scans the whole published database on every complete pass, and re-mirrored any row without a draft. The code comment called this intentional. So a submission an editor trashed or purged came back as a new draft at the next pass. Its source row, which holds the personal data, was never deleted at all.

- **Ingest now skips** any uuid in trash or erased ([submission-ingest.ts](../src/core/db/submission-ingest.ts)).
- **Purging a submission mirror erases its source** ([submission-erasure.ts](../src/core/pages/submission-erasure.ts)):
  - The purge batch records the uuid in `submission_erasures`, and the purge audit event lists it under `source_erasures`.
  - After the purge commits, the published row and its tag links are deleted, and `erased_at` confirms it.
  - If the published database is unreachable, the erasure stays pending and cron retries it.
- **Restoring respects erasure.** A published database restored from backup still holds erased rows. Ingest won't mirror them, because their uuids are in `submission_erasures`. To delete them again, run `UPDATE submission_erasures SET erased_at = NULL` and let cron re-erase them. This is now step 5 of the [W11 restore procedure](w11-backup-continuity.md#restoring).

**Cross-repository effect:** anything that reads submissions straight from the published database loses a row once its mirror is purged. The plugin-form admin tables and CSV exports are examples. That's the intended effect of erasure.

### 2. Holds

A hold blocks permanent deletion of one page until it's released. Holds are stored in `record_holds`, keyed by page uuid, so a hold can be placed before a page is deleted.

- **Explicit purge** of a held page, or of a parent whose purge would cascade to one, is refused: "Page is under hold".
- **Empty trash and "Purge expired"** pass over held pages and their trash ancestors.
- **Race protection:** a hold placed between the read and the commit aborts the batch.
- **Placing and releasing** need the new `records:hold` permission, which only administrators have by default. That keeps it apart from `trash:purge`. Each change is written with its audit receipt (`hold.place`, `hold.release`) in the same batch. A released hold is kept, recording who released it and when.
- **Screens:** the trash list marks held pages and offers Hold per row. `/admin/holds` lists holds, places one by uuid and releases.

### 3. Opt-in retention

Both settings are off until a data owner sets a period ([wrangler.example.toml](../wrangler.example.toml)):

| Setting | Effect |
|---|---|
| `TRASH_RETENTION_DAYS` | The trash offers **Purge expired**. It removes pages in trash longer than the period, except held ones, and the audit event records `retention_days`. An administrator runs it: purge needs a signed-in user's authority and evidence, so cron never purges content. |
| `JOB_RETENTION_DAYS` | Cron clears the request body and user snapshot of admin jobs finished (`done` or `failed`) longer ago. The rest of the row stays as the record that the job ran. Queued and running jobs are untouched. |

## Verification

**[test/record-lifecycle.test.ts](../test/record-lifecycle.test.ts)**, 9 tests:

- **A synthetic submission, end to end:**
  1. It's ingested, then trashed, and doesn't return when the ingest cursor wraps.
  2. It's purged: gone from both databases, with the erasure confirmed and listed in the audit event.
  3. It's re-inserted as if restored from backup, and not re-mirrored.
- **Published database unreachable at purge:** the erasure stays pending, then completes on a later pass.
- **An ordinary purge** records no erasure.
- **Holds:**
  - A hold refuses the explicit purge, and "Empty all" and "Purge expired" skip it while purging the unheld page.
  - Release, then purge, succeeds, and both hold changes are audited with who placed and released them.
  - A held child protects its parent.
  - A hold placed before deletion still applies.
  - An editor without `records:hold` is refused with 403.
- **Retention:**
  - With no period set, "Purge expired" does nothing.
  - With 30 days, only the 40-day-old page goes.
  - Job bodies clear only for finished jobs past the period.

**Views:** the trash and holds sections render in the browser. They were rendered with the admin's own Liquid build against sample data, and 8 of 8 checks passed: badge, hidden delete and hold forms on held rows, purge-expired label, release forms, and released-by display.

**Upgrade:** the core change ships as `migrations/manual/2026-11-04_record_holds_erasures.sql`. `check-upgrade-path --from f9719a3` applies it, and the result matches a fresh install.

**Full suite:** 96 files, 3,477 tests passing.

## What W12 still needs from people

1. **The privacy lead and data owners approve** purposes, the retention schedule (including the two periods above and the audit hot periods), and transfer rules.
2. **Set the periods** in each deployment once approved, and decide who runs "Purge expired" and how often.
3. **Write the individual-request procedure** (access, correction, erasure), with who answers and what the CMS covers. Erasure through the CMS is complete for pages and submissions after purge. It isn't immediate for Time Travel history, exports already taken, edge caches, or plugin-held data. Say so to requesters rather than promising immediate erasure.
4. **Agree with each plugin operator** how their own stores are deleted (W10 supplier register).
5. **Run the lifecycle once on staging** with a real submission form, including the plugin-form admin view after purge.

Earlier findings this package doesn't change:
- The PHI mutation retention class is never emitted.
- The legacy `audit_log` table is unused.
