# W4b durable mutation evidence

**Status: classification and role/user access-management slices implemented locally; W4b remains open and regulated writes remain blocked.** This is repository evidence, not a deployment acceptance or a standards-compliance finding.

The existing audit envelope supplies the actor, request and event metadata. The new mutation evidence builder creates an audit write and a guard for the exact event. The covered D1 mutations and those statements run in one batch, with additional postconditions for the business state. A failed statement or invariant aborts the batch; a connection failure after a possible commit can leave an ambiguous outcome, so an operator must reconcile current state and the corresponding event before retrying.

| Covered operation | Evidence and safeguards |
|---|---|
| Assign or update a classification | `data_class.set` carries the submitted class and actor/request context. The policy, sensitivity-floor changes and event share the transaction; the free-text note is excluded from the event. |
| Create a role | `role.create` is attributed and classified. The free-text label is excluded. Existing orphaned permission rows cause refusal rather than silently becoming grants. |
| Replace role permissions | `role.update` records the prior stored grants, the complete sorted new grant set and whether the role was managed. The observed role/grant snapshot is rechecked inside the transaction. Unmanaged built-ins retain their code-defined defaults. |
| Delete a custom role | `role.delete` records its prior grants and an operation ID. Each affected user receives a linked `user.roles` event with exact before/after roles; checks compare the affected set, evidence and final roles. Built-in role deletion is refused. |
| Assign user roles | `user.roles` records the internal target ID and before/after roles. The transaction rechecks the observed role and the last-administrator condition. |
| Delete a user | `user.delete`, the user, sessions and linked identities are handled in one batch. The event retains the prior role and internal ID, not the user's email. |

Access-management events use the highest classification of the relevant tables. Invalid or unavailable classification refuses the operation, and pending strict protected-read evidence is flushed before mutation. Unsafe or oversized legacy role/grant metadata is refused rather than copied into the audit trail; permission entries are limited to 256 characters and a recorded grant set to 32,768 UTF-8 JSON bytes. A failed or ambiguous transaction sends an incomplete coarse incident through the existing monitoring path when enabled, without claiming which statement failed or whether a commit occurred.

The covered deletion is tested with 205 synthetic users, but production-scale cost and D1 limits still require deployment-specific assessment. A transaction that exceeds its limits must be treated as unsuccessful or ambiguous until reconciled.

## Still required before regulated write release

- Inventory and instrument the remaining regulated content and access mutations. OAuth signup/default-role creation, authentication/session events, migrations/direct SQL and other audit callers are outside this slice.
- Add durable operation identifiers across retries, idempotent recovery and handling for post-commit uncertainty. Complete concurrency/version checks and revalidate classification and actor authorization at execution; these are currently resolved before the transaction. The deletion operation ID links its events, but a new HTTP retry receives a new ID.
- Implement durable outbox, bounded retry/visibility and reconciliation for external, R2, queued and plugin side effects. A D1 batch is not a cross-service transaction.
- Complete classification/declassification governance and W3 host-owned publication schema/destination approvals and policy evidence. Revalidate authority and policy for deferred work.
- Complete W5 archive and retention protection and deployment-specific acceptance. Keep the regulated-write and PHI-publication gates in place until their release prerequisites are met.

No schema migration or regulated-write bypass is introduced by this slice.
