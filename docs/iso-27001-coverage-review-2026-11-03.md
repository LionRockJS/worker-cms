# 0xCMS: ISO 27001 coverage update — 3 November 2026

Source review at `f391688` plus the W7 branch, as a delta to the [1 November review](iso-27001-coverage-review-2026-11-01.md) (at `456493a`). The [93-row matrix](iso-27001-control-matrix-2026-10-30.md) remains the baseline. Same limits as before: local source evidence only, no deployed revision inspected, no applicability or SoA decision made.

## Reach is unchanged

| Reach | Controls |
|---|---|
| Source-assessed | 27 |
| Code could contribute, unassessed | 32 |
| Repository documents only | 17 |
| Outside the repository | 17 |

At most about 59 of 93 can be touched by this codebase. Certification is against the management-system clauses 4–10, which no repository provides.

## Status changes since 1 November

| Control | 1 November | Now (source only) | Evidence |
|---|---|---|---|
| **A.8.11** Data masking | Visual only; cleartext in the DOM | **Partly closed.** Without `pii:reveal`, names and emails are masked server-side on the users list and dashboard page list, so the value never leaves the Worker. Serving cleartext is recorded as `user.pii-reveal` / `page.pii-reveal`. Other surfaces (plugin views, exports, editor, API JSON) are not covered | `537870c`; [privacy.ts](../src/core/render/privacy.ts); [users.ts:97](../src/features/users-roles/routes/users.ts:97); [dashboard.ts:382](../src/routes/admin/pages/dashboard.ts:382) |
| **A.8.4 / A.8.8 / A.8.32** Source access, vulnerabilities, change management | No CI, no CODEOWNERS | **Repository part largely closed.** CI runs type-check and the full suite on every PR, plus CodeQL, Dependabot and CODEOWNERS. W7 adds an upgrade-path job. `npm audit` does not block (`continue-on-error`). No secret-scanning workflow. Branch protection is a GitHub setting, unevidenced here | `f4f5a63`; [ci.yml](../.github/workflows/ci.yml) |
| **A.5.28** Evidence collection | Seals in the same D1 as the events; no independent anchor | **Closed in source, pending deployment.** Seal hashes are sent to an external `/checkpoints` receiver, and each archived object carries its own chain link. Independence depends on a receiver the CMS cannot write, and on a bucket lock; neither exists until deployed | `dbd5188`; [W5 record](w5-archive-protection.md) |
| **A.5.33** Record protection | Archive mandatory only in regulated mode; sweep not retry-safe | **Improved.** Lease-serialized sweeps, frozen segment ranges, no overwrite or delete, prune only after read-back verification, orphan reporting. Non-regulated deployments can still run without an archive. Retention for PHI mutations still uses `content_mutation` (W4b) | [W5 record](w5-archive-protection.md) |
| **A.8.15** Event logging | Mutations best-effort; PII reads best-effort | **Substantially improved.** W4b now commits the change and its audit row in one transaction for access management, sessions, authentication denials, editor, taxonomy, trash, tag links, quick-create, host settings, runtime types and locales. Plugin API, background writers and external effects remain (R2–R6). PII read audits remain best-effort by design | [W4b register](w4b-remaining-scope-2026-11-02.md) |
| **A.8.16** Monitoring | Health checks, incident journal, alert delivery | **Extended.** Archive lag, missing bucket, verification failure and anchor conflicts raise `archive` incidents through the same path. Delivery to an owner is unevidenced | [W5 record](w5-archive-protection.md) |
| **A.8.5** Authentication | Idle window existed, but an open tab kept a session alive | **Inactivity closed in source.** Idle time is measured from the person's last action; background keepalives and presence polls do not count; access tokens and sockets stop at the deadline. MFA and step-up remain external or unbuilt | `3177779`; [W6 record](w6-session-inactivity.md) |
| **A.8.32** Change management (migrations) | Manual migrations with no ordering or completeness check | **Repository part added.** The upgrade drill proves that every tested earlier revision upgrades to the current schema, prints the files to apply, and flags rollback hazards. A staging rehearsal is still required | [W7 record](w7-release-acceptance.md) |

## Gaps still inside the code's reach

1. **A.8.13 — no independent backup.** No source performs or verifies an external backup or restore. D1 time-travel, if used, is a deployment setting.
2. **A.8.7 — uploads are not scanned.** Structural validation only; no quarantine-until-clean.
3. **A.8.5 — no host MFA or step-up.** Delegated to the IdP and unverified from here.
4. **A.8.11 — masking covers two screens.** Extend it to plugin views, exports and API responses, or record why those surfaces hold no personal data.
5. **A.8.15 — W4b R2–R6.** Plugin API writers, background jobs, external effects and recovery are not yet durable.
6. **A.5.33 — PHI mutation retention class.** `mutationRow` always emits `content_mutation`, so `phi_mutation` is never used. No harm today, since both keep rows hot for 365 days.
7. **A.8.8 — the dependency audit does not block.** Triage the backlog, then remove `continue-on-error`.

The 1 November considerations still stand: sensitivity floors outlive erasure until governed declassification exists, and in regulated mode readiness is re-checked on every request, which needs a load check.

## Not done in this update

- No deployed revision, account, bucket or receiver was inspected.
- The 32 contributable-but-unassessed rows were not newly assessed.
- Every "closed" verdict above is closed in source only. The [W7 release checklist](w7-release-acceptance.md#release-checklist) is where it becomes operating evidence.
