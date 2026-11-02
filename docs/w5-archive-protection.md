# W5 — archive protection and actionable monitoring

Engineering record for W5 in [the compliance plan](compliance-implementation-plan-2026-10-30.md#w5--finish-archival-protection-and-operational-delivery), closing in source the anchoring gap in [the ISO review §3 item 4](iso-27001-coverage-review-2026-11-01.md#3-gaps-still-inside-the-codes-reach). **Nothing here was deployed or applied to a live database.** Each "verified" item below is verified in source and in the test runtime (Miniflare D1/R2) only.

## What the sweep now does

`sweepAuditEvents` ([sweep.ts](../src/features/audit/sweep.ts)) runs one bounded pass per cron tick:

1. **Lease.** It claims the single-row lease in `audit_archive_state` with a conditional `UPDATE … RETURNING`. If another run holds an unexpired lease, it returns `skipped: 'claimed'`. The lease lasts 10 minutes and is released on exit.
2. **Freeze, write, seal.** The intended segment is stored in `audit_archive_intents` before any object is written. The row holds the range, hashes, key and segment format, and is keyed by the chain position it extends. A retry recomputes the frozen rows from D1 and refuses (`segment-drift`) if they no longer hash to the intent. If an object already exists at the key and matches, the run adopts it. If it differs, the run refuses (`segment-conflict`) and does not overwrite it. The seal is inserted from the intent with a compare-and-swap on the chain head (`MAX(last_seq)` and its `rolling_hash`), and the intent is deleted in the same transaction. Even a runner whose lease lapsed cannot seal a second branch.
3. **Verify before prune.** `verified_seq` advances only over seals whose objects are fetched back from R2, hash to `segment_hash`, chain from the previous verified seal and do not overlap it. Pruning is bounded by `verified_seq`, not by the highest seal. A missing, corrupt or off-chain segment halts pruning at that point until a person resolves it.
4. **Anchor.** Verified seals are POSTed in chain order to the existing `AUDIT_MONITOR` receiver at `/checkpoints`. The payload holds seq numbers, counts and hashes only (contract in [audit-outage-monitoring.md](audit-outage-monitoring.md#receiver-contract)). `anchored_seq` advances on 2xx. A 409 is an `anchor-conflict` fault. Any other response leaves the checkpoint pending for retry. Each object also carries `format`, `prevHash` and `rollingHash` in its own metadata. Verification treats a D1 seal that disagrees with its object's link as a broken chain.
5. **Reconcile orphans.** It lists the archive in pages of 30 and records every object with no seal or intent in `audit_archive_orphans`. An object inside sealed coverage whose lines match the sealed copy is `superseded`; this is what a crash under the pre-W5 sweep left when the retried segment came out longer. Every other orphan (`divergent`, `unsealed`, `uncompared`) is an `orphan` fault. Nothing is ever deleted from the archive.
6. **Alert.** A fault becomes one `reason: 'archive'` incident through the existing `recordAuditOutage` path. It is deduplicated by a fingerprint in `audit_archive_state.fault` and cleared by the next clean run. The receiver sees only `reason: archive`; the fault kind and segment key stay in the private journal. The existing review screen lists it and its reconciliation workflow applies unchanged. The health check marks `archiveHealthy` false for:
   - an open fault;
   - a lagging stage: unarchived events, a frozen segment that never sealed, unverified seals, or unanchored checkpoints when a receiver is bound;
   - a failed newest-segment check.

   The heartbeat now carries `archiveSealedSeq`, `archiveHeadHash` and the fault kind. The review screen shows the prune ceiling, anchored seq, any pending freeze and the current fault.

D1 failures still throw: there is no state to recover into, and the health check already reports `primaryWritable: false`. R2 failures are caught as `bucket-unavailable`, and the remaining R2 steps of that run are skipped.

## Verified in source (tests)

[test/audit-archive-protection.test.ts](../test/audit-archive-protection.test.ts) covers the cases below. Every case also asserts that no unverified range was pruned.

| Scenario | Outcome |
|---|---|
| Seal transaction fails after the object is written | Intent and object kept, nothing pruned, lease released. Next run adopts the object (zero puts), seals, verifies and prunes |
| Put succeeds but its response is lost | `bucket-unavailable`, no seal. Next run seals and verifies |
| Different object at the frozen key | `segment-conflict`, object left as is, one PHI-free `archive` alert |
| Frozen rows altered in D1 | `segment-drift`, no seal |
| Lease held, then expired | `claimed`, then proceeds |
| Three overlapping ticks | One seal for the range |
| Lease lapses mid-write and a second runner completes the intent | The late runner seals nothing. One chain, which later verifies |
| Seal inserted outside the protocol (legacy writer or forger) | Overtaken intent dropped and its object recorded as an orphan. `verification-failed`, nothing pruned |
| R2 fully unavailable | Nothing sealed or pruned, one incident across repeated ticks, fault cleared on recovery |
| D1 unavailable | Throws, bucket untouched |
| No bucket binding | One `bucket-missing` incident, nothing pruned |
| Segment unreadable, or corrupted after sealing | `verification-failed`, prune ceiling unchanged |
| D1 reseal that is self-consistent | Caught by the object's own chain link |
| Receiver down, then up | Checkpoints pending, then anchored in order |
| Receiver answers 409 | `anchor-conflict` incident |
| Superseded, divergent and unsealed orphans | Classified correctly, one alert, never deleted |
| Archive fault or stale frozen segment | `archiveHealthy: false`. Heartbeat carries head seq/hash and fault kind, no segment key |

`npm run type-check` and `npm test` pass at this commit. A mutation check confirmed that the tests fail when either of these is broken:

- prune uses `MAX(last_seq)` instead of the verified ceiling;
- the run overwrites a conflicting object.

## Still needs deployment evidence (W7)

None of the following can be established from this repository:

- **`AUDIT_BUCKET` binding.** The checked `wrangler.toml` still has it commented out. Confirm the production binding, its bucket, private access only (no public domain or `r2.dev`), and who can write and delete.
- **Bucket lock and retention.** Configure and *test* a bucket lock rule on `audit/` with the approved retention period, from an approved retention schedule rather than a blanket six years. Then confirm that an overwrite and a delete of a sealed segment are refused. The code never overwrites or deletes, but only the lock makes object metadata and bytes immutable to an actor holding the Worker's credentials. Without the lock, the object-link check raises the cost of tampering but does not prevent it.
- **Checkpoint receiver.** The CMS does not provision the receiver. It must implement `/checkpoints` as specified:
  - write-once storage the CMS's credentials cannot reach;
  - 409 on conflict or a chain break;
  - alarms on 409, on a heartbeat head that disagrees with a stored checkpoint, and on missed heartbeats.

  Until it exists, `anchorConfigured` is false and the review screen says so. **Seals in D1 are then not independent tamper protection**, and must not be described as such.
- **Alert delivery to an owner.** A test `archive` incident must reach the responsible person, be acknowledged, and leave retained review evidence through the existing reconcile flow.
- **Throughput.** Measure backlog drain at representative peak load: 1,000 events per segment, one segment per five-minute tick.
- **Migration.** Apply [0007_enable_audit.sql](../migrations/0007_enable_audit.sql) on every existing private database **before** deploying this code. It is idempotent: `CREATE … IF NOT EXISTS` plus `INSERT OR IGNORE` of the state row. The sweep and health check fail without these tables.

## Rollout notes

- **Existing installs start at `verified_seq = 0`.** Pruning pauses until historic seals have been read back, 10 per tick. A historic segment that is genuinely missing halts pruning permanently, as designed. That needs a recorded human decision (an `unrecoverable-gap` review) before anyone moves `verified_seq` by hand.
- **Legacy orphans are reported on the first scan.** Objects left by pre-W5 crashes become `superseded` when their lines match. Any other kind raises one alert each.
- **A previous Worker version running during rollout** can still seal without an intent. The current code treats that as an overtaken intent, and verification decides whether the foreign seal is acceptable.
- **The overwrite check is get-then-put, not atomic.** Two runners can write the same bytes to the same key; only one can seal. Under a bucket lock the second write is refused, and the next tick adopts the object.

## Coordination with W4b

- **Segment format.** `SEGMENT_FORMATS[1]` freezes today's column list as the archive's event contract. To archive new `audit_events` columns, add format 2 and leave format 1 alone. Frozen intents record their format, and verification hashes stored bytes, so it is format-independent.
- **Retention class (not fixed here).** `HOT_DAYS` defines `phi_mutation`, but `mutationRow` in `src/core/db/audit.ts` (owned by W4b) always emits `content_mutation` with `dataClass: 'none'`. Nothing in `src/` emits `phi_mutation`. Both classes are currently 365 days hot, so no row is pruned early today. The archive horizon and any later divergence still depend on W4b choosing the class from the classified target, and that choice belongs in `audit.ts`.
