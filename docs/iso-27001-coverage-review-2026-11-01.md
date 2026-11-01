# 0xCMS: ISO 27001 coverage review — 1 November 2026

Source review at revision `456493a` (which contains the P0 commit `edee9a7`), re-assessing the [control matrix](iso-27001-control-matrix-2026-10-30.md) (pinned to `ac27e68`) after the F1, F3 and P0 commits. This is a delta review: it revisits the rows those commits touched and re-tests the gaps the matrix recorded. It does not restate the 93-row matrix, which remains the baseline.

This is local source evidence. Nothing here is deployed-control verification, no production account or data was inspected, and no applicability or SoA exclusion decision is made.

## 1. What a codebase can reach

The matrix's own feasibility categories already answer this, and the arithmetic matters more than any per-control verdict:

| Reach | Controls | Meaning |
|---|---|---|
| Source-assessed | 27 | Application controls were inspected (7 implemented, 9 partial, 9 supporting-only, 2 not evidenced as of 30 October) |
| Code could contribute, unassessed | 32 | 13 repo-led engineering + 19 hybrid repo/external |
| Repository documents only | 17 | A committed document supports the control; code does not implement it |
| Outside the repository entirely | 17 | Physical, HR and supplier controls with no meaningful CMS enforcement |

So **at most ~59 of 93 controls can ever be touched by this codebase, and 34 cannot.** The 14 physical controls (A.7.x) are essentially all provider or facility controls; of the 8 people controls (A.6.x), none are enforceable in application code — session revocation supports offboarding, it does not perform it.

The more important limit: ISO 27001 certification is granted against clauses 4–10 — scope, risk assessment, Statement of Applicability, internal audit, management review — none of which a repository provides. Annex A coverage is necessary and not sufficient. A perfect score on all 34 technological controls still certifies nothing without the management system.

## 2. Status changes since 30 October

Each row below was re-tested against current source. "Closed" means the specific gap the matrix recorded is no longer present in code.

| Control | Matrix gap (30 Oct) | Now | Evidence |
|---|---|---|---|
| A.5.12 Classification | Classification failure returned an empty map, bypassing classified read audits (F2) | **Closed.** A classification outage now refuses the response instead of serving it unlogged. Container floors are monotonic, so a reclassification cannot lower what a record already held | `resolveDataClasses` preserves `ok=false`; [access-log.ts:208](src/core/http/access-log.ts:208) throws; [access-log.ts:327](src/core/http/access-log.ts:327) answers 503. Floors: [schema.sql:360](src/core/schema.sql:360) |
| A.5.14 Transfers | Missing projection rules copied the full lect; projection top-level only (F1) | **Closed**, and transfers now record disclosure intent before bytes leave the host | [publish/regulated.ts:61](src/core/publish/regulated.ts:61); [publish/audit.ts](src/core/publish/audit.ts) |
| A.5.28 Evidence collection | F2/F4 capture gaps; seals in the application DB give no independent anchoring | **Partially closed.** Capture no longer discards identifiers — sets above 100 split into linked manifest parts rather than being truncated. Anchoring gap **remains** | Manifest parts in [access-log.ts](src/core/http/access-log.ts); seals still written to the same D1 as the events at [sweep.ts:161](src/features/audit/sweep.ts:161) |
| A.5.29 Security during disruption | Proposed work: test a safe degraded/read-only mode preserving authorization and logging | **Implemented.** Write containment is a real contained read-only mode with an explicit route allowlist and no bypass flag | [regulated-writes.ts](src/core/http/regulated-writes.ts) |
| A.5.33 Record protection | `AUDIT_BUCKET` commented out in production config, skipping archival (F5) | **Conditionally closed.** A regulated deployment cannot start without the archive binding. A non-regulated deployment can still run with no archive | [regulated-profile.ts:37](src/core/http/regulated-profile.ts:37) |
| A.5.34 PII and privacy | Fail-open publication and public classified-media delivery (F1/F3) | **Closed.** See §4 for a new retention consideration this work introduces | [publish/regulated.ts](src/core/publish/regulated.ts); [media/regulated.ts](src/features/media/regulated.ts) |
| A.8.3 Access restrictions | PHI-classified public media remained publicly deliverable (F3) | **Closed.** Public routes refuse before the existence check and before the cache read | [media/regulated.ts:48](src/features/media/regulated.ts:48) |
| A.8.12 Leakage prevention | Missing-rule publication and classified public-media paths (F1/F3) | **Closed**, plus disclosure-intent audit on hook deliveries, plugin exchanges and withdrawals | [plugins/hook-audit.ts](src/features/plugins/hook-audit.ts); [outbound-audit.ts](src/core/http/outbound-audit.ts) |
| A.8.15 Event logging | Classification failure skipped logs; private-file reads uninstrumented; mutations best-effort; archive unbound | **Substantially improved, still partial.** Classification failure refuses; media reads instrumented; audit-write failure now raises an incident. PII writes remain best-effort (§4) | [media/routes/files.ts:142](src/features/media/routes/files.ts:142), [public.ts:18](src/features/media/routes/public.ts:18); outage hooks in [db/audit.ts](src/core/db/audit.ts) |
| A.8.16 Security monitoring | Supporting feature only; coverage gaps limited monitoring input | **Upgraded to a real control.** Health checks, an incident journal in a separate bucket, idempotent external alert delivery with backoff, and a review workflow recording disposition and evidence hash. The receiver is an unconfigured deployment dependency by default | [audit/outages.ts](src/features/audit/outages.ts); [db/audit-outages.ts](src/core/db/audit-outages.ts) |
| A.5.24 / A.5.25 / A.5.26 Incident preparedness, assessment, response | Supporting/hybrid; no containment tooling | **Improved supporting mechanism:** incident capture, triage dispositions and an audited containment mode. The process, severity criteria and on-call ownership remain organizational | [audit/outages.ts](src/features/audit/outages.ts); [regulated-writes.ts](src/core/http/regulated-writes.ts) |
| A.8.5 Authentication | Session model lacked inactivity expiry; a token TTL is not an inactivity timer | **Inactivity expiry implemented** (1 November, after this review opened). A session with no refresh for `SESSION_IDLE_TTL` is refused and its row removed; 8 hours by default, and a regulated deployment must set the value explicitly. MFA and step-up remain external/unbuilt — see §3 | [sessions.ts](src/core/auth/sessions.ts); [regulated-profile.ts](src/core/http/regulated-profile.ts); [test/session-idle.test.ts](test/session-idle.test.ts) |

Net effect on the matrix's assessed rows: of the 9 "partially implemented — known gap" rows, 4 gaps are fully closed in code (A.5.12, A.5.14, A.5.34, A.8.12), 2 are conditionally or partly closed (A.5.28, A.5.33), 1 is closed outright (A.8.3), 1 is improved but still partial (A.8.15), and A.8.5's inactivity gap was closed by the change recorded above.

### A.8.5 as implemented

Inactivity is measured from the last refresh — `COALESCE(rotated_at, created_at)` — because that is the only moment an authenticated request writes to the session row. Two consequences are worth stating rather than discovering later:

- **The window cannot be shorter than the access-token lifetime.** Requests made inside a 15-minute access token are invisible to the database, so a shorter idle window would end sessions that are actively in use. `parseSessionIdleTtl` refuses anything below `ACCESS_TOKEN_TTL` or above `REFRESH_TOKEN_TTL`, and an unusable value falls back to the 8-hour default rather than widening the window.
- **Enforcement is conservative, not permissive.** Because activity between refreshes is unobserved, a session can be refused up to 15 minutes *before* its nominal deadline, never after it. For an auditor the relevant direction is that the window is never exceeded.

The idle session is both refused at refresh (`findRefreshSession`) and deleted by `purgeExpiredSessions`, so termination removes the row rather than leaving a dead session listed. Existing non-regulated deployments move from a 7-day idle window to 8 hours on upgrade, which is a visible behaviour change for anyone who left a tab open overnight.

## 3. Gaps still inside the code's reach

Ranked by how much a regulated deployment should care.

1. **A.8.5 — no host MFA and no step-up authentication.** The inactivity half of this row is now closed (§2), but MFA is delegated entirely to the identity provider and that delegation is unverified from here; no host-side step-up exists for a privileged action. Whether the CMS should enforce or merely require IdP MFA is a policy decision, not a code defect.
2. **A.8.11 — masking is visual only.** `privacy-table.js` writes the cleartext into `data-private-original-text` / `data-private-original-html` before masking the cell ([privacy-table.js:94](src/core/views/assets/privacy-table.js:94)), so the protected value is in the DOM, in the response body, for anyone with the page. It conceals from a shoulder, not from a recipient. Server-side, role-aware masking with an audited reveal is still unbuilt — and the same gap means A.7.7 should not be read as a mitigation.
3. **A.8.13 — no independent backup.** Page version history lives in the same database as the pages. Nothing in source performs or verifies an external backup or a restore.
4. **A.5.28 — seals are not independently anchored.** The rolling hash chain detects tampering only if the chain's own root is trustworthy, and it is written to the same D1 holding the events ([sweep.ts:131](src/features/audit/sweep.ts:131)). An actor who can write that database can rewrite events and reseal. An external anchor — the monitor receiver already added for outages is a plausible home — would close this.
5. **A.8.7 — uploads are not scanned.** Extension, MIME and magic-byte checks are structural validation, not malware defense. No quarantine-until-clean path exists.
6. **A.8.8 / A.8.32 / A.8.4 — no CI.** `.github/` contains no workflows and there is no CODEOWNERS file, so dependency scanning, SAST, secret scanning, review gates and branch protection are entirely external and unevidenced. Verified at this revision.

Correctly handled, worth recording as positives: secrets are gitignored (`.dev.vars`, `*.p8`), SQL is parameterized throughout the paths reviewed in this and the previous session, and the publication gate fails closed while read logging fails open — a deliberate, documented asymmetry rather than an oversight.

## 4. Considerations the P0 work itself introduces

These are consequences of the new design, not defects, and each needs a documented decision rather than a fix.

**Sensitivity floors survive erasure (A.8.10, A.5.34).** `page_sensitivity_floors` has no foreign key and is never deleted — no `DELETE` against it exists anywhere in source, including the purge path at [trash/routes.ts:196](src/features/trash/routes.ts:196). Purging a page therefore leaves a durable row asserting that UUID held PII or PHI. That is deliberate: it is what stops a delete-and-recreate cycle from laundering a classification, and the retained data is a UUID and a level, not content. But it means the erasure path does not erase everything, which is exactly the question an auditor or a data-subject request will raise. The repository already states that sensitivity is monotonic "until a governed declassification workflow exists"; that workflow is the thing that closes this, and it is not built.

**PII read audits remain best-effort.** `failsClosed` is true only for `phi` ([data-classes.ts:132](src/core/db/data-classes.ts:132)), so a PII read's audit row is written through `waitUntil` and a D1 failure does not withhold the response ([access-log.ts:321](src/core/http/access-log.ts:321)). It now raises an outage incident, so the failure is visible rather than silent. This is a reasonable availability trade, but it should be an accepted risk on the record, not an assumed guarantee — under A.8.15 the log is not complete by construction for PII.

**The archive is mandatory only in regulated mode.** A deployment that holds PII without setting `REGULATED_MODE=true` can still run with no `AUDIT_BUCKET`, which is the F5 condition surviving in the non-regulated profile.

**Readiness is re-checked per request.** `assertRegulatedReady` deliberately holds no cache, and in regulated mode costs several D1 queries on every dynamic request. Correct for policy freshness; it needs a load check before a regulated deployment goes live.

## 5. Unchanged and outside the repository

The 34 controls the codebase cannot reach (17 external, 17 document-only) are unchanged and need organizational evidence: supplier register and agreements (A.5.19–A.5.22), all 14 physical controls, all 8 people controls, incident process ownership, business continuity objectives and tested recovery (A.5.30, A.8.14), and independent review (A.5.35). Nothing in P0 bears on these.

Deployment-dependent and still unverified: actual Cloudflare account IAM, bucket domains and public access, whether the archive and monitor bindings exist in production, TLS and at-rest encryption coverage, IdP MFA enforcement, and environment separation between dev, test and production.

## 6. What this review did not do

No production or deployed revision was inspected. The P0 acceptance record ([p0-manual-acceptance-2026-10-31.md](p0-manual-acceptance-2026-10-31.md)) is unexecuted, so every "closed" verdict above is closed in source at `456493a` and nowhere else. W0, W1, W2, W3 and W4a acceptance packages remain open, and regulated writes are contained pending W4b. The matrix's original 27 assessed rows were re-tested only where the three recent commits touched them; the 32 feasibility rows where code could contribute were not newly assessed.
