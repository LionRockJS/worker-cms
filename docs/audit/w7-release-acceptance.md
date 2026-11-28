# W7 — release and evidence closure

Release record for W7 in [the compliance plan](compliance-implementation-plan-2026-10-30.md): fault injection, staging verification, migration and rollback drills, and matrix updates (A.8.29, A.8.32). Started 3 November 2026. **No release has been tested, staged or deployed. W7 cannot close yet.**

## Candidate and dependencies · 28 November 2026

The proposed staging input is the first-milestone working tree based on `development@f36423369264`. A releasable candidate requires the resulting reviewed commit and artifact digest. The deployed revision, staging environment and accountable tester/reviewer are pending. Record them in the restricted release record before staging.

W0–W4a still await the P0 exercise. W4b R3–R6 remain open in the [writer register](w4b-remaining-scope-2026-11-02.md). W5 archive independence and W6 regulated inactivity require deployment evidence.

## Migration and rollback drill

Run `npm run check:upgrade -- --from <deployed-revision>`. The current drill reconstructs both schemas, applies subsequent numbered migrations in order, compares against fresh installs and reports rollback hazards. CI uses `acc57d7` as its comparison revision. Identify and reconcile any older hand-applied schema on a staging copy before treating it as a supported starting point.

On 28 November the local drill from `acc57d7` identified private migrations 0010 and 0011, no published migrations, matching fresh schemas and zero reported rollback hazards. Re-run from the actual deployed revision. Use the target schema check before promotion and exercise real application writes after rollback.

### Local first-milestone checks on 28 November

Type-check, feature profiles, import boundaries, generated files, inventory and requirement checks passed. All 11 Node checks for keepalive and schema validation passed. A local SQLite exercise of the ingestion code verified successful ingestion, PHI retention, retry without duplication and rollback after ignored version, read-evidence or mutation-evidence inserts. Across the broader Node suite, 36 of 37 passed. The self-hosted plugin-view test and the focused Worker suites could not start their loopback listeners in this environment. Worker CI and staging acceptance remain pending.

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
| W4b | R6 coverage reconciliation, fault, concurrency and recovery acceptance | [scope register](w4b-remaining-scope-2026-11-02.md) | Blocked: R3–R6 open |
| W5 | Production `AUDIT_BUCKET` binding and private access; bucket lock refuses overwrite and delete of a sealed segment; `/checkpoints` receiver stores write-once and answers 409 on conflict; a test `archive` incident reaches its owner and is acknowledged; backlog drains at peak load; `0007_enable_audit.sql` applied before deploy | [W5 record](w5-archive-protection.md#still-needs-deployment-evidence-w7) | Not run |
| W6 | `SESSION_IDLE_TTL` set to the approved value; target schema includes sessions.last_activity_at; an untouched visible regulated admin tab loses access at the deadline, including with an older cached keepalive; verify sign-in redirect on the next refresh; a tab in use stays signed in; an open editor socket closes within 60 seconds of the deadline | [W6 record](w6-session-inactivity.md) | Not run; idle value not yet approved |

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
