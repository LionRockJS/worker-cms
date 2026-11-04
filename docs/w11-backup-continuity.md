# W11 — backup and continuity

Record for W11 in [the compliance plan](compliance-implementation-plan-2026-10-30.md): agree business impact, RPO/RTO and emergency-operation needs. Verify current backup and recovery first, then implement missing independent copies or automation. Cover the private and published D1 databases, private media, any necessary Durable Object state, policy and configuration, plugin dependencies and safe credential recovery. Started 3 November 2026 at `88a1a0c`. **The repository side, one local restore drill and the disruption tests are done. No objective is approved and no copy exists outside Cloudflare, so A.5.30 and A.8.13 stay open.**

Controls: A.5.29, A.5.30, A.8.13, plus parts of A.8.14.

## What exists today

| State | Where it lives | Recovery the platform gives | Independent copy |
|---|---|---|---|
| Private D1 (`DB`): users, sessions, pages, versions, trash, roles, plugins, audit hot rows, seals, jobs | Cloudflare D1 | Time Travel: restore to any minute inside the plan's window. Confirm the window for the account's plan | **None** |
| Published D1 (`PUBLISHED_DB`): published pages, submissions | Cloudflare D1 | Same | **None** |
| Media (`MEDIA_BUCKET`), published snapshots (`PUBLISH_BUCKET`) | R2 | None: a deleted or overwritten object is gone | **None** |
| Audit archive (`AUDIT_BUCKET`) | R2 | Bucket lock, if the deployment sets it (W5) | The checkpoint receiver holds the hash chain, not the segments |
| Incident journal (`AUDIT_OUTAGE_BUCKET`) | R2 | Same as the audit archive | None |
| PageSync, FormOnce Durable Objects | Durable Object storage | Not needed: unsaved edits and single-use tokens | n/a |
| Admin jobs queue | Queues | Not needed: state is in `DB.admin_jobs` | n/a |
| Configuration | `wrangler.production.toml` per deployment, outside this repository | Git history of wherever it is kept | Depends on where it is kept |
| Secrets | Worker secrets | Not readable back | Owners hold or re-generate them (W9) |

Same-database page versions and trash are history, not backup. Time Travel is inside the same Cloudflare account as the database it protects. It doesn't cover R2, and it doesn't help if the account is lost or the database is deleted. Confirm with Cloudflare what happens to Time Travel history when a database is deleted. **Finding:** nothing in source or CI makes a copy outside Cloudflare, so A.8.13 has no independent backup.

## Proposed objectives (for the business owner to approve)

These are starting points, not approved values.

| Scenario | Recovery route | Proposed RPO | Proposed RTO |
|---|---|---|---|
| Bad change, bad import or mistaken deletion in D1 | Time Travel restore to just before the change | 1 minute | 2 hours |
| Media or snapshot object deleted or corrupted | Restore from the independent R2 copy | 24 hours | 4 hours |
| Cloudflare account lost or database deleted | New account and resources, from independent copies | 24 hours | 2 working days |
| Cloudflare regional or global outage | Wait; no second provider is planned | n/a | Cloudflare's own restoration |

## Restore drill

[tools/check-export.mjs](../tools/check-export.mjs) now checks a restored set as well as an export:

```
node tools/check-export.mjs --file <cms.sql> --media <media copy> --audit <audit copy>
```

- **The database:** loads, passes integrity and foreign-key checks, and has the same schema as a fresh install.
- **Media:** every `media_files` row has its object at the recorded size. An object with no row is listed for review: plugin files have no row.
- **Audit archive:** every `audit_seals` row has its segment, the segment hashes to the sealed value, holds the sealed event count, and the seals chain with no gap in sequence numbers. A segment with no seal is listed for review.
- **Timings:** each step is timed for the RTO record.

### Local drill, 3 November 2026

I used throwaway local data in a worktree, never a deployed database:
1. Applied every current migration with `wrangler d1 migrations apply --local`.
2. Seeded synthetic rows: 200 media rows and files, one plugin file with no row, and 20 seals covering 10,000 events. The segments were gzipped canonical NDJSON in the sweep's format 1.
3. Exported with `wrangler d1 export --local`.
4. Ran the tool on the export.

| Check | Result |
|---|---|
| Database | Integrity `ok`, 0 foreign-key violations, schema matches a fresh install, 226 rows |
| Media | 200 of 200 objects present at the recorded size; the plugin file is listed for review |
| Audit archive | 20 seals, 10,000 events, chain intact, no unsealed segment |
| Timings | Load 7 ms; schema 4 ms; media 3 ms; audit 14 ms |

**Negative check:** in a damaged copy of the same set:
- one media object was deleted and another truncated;
- one segment was re-gzipped with one event altered;
- one segment was deleted;
- one stray segment was added.

The drill failed on each of the four errors and listed the stray segment for review.

This proves the restore check, not a production restore. Recovery time at real size still needs a staged run.

## Restoring

1. **Stop writes.** The CMS has no maintenance switch, so this means removing the route or deploying a holding Worker. Otherwise writes made during the restore are lost or land on top of it. **Finding:** there is no emergency read-only mode.
2. **D1 within the Time Travel window:**
   1. `wrangler d1 time-travel info <db> --timestamp <before the incident>`, and record the bookmark it prints.
   2. `wrangler d1 time-travel restore <db> --bookmark <bookmark>`, and record the bookmark it returns for undoing the restore.
   3. Do the same for the published database if it was affected.
3. **D1 from an independent copy:** create a new database, then `wrangler d1 execute <db> --remote --file <export.sql>`.
4. **R2:** copy objects back with any S3-compatible client that keeps object metadata. **The copy must keep `cmsPrivate`:** media uploaded under a classified prefix carries `cmsPrivate: 1` in R2 custom metadata, which the public route honours alongside the classification table. Copying to a plain file system drops it. After a restore, `HEAD` one known private object and confirm the marker is there.
5. **Re-apply erasures (W12):** a restored published database can hold submissions that were erased after the backup was taken. If the private database wasn't restored to an earlier point, run `UPDATE submission_erasures SET erased_at = NULL` on it, so cron deletes them again. Ingest never re-mirrors them meanwhile.
6. **Check before reopening:** export the restored database and run the drill tool against the restored bucket copies.
7. **Credentials:** secrets are not in any backup. Each owner re-sets them from their own record or re-generates them (W9). A new `JWT_SECRET` signs everyone out, which is the right result after an account loss.
8. **Plugins:** registrations and approvals come back with the database. Each plugin Worker must still be reachable at its registered URL with the same `PLUGIN_SECRET`. A plugin's own data is that plugin's backup.

## Security during disruption

[test/disruption.test.ts](../test/disruption.test.ts) issues a session, then takes the private database away. A baseline shows the same requests succeed while the database is reachable. With it unreachable:
- an admin read with a valid access token is refused with 5xx and no data;
- an admin change is refused, and the target row is untouched;
- a refresh token gets no new access token;
- a public media object is withheld with 404 or 503, never served on the token's word or from a skipped classification check.

Audit-store outages were already covered by W4 (fail-closed reads and mutation evidence).

## What W11 still needs from people

1. **The business owner approves the objectives** above, or replaces them.
2. **The operations owner chooses where independent copies live:** another account or provider, with separate credentials and encryption. Also choose how often copies are taken and how long they are kept, coordinated with W12 retention. An export holds every row, PHI included, so the destination needs the same agreements as the source (W10).
3. **Automate the copy** once the destination is chosen: scheduled D1 exports plus an R2 copy that keeps metadata, run with a token limited to read.
4. **Run a staged restore** from a production copy into isolated resources. Run the drill tool on it, time each step against the RTO, and record the result and owner.
5. **Decide whether an emergency read-only mode is needed.** Without one, a restore means taking the CMS offline.
