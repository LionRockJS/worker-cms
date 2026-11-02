# Durable revocation evidence

W4b records identity disconnection, session logout/direct revocation and bounded session cap/expiry cleanup in the core `audit_mutation_outbox` table. Removal, any replacement of the legacy primary OAuth key, and the complete evidence envelope share one D1 transaction. This keeps an eligible disconnection available during a primary `audit_events` outage. Database/outbox failure still refuses the mutation; a failed transport can obscure a committed result, so reconcile state before retrying.

This removes the identity's access to the existing account. Existing CMS sessions retain their current lifecycle; this operation does not revoke every session or prohibit registration of a different account. Authentication/session lifecycle evidence remains separate W4b work.

## Installation

- Fresh installations receive the table/index through the generated baseline, owned by `src/core/schema.sql`.
- Existing installations must apply [the additive core upgrade](../migrations/manual/2026-11-02_audit_mutation_outbox.sql) to the reviewed private CMS database target before deploying this continuation. Regenerating the baseline does not upgrade an already initialized database. No production migration was run as part of implementation.
- Regulated readiness checks the outbox columns. Retain the existing regulated-write and PHI-publication containment; this migration does not authorize either release.
- Include pending evidence in private database access, backup and recovery controls. It contains internal identity/user/session IDs and request metadata, with the same sensitivity as the primary audit stream. It is not independent tamper protection against a privileged database writer.

## Delivery and visibility

Identity disconnection and explicit session revocation attempt delivery after a successful commit. Cap/expiry cleanup leaves its receipts for scheduled delivery. Subsequent scheduled ticks run bounded session hygiene and drain at most 10 due core outbox events before regulated readiness, independently of the optional audit UI. An isolated delivery-helper sweep selects at most 50 due events; failed delivery backs off from 60 seconds up to one hour, with a maximum of eight automatic attempts. The scheduled handler still needs an actual deployed schedule; neither a timer nor a notification receiver was provisioned here.

Every attempt uses the original event ID, occurrence time, actor and request metadata. The delivery batch inserts the primary event idempotently, verifies all recorded columns, removes the matching pending envelope, and verifies the receipt again. Conflicting event IDs, malformed envelopes, ignored/rewritten audit writes and receipt deletion keep the pending evidence. No pending or exhausted row is automatically expired or pruned. Delivery does not execute the business mutation again or require the historical actor to retain current authority.

`auditMutationOutboxHealth()` reports pending/exhausted counts and the oldest creation timestamp. Structured `audit.mutation-outbox` logs contain those counts and delivery results; failures/exhaustion also use the existing coarse audit-outage monitoring path when configured. `audit.mutation-outbox-unavailable` indicates that the sweep could not inspect/update its evidence store. Production monitoring, alert receipt/ownership, retention, capacity and restore acceptance remain required; local tests do not supply that evidence.

Authorized operators can inspect metadata in the restricted database:

```sql
SELECT event_id, created_at, attempts, next_attempt_at
FROM audit_mutation_outbox
ORDER BY created_at, event_id;
```

`next_attempt_at` is Unix time in seconds. Review a failed or exhausted event against the account/identity state, its stored envelope and any primary event with the same ID. Repair the actual audit/schema or conflicting-receipt problem first. Record the investigation/retry authorization in the existing incident review process. After review, a targeted retry can be enabled with:

```sql
UPDATE audit_mutation_outbox
SET attempts = 0, next_attempt_at = 0
WHERE event_id = :reviewed_event_id AND attempts = 8;
```

The next scheduled tick attempts delivery. Do not clear the outbox to resolve a backlog; an operator deletion can destroy the only committed evidence while the primary stream is unavailable. Do not replay the disconnection from its evidence envelope. A missing identity on a repeated HTTP request is a no-op, not evidence of which previous request removed it.

## Scope and validation

Approved producers are identity disconnection and session logout/revocation/cap/expiry. The reader validates each event-specific envelope; unknown producers remain pending for review. See the [session lifecycle record](session-lifecycle-evidence.md) for attribution and concurrency semantics. Profile-name edits use the existing atomic primary-audit contract, refusing the edit if evidence cannot commit. Unknown classification during disconnection retains conservatively PHI-classified evidence with an explicit unavailable marker; unsafe legacy role strings are omitted with a marker rather than copied. User profiles, provider subjects, names, emails and avatars are excluded from these events.

General operation identifiers, external/plugin/R2 outboxes, supplementary authentication-event durability, policy-version revalidation and deployed operating acceptance remain open W4b work. See the [mutation evidence record](w4b-durable-mutation-evidence.md).
