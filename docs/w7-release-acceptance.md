# W7 — release and evidence closure

Release record for W7 in [the compliance plan](compliance-implementation-plan-2026-10-30.md): fault injection, staging verification, migration and rollback drills, and matrix updates (A.8.29, A.8.32). Started 3 November 2026. **No release has been tested, staged or deployed. W7 cannot close yet.**

## Why W7 is not closable yet

W7 verifies one exact release revision against W1–W6 and deployment evidence. None of that exists for a single revision today:

| Dependency | State on 3 November |
|---|---|
| W0–W4a | Engineering in source; deployed acceptance unexecuted ([P0 acceptance record](p0-manual-acceptance-2026-10-31.md)) |
| W4b | R2–R6 open, about 23–41 person-days ([scope register](w4b-remaining-scope-2026-11-02.md)). Regulated writes stay contained until it closes |
| W5 | Engineering done; deployment evidence outstanding ([record](w5-archive-protection.md#still-needs-deployment-evidence-w7)) |
| W6 | Engineering done; deployment evidence and the idle-value decision outstanding ([record](w6-session-inactivity.md#still-open-outside-this-change)) |
| Deployed revisions | Unrecorded. No tag or deployment record in the repository says what production runs |

What can be done now is the repository side: a repeatable migration drill, a single checklist for the release, and the matrix update. The rest needs an environment and named owners.

## Migration and rollback drill (in source)

`npm run check:upgrade -- --from <revision>` ([tools/check-upgrade-path.mjs](../tools/check-upgrade-path.mjs)) builds both D1 schemas as a fresh install of `<revision>`, then applies the upgrade path:
1. manual core files added since then, in date order;
2. numbered migrations added since then.

It compares the result with a fresh install of the current tree: tables, columns, foreign keys, indexes, triggers and views. It exits 1 on any difference. It also prints the exact files an operator must apply for that revision, and what the older code would meet after a rollback:
- **Hazards:** dropped tables or columns, and new NOT NULL columns without a default. These break the older code.
- **Review items:** new triggers on tables the older code writes.

It uses local SQLite with foreign keys on, not D1, so it proves the SQL path, not a live database's state. It assumes the `--from` database is a fresh install of that revision; one that skipped an earlier manual file will differ, which is what the staging run below checks.

CI runs it from `f9719a3`, the last revision before any manual migration. Move that floor forward only once no deployment is older.

### Results on 3 November (working tree at `f391688`)

| From | Files to apply | Upgraded schema | Rollback |
|---|---|---|---|
| `f9719a3` (before the audit log) | 7 manual, then `0006`, `0007` | Matches fresh | 0 hazards, 13 triggers to review |
| `ac27e68` (control-matrix baseline) | 5 manual, then `0007` | Matches fresh | 0 hazards, 18 triggers to review |
| `456493a` (1 Nov coverage review) | 3 manual, then `0007` | Matches fresh | 0 hazards, 6 triggers to review |
| `0837bd7` (before the outbox) | 3 manual, then `0007` | Matches fresh | 0 hazards, 6 triggers to review |
| `506ac54` (W5 merge) | `2026-11-02_session_last_activity.sql` | Matches fresh | No findings |
| `0302052` (before W6) | `2026-11-02_session_last_activity.sql` | Matches fresh | No findings |

The published database had no changes from any of these revisions.

A negative check confirmed the drill catches drift: with the W6 manual file removed, it reported `sessions.last_activity_at` missing and exited 1.

**The rollback review items are intended, but they change what a rollback means.** They are the sensitivity-floor and classification-version triggers. The plan requires rollback to keep new default-deny boundaries, so these stay. But older code that writes `pages`, `tags`, `page_tags`, `taxonomies` or `data_classes` will be refused or will raise classification versions it doesn't know about. A rollback past `edee9a7` is therefore not a clean return to old behaviour. The rollback drill below has to exercise those writes.

## Release checklist

Fill one copy per release candidate, in the deployment's restricted evidence system. Keep only references and digests here. Each row is **not run**, **pass**, **fail** or **blocked**, with UTC time, tester and reviewer. A blocked or unrun row cannot close a package.

### Identify the release

Use the identification table in the [P0 acceptance record](p0-manual-acceptance-2026-10-31.md#identify-the-tested-release). Add:

| Field | Record |
|---|---|
| Revision currently deployed (the drill's `--from`) | Pending |
| Drill output for that revision, with the printed apply list | Pending |
| CI run for the release commit (verify, upgrade-path, CodeQL) | Pending |

### Migration and rollback drill (staging)

| # | Step | Result |
|---|---|---|
| M1 | Restore a copy of the deployed private and published databases to staging, using synthetic or approved data | Not run |
| M2 | Before applying anything, compare the copy's schema with a fresh install of the deployed revision, to find skipped manual files | Not run |
| M3 | Apply the drill's printed files in its order, then deploy the release artifact. Confirm sign-in, refresh, logout and an admin read | Not run |
| M4 | Rollback: redeploy the previous artifact without reverting schema. Confirm sign-in and reads. Attempt a page save, tag move and classification change, and record each outcome against the drill's review items | Not run |
| M5 | Roll forward again and confirm no data written during M4 is lost or misclassified | Not run |

### Package acceptance

| Package | What must pass | Where it is defined | Result |
|---|---|---|---|
| W0–W4a | Each package's test sequence and disposition | [P0 acceptance record](p0-manual-acceptance-2026-10-31.md#test-sequence) | Not run |
| W4b | R6 coverage reconciliation, fault, concurrency and recovery acceptance | [scope register](w4b-remaining-scope-2026-11-02.md) | Blocked: R2–R6 open |
| W5 | Production `AUDIT_BUCKET` binding and private access; bucket lock refuses overwrite and delete of a sealed segment; `/checkpoints` receiver stores write-once and answers 409 on conflict; a test `archive` incident reaches its owner and is acknowledged; backlog drains at peak load; `0007_enable_audit.sql` applied before deploy | [W5 record](w5-archive-protection.md#still-needs-deployment-evidence-w7) | Not run |
| W6 | `SESSION_IDLE_TTL` set to the approved value; manual session migration applied before deploy; an untouched admin tab signs out at the deadline; a tab in use stays signed in; an open editor socket closes within 60 seconds of the deadline | [W6 record](w6-session-inactivity.md) | Not run; idle value not yet approved |

### Fault injection

Local suites cover these, and each passed in the full suite on the merged revisions:

| Area | Local suite |
|---|---|
| Archive crash, duplicate sweep and storage outage | `test/audit-archive-protection.test.ts` |
| Idle expiry and background refresh | `test/session-idle.test.ts` |
| Socket closure on revocation and idle | `test/security-hardening.test.ts` |
| Audit-write failure for mutations | the W4b evidence suites |

Staging must repeat these against real bindings:

| # | Fault | Expected | Result |
|---|---|---|---|
| F1 | Audit write rejected during a regulated mutation | Mutation does not commit; incident raised | Not run |
| F2 | Archive bucket unavailable for one sweep | No seal or prune; one `archive` incident; clears on recovery | Not run |
| F3 | Checkpoint receiver down, then up | Checkpoints pending, then anchored in order | Not run |
| F4 | Classification lookup unavailable on a classified read | Response refused (503), not served unlogged | Not run |

### Close

| Field | Record |
|---|---|
| Open defects and their disposition | Pending |
| Matrix rows updated, with exact scope demonstrated | Pending; source-only status is in the [3 November coverage update](iso-27001-coverage-review-2026-11-03.md) |
| Release approver and date | Pending |

## Known issue carried into W7

The full test suite intermittently logs a Worker request cancellation ("the Workers runtime canceled this request because it detected that your Worker's code had hung"), even when every test passes. W4b's R6 tracks it. A release run that shows it should record it, not count it as clean.
