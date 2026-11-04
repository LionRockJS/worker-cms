# W13 — incident readiness, evidence and review

Record for W13 in [the compliance plan](compliance-implementation-plan-2026-10-30.md):
- a response plan with decision and escalation paths, contacts, evidence preservation and post-incident actions;
- existing audit review and signals joined to alert delivery, review ownership and retained acknowledgements;
- realistic review cadence and response objectives;
- a tabletop and a technical alert-to-investigation exercise.

Started 4 November 2026 at `50aa0b4`. **The repository side and the technical exercise are done. The plan below is a draft: no owner, contact list or objective is approved and no tabletop has been run, so A.5.24–A.5.26 stay open.**

Controls: A.5.24, A.5.25, A.5.26, A.5.28, A.8.16, plus A.6.8 (event reporting) for the parts the CMS can carry.

## What already existed

| Piece | Where | What it does |
|---|---|---|
| Audit trail | `audit_events`, sealed R2 archive, checkpoint receiver (W4, W5) | Attributable record of mutations, sensitive reads, denials and auth. Hash-chained and anchored outside the CMS |
| Outage incidents | [audit-outage-monitoring.md](audit-outage-monitoring.md) | A failed audit write, classification read or health check becomes a journal incident. It's alerted to the receiver (`/incidents`), retried with backoff, and closed only by a recorded disposition with an evidence reference and digest |
| Heartbeat | Same | Health every cron tick. The receiver alarms on failed checks and on missed heartbeats |
| Security signals | [signals.ts](../src/features/audit/signals.ts), `/admin/audit/review` | Bulk classified reads, repeated refusals, and contributors reading regulated data alone |

**Finding:** the signals were detection only. Nothing delivered them, and nothing recorded that anyone had looked, apart from the screen being opened. So the trail could be written and never examined, with no evidence either way.

## What changed

- **Signal alerts** ([signal-review.ts](../src/features/audit/signal-review.ts)):
  - An hourly check runs inside the existing health monitor.
  - Each flagged signal goes to the receiver's new `/signals` path, at most once per signal per UTC day.
  - The payload carries counts only: signal, flagged rows, window and threshold. The names, addresses and containers that tripped it stay behind `audit:read`.
  - A refused delivery is retried on the next hourly check.
  - It's inert unless outage monitoring is enabled.
- **Review receipts:**
  - `/admin/audit/review` has a **Signal review** panel. A reviewer with `audit:read` records an outcome: reviewed with no action, false positive, or incident opened. An opened incident requires a case reference.
  - The receipt is an `audit.signals-reviewed` audit event with the reviewer, time, outcome, reference and the flagged counts at that moment. It goes through the strict writer, so a failed write refuses.
  - References must match `[A-Za-z0-9._:/#-]`. That stops names, email addresses or descriptions from landing in the trail.
- **Overdue reviews:**
  - When the last receipt is older than `AUDIT_REVIEW_INTERVAL_DAYS` (default 7), the panel shows the review as overdue.
  - The heartbeat carries `signalReviewOverdue`, so the receiver can escalate a review nobody did.
  - An overdue review is not an outage: it doesn't open a health incident.

The receiver contract in [audit-outage-monitoring.md](audit-outage-monitoring.md) now lists `/signals` and the new heartbeat field. The receiver Worker is deployment work, and it needs both added.

## Draft response plan

To be approved, with names filled in, by the incident owner.

### Roles

| Role | Holds | Decides |
|---|---|---|
| Incident owner | `menu:manage`, `audit:read` | Severity, containment, notification, closure |
| Review owner | `audit:read` | Signal reviews at the agreed cadence. Escalates to the incident owner |
| Platform operator | Cloudflare account access (W9) | Secret rotation, route removal, restores (W11) |
| Privacy lead | — | Whether personal data or PHI was involved, and notification duties (W12) |
| Supplier contacts | W10 register | Cloudflare, sign-in providers, plugin operators |

### Severity (proposed)

| Level | Examples | Proposed response |
|---|---|---|
| 1 Critical | Confirmed disclosure of PHI or personal data; account takeover of an administrator; archive chain mismatch at the receiver | Start within 1 hour, contain the same day, privacy lead involved at once |
| 2 High | Unconfirmed but plausible access to classified data; repeated refusals from one source; audit outage without a recorded disposition | Start within 4 working hours |
| 3 Moderate | Signal flagged with a likely benign cause; failed alert delivery | Next working day, decided at the signal review |
| 4 Low | False positive | Recorded at the review, no further action |

### Containment the CMS already has

| Action | How | Evidence |
|---|---|---|
| Remove a user's access | Remove the user, or change their role. Sessions are revoked, and a role change applies to live tokens (W9) | `user.delete` / `user.roles` audit events |
| Sign everyone out | Rotate `JWT_SECRET` (W9 procedure) | Deployment record |
| Stop a plugin | Disable it in Plugins, and rotate its secret if it may be compromised | `plugin.toggle` / `plugin.rotate_secret` audit events |
| Stop all writes | Remove the route or deploy a holding Worker. There's no in-app read-only mode (W11 finding) | Deployment record |
| Keep records from deletion | Place a hold (W12) | `hold.place` audit event |

### Evidence preservation

1. **Freeze what matters.** Place holds on the affected pages (W12). Don't purge, restore or re-import while investigating.
2. **Export the audit trail for the period.** Filter `/admin/audit`, or copy the archive segments for the range from `AUDIT_BUCKET` (W11 drill). Each segment hashes to its seal and the seals chain. `tools/check-export.mjs --audit <dir>` verifies a copied set.
3. **Record a digest of every artifact you keep** (SHA-256), and its reference in the case record. The outage disposition already requires this. Do the same for signal investigations.
4. **Keep the case record outside the CMS,** in the restricted evidence system. Only the case reference goes into the audit trail.
5. **Chain of custody:** who copied what, when, from where, and its digest. The archive's own hash chain and the receiver's checkpoints show the trail wasn't altered after sealing.

### After the incident

- Close the case with a root cause, the corrective actions with owners and dates, and the review outcome.
- Record a signal review referencing the case.
- Re-run the relevant test or drill: W11 restore, W12 lifecycle, or this exercise.
- Review the signal thresholds if the incident went unflagged or was noisy.

## Technical exercise, 4 November 2026

[test/incident-exercise.test.ts](../test/incident-exercise.test.ts) runs the alert-to-investigation path on synthetic data. There are 5 tests:

1. **Six refused requests** from one address trip `refused_access`.
2. **The alert reaches a fake receiver at `/signals`** with exactly `{version, kind, source, signal, day, flagged, windowHours, threshold}`. The address isn't in it. A second check the same day sends nothing, and the next day sends again.
3. **A receiver refusal (503)** is retried on the next check. With nothing flagged, nothing is sent. With monitoring off, it's inert.
4. **Before any review, the heartbeat reports overdue.**
   - The form refuses an opened incident without a reference, and a reference shaped like an email address.
   - A valid record writes the receipt, with reviewer, outcome `incident-opened`, reference `INC-2026-0042` and the flagged counts. The receipt can be retrieved.
   - The next heartbeat reports `signalReviewOverdue: false`.
   - It turns overdue again after the interval, and a 30-day interval moves that point.
5. **An editor without `audit:read`** is refused with 403, and no receipt is written.

**Review panel:** checked with the admin's own Liquid build in two states, never reviewed and reviewed. All 5 checks passed.

This exercises the CMS half only. A deployed receiver, a real alert reaching a person, and the human decision still need the staged exercise below.

## What W13 still needs from people

1. **The incident owner approves the plan above.** That means names and contacts per role, the severity scale, the response objectives and the review cadence (`AUDIT_REVIEW_INTERVAL_DAYS`).
2. **Extend the receiver** with `/signals` and `signalReviewOverdue` escalation, then route both to the review owner.
3. **Run a tabletop.** Suggested scenario: an editor account shows bulk classified reads at night, from a new address. Walk through severity, containment (role change, then `JWT_SECRET` rotation), evidence (audit export, archive segments, digests), privacy assessment and notification. Record decisions and corrective actions.
4. **Run the technical exercise on staging** against the real receiver, with a person acknowledging the alert and recording the review.
5. **Keep the review cadence.** The receipts are the evidence. A screenshot of the review screen isn't.
