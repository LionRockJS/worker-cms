# Durable session lifecycle evidence

Local W4b continuation, 2 November 2026. This covers the supported session APIs and their HTTP/middleware/maintenance callers; it is not deployment acceptance or closure of W4b as a whole.

| Operation | Committed evidence | Failure behavior |
|---|---|---|
| OAuth/internal session creation | Session row and `auth.login` share one D1 batch. Generated session ID is resolved inside that transaction for the actor/session target. | Failed/ignored/rewritten audit writes abort creation. Tokens are returned only after commit. A lost commit acknowledgment is unavailable, with no automatic creation replay. |
| Refresh rotation | Token-hash rotation and `auth.session.rotate` share one guarded batch. | Current account/profile/roles, refresh subject/owner, token expiry, session/absolute expiry and idle eligibility are rechecked at execution. Failed evidence cannot leave an unaudited rotation or issue cookies. |
| Previous-token grace | `auth.session.grace` commits before access-only tokens are returned. | Current user and grace eligibility are checked in the evidence batch. No refresh rotation/cookie or activity renewal occurs; audit failure denies access-only issuance. |
| Logout/direct refresh-token revocation | Every removed session has a complete outbox receipt, committed with the deletion. Logout uses `auth.logout`; direct revocation uses `auth.session.revoke`. | Primary audit outage does not prevent an eligible revocation. Database/outbox failure refuses the server mutation; logout still clears local cookies and reports 503 rather than claiming success. |
| Session concurrency cap | Each removed session has `auth.session.cap` evidence in the outbox. | At most 50 selected removals and all receipts commit together. Current ownership/activity and cap eligibility are checked; a concurrent change can refuse the batch for a later sweep. |
| Expired/idle/absolute-lifetime cleanup | Each removed session has `auth.session.expire` evidence in the outbox. | Bounded, guarded selection prevents deleting a session refreshed after the snapshot. Authorization still rejects expired sessions while cleanup is pending. |
| Administrative user deletion | Existing atomic `user.delete` evidence includes the complete `revoked_session_ids` set when nonempty. | The session set is checked in the deletion transaction; a concurrent new session refuses stale deletion evidence. Empty omitted sets are also checked to contain zero sessions. |

## Attribution and confidentiality

Session evidence uses the shared core audit envelope, with authentication event/retention classes and the highest effective classification of users, sessions, roles, grants and OAuth identities. Creation, rotation and grace access fail closed on unavailable/invalid classification or unsafe role metadata. Revocation/cleanup conservatively records PHI classification if policy is unavailable; regulated revocation always retains PHI-classified evidence during the repair path; unsafe source roles are omitted with an explicit marker.

The envelope carries internal user/session IDs, safe roles where appropriate, request metadata and bounded lifecycle/source metadata. It excludes names, emails, provider subjects, JWTs, refresh token IDs and both current/previous token hashes. Hashes used to resolve a generated session ID or compare transaction state are bound SQL parameters, not recorded evidence values.

Cleanup is attributed to `system:session-maintenance`, with no human actor, role or actor-session assertion. Its detail identifies the affected user's internal ID. Named service ownership remains a deployment/organizational requirement. Logout and direct revocation use the validated credential's actual session owner and current stored role, not stale JWT roles. Refresh-only logout is recorded; repeated/anonymous logout that resolves no session does not invent another successful removal event.

## Concurrency and commit uncertainty

Rotation keeps the existing immediate previous-token grace period. If another request wins after the read, the loser can return access-only grace after a separate durable grace record and current authorization checks. A lost acknowledgment of this operation's own committed rotation is unavailable: it does not automatically return tokens or replay rotation. The next verified request can use normal grace rules; if it cannot recover a usable refresh credential, sign-in is required.

Logout targets the stable session ID and owner after credential verification. A concurrent hash rotation cannot defeat it. Cleanup instead compares the full selected session/activity snapshot and current eligibility, so it cannot purge a now-active session. Account/profile/role guards prevent stale issuance. Creation from the OAuth callback also rechecks the verified identity ownership (or valid, unconflicted legacy primary key) before and after insertion.

Creation evidence means the session row committed; it does not prove that a browser received tokens. OAuth account/profile mutations and session creation remain separate transactions. A late failure can leave the earlier account/profile change committed. Reconcile actual rows and corresponding events; do not claim cross-transaction rollback.

The exact `POST /auth/logout` path remains available during regulated inventory or primary-audit schema/write outages. Secret, canonical-origin, cross-origin mutation and signed-credential checks still apply. It releases no tenant data or new credentials; other auth/business routes and logout suffixes retain admission checks.

Logout can resolve two different sessions from its access/refresh cookies. Their selected set and receipts share one deletion batch; duplicate references to the same session are deduplicated. If the deletion committed but acknowledgment was lost, local cookies clear, the response is unavailable and the pending evidence supports reconciliation. Delivery never executes the business operation again.

## Maintenance and recovery

The existing core outbox schema/upgrade is reused; this continuation adds no new DDL. Existing installations still need the [outbox migration](../migrations/manual/2026-11-02_audit_mutation_outbox.sql) before deploying the code. See the [outbox runbook](audit-mutation-outbox.md) for restricted inspection, retention of exhausted receipts and reviewed retry.

Login/refresh run bounded hygiene through `waitUntil`, swallowing already-reported lifecycle failures so cleanup does not produce an unhandled response-lifetime rejection. The core scheduled handler performs hygiene before regulated readiness: one over-limit account and at most 50 expired sessions per tick. A large cap backlog is revisited on later ticks or that account's subsequent login/refresh. Transient/pre-existing excess is not claimed fully drained by one bounded sweep.

Cleanup commits up to 50 deletions and receipts in one D1 batch and leaves their delivery to the core sweeper. The scheduled handler delivers at most 10 due receipts per tick, preserving headroom for other work; explicit logout/revocation attempts only its own receipts. The delivery helper retains its maximum of 50 for isolated/reviewed sweeps. D1 counts a `batch()` call as one query against the invocation query allowance, while per-statement limits still apply. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Production schedules, alert receipt/escalation, backlog capacity, account-specific query/runtime budgets, archive/retention and restored-database drills remain deployment evidence. No scheduler, monitoring receiver or production migration was configured here. Retention and capacity must account for the additional rotation/grace records; required lifecycle evidence must not be silently sampled away.

## Scope limits

- Supported creation, rotation, grace and removal APIs now require the environment/evidence contract; the former unaudited `storeRefreshSession` application helper was removed. Privileged test fixtures seed sessions explicitly. Pure JWT signing helpers do not authorize an unbacked session: access still requires a current database session/account.
- Authentication denials and other supplementary `logAuthEvent` callers retain their existing best-effort recording. Their durable failure-handling contract remains separate work; this continuation does not claim every authentication attempt has durable evidence.
- Direct/migration SQL and out-of-band user/session deletion require their own controlled evidence. The normal user-deletion route records its complete session set.
- Classification and broader authorization-policy versions are still resolved before transactions. General operation IDs, cross-service/plugin/R2 outboxes and remaining regulated content mutations remain W4b work.
- The existing refresh-observed inactivity semantics and approved timeout values are retained. This does not resolve W6's separate meaningful-activity/background-refresh policy questions.

Local validation: 59 new regressions cover primary/outbox failures, expiry/ownership/concurrency guards, cookie handling, uncertain commits, bounded maintenance, user-deletion receipts and regulated audit-schema recovery. The final serial suite passed 1,553 tests across 72 files; build, TypeScript, feature profiles, boundaries, generated consistency and whitespace checks pass. See the [W4b progress entry](compliance-p0-progress-2026-10-30.md).
