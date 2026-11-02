# Transaction-bound classification policy versions

Local W4b continuation, 2 November 2026, following `de0d298`. This closes the pre-transaction classification race for the operations listed here. It does not close W4b, authorize regulated writes or establish deployment acceptance.

## Persistent generation and admission

Core owns `classification_policy_version`, a singleton nonnegative integer generation. Six database triggers increment it for every insert, update or delete on `data_classes` and `data_class_floors`, including equal-value updates. A policy change followed by restoration still invalidates an older generation. Policy writes and increments share their transaction; rollback restores both. The integer constraint prevents overflow from silently becoming an imprecise generation.

`resolveDataClasses()` reads the generation, policy rows and retained container floors in one SQL statement, including an empty-policy sentinel. A missing table, missing singleton, invalid generation or missing required trigger makes classification unavailable. Existing sensitivity-schema and malformed-policy checks remain in force. This is a classification generation, not a revision of every application setting, approval or content row.

Covered successful mutation evidence records `classification_policy_version` and verifies the same generation inside the business/audit batch. Exact audit-row verification and the generation assertion share one statement, preserving the preceding-write invariant. A concurrent policy change, change-and-restore or policy change by a business/audit trigger aborts the transaction. Provider/profile no-op paths also check their captured generation, without inventing a mutation event. No external effect is performed inside these batches.

D1 documents that an error in a batched statement rolls back the sequence: [D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). A lost commit acknowledgment can still be ambiguous; these checks do not provide automatic operation replay or general idempotency. Reconcile business state and retained evidence before retrying an uncertain result.

## Covered operations

| Operation | Policy check |
|---|---|
| User role assignment and user deletion | Explicit classified evidence proof plus the current actor/session/role-grant authorization guard. |
| Custom role creation, grant replacement and deletion | Explicit classified evidence proof; core management authorization also captures a classification generation and checks it at batch admission, including direct store callers. Linked per-user removal events retain the deletion operation ID. |
| OAuth registration, identity linking and provider profile refresh | Classified evidence guard; existing-account validation also checks the generation on no-op paths. |
| Self-service display-name edit | Classified evidence and final generation guard, including unchanged-name validation. |
| Session creation/sign-in, refresh rotation and access-only refresh grace | Classified evidence guard before returning issued credentials. A failed guard cannot turn into successful stale grace evidence. |
| Classification assignment/update | Starting generation and current `menu:manage` actor/session/role catalogue are checked before mutation. The final generation must equal the starting value plus two: the one policy-row write and its one retained-floor write. Evidence records both versions. Unexpected additional policy writes roll back the batch. |

Policy generations are global. An unrelated classification edit can conservatively refuse an in-flight covered mutation; callers receive the existing unavailable response and must retry from fresh state. Existing access-authority catalogue checks remain independent and intentionally allow an authorized actor to reduce its own role/grants during its transaction.

Logout, session cleanup/revocation, identity disconnection and refusal recording must remain available during policy repair. Their evidence is now always conservatively PHI-classified, including when a lower classification was observed before the batch. They retain classification-unavailable markers when applicable and existing exact outbox/primary evidence checks. They do not require an unchanged policy generation or relabel a stale classification as authoritative. Existing outbox readers accept these unchanged envelope contracts; no delivery replay reclassifies historical evidence.

## Existing-install rollout and recovery

Fresh databases receive the generated core baseline. Existing private D1 databases need [the additive upgrade](../migrations/manual/2026-11-02_classification_policy_version.sql), after the sensitivity-floor upgrades and before version-aware code. This also applies to ordinary deployments: classification lookup fails closed without the new schema. No published-database schema changes are needed.

1. Review/back up the target private database and verify its sensitivity-floor schema. Coordinate policy-writer maintenance while applying the upgrade and deploying compatible readers/writers.
2. Apply the reviewed additive SQL to that private database. It creates the singleton and six triggers; reapplication preserves an existing generation. Never reset the generation during normal operation.
3. Verify the singleton and trigger presence, then exercise an audited policy edit and a covered mutation in staging. Confirm policy/floor writes advance the generation, stale mutations are refused, and failures retain neither business changes nor success evidence.
4. Exercise containment, primary-audit outage/outbox delivery and monitoring during policy repair. Check query budgets, latency, retention and backlog under representative concurrent policy edits.

A missing generation/trigger is a schema incident. Do not bypass checks or reset the counter to make a request succeed. Drain in-flight work and reconcile policy/evidence before a reviewed repair; retain historical events and the highest classification floors. Rolling back application code removes these new guarantees, so keep regulated containment and avoid treating an older writer as accepted. Database administrators can change schema/counters directly; this mechanism is not a defense against a privileged database administrator replacing same-named triggers or resetting a generation.

## Local verification and remaining scope

The new regressions exercise exact version attribution, empty policy, all policy/floor write kinds, change-and-restore, concurrent upgrades, user/role refusals, OAuth/profile/session guards, refresh grace, intra-transaction trigger changes, classification-writer session revocation, absent generation machinery and conservative containment. The upgrade was also applied to a synthetic existing SQLite schema and reapplied without resetting its generation.

Validation: **39 new regressions** pass. The final serial suite passed **1,691 tests across 75 files**, with no cancellation, uncaught-exception or unhandled-error diagnostic in its log. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. The synthetic existing-schema upgrade and idempotent reapplication also passed. These are local results, not deployed acceptance.

Remaining W4b work includes other content/plugin/service mutations, general operation identities and cross-store/external recovery. W3 schema/destination approvals and their policy versions remain separate unfinished engineering. Other sensitive reads/outbound paths do not gain transaction-bound versions from this increment. Production migration/deployment, operating recovery/capacity/retention acceptance and compliance sign-off remain outstanding.
