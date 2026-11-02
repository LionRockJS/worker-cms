# Durable plugin identity and capability approval evidence — 3 November 2026

This continues the [local plugin registry slice](plugin-registration-mutation-evidence.md) on `1517d0e`. The optional plugins feature now commits explicit host identity reapproval and capability approvals with exact classified audit receipts in private D1. The implementation is `src/features/plugins/approval-evidence.ts`; administration routes no longer perform those local writes and best-effort success logs separately. W4b remains open.

## Covered administration paths

| POST suffix under `/admin/plugins-manage/:id` | Durable local outcome |
|---|---|
| `/identity` | `plugin.identity.approve`, the explicit pin, capability cleanup and state/sequence move. |
| `/assets/approve`, `/assets/revoke` | `plugin.asset.approve`/`revoke` and the selected integrity approval. |
| `/files/approve`, `/files/revoke` | `plugin.file_prefix.approve`/`revoke` and the selected globally reserved prefix. |
| `/page-types/approve`, `/page-types/revoke` | `plugin.page_type.approve`/`revoke` and the selected read/write scope. |
| `/page-types/approve-all` | `plugin.page_type.approve_all` and every missing declared read/write/owned-blueprint scope in one transaction. |

Approve-all preserves existing attribution and timestamps, deduplicates requests, and includes wildcard declarations. It uses bounded set-based SQL rather than committing independent chunks. A failure in any statement refuses the whole grant set. Repeated single approvals with identical stored attribution/content, repeated approve-all, missing revocations and unchanged pins validate without a false mutation event or timestamp write. A single explicit reapproval by a different actor updates the existing approval attribution as before.

Capability writes require the selected row to be enabled, reachable and already pinned to the freshly observed manifest identity. An unpinned or mismatched row receives a durable named identity-required refusal; the capability mutation does not take an automatic first-use claim. Explicit identity approval can establish an unclaimed first pin with its own receipt. Existing disabled/unreachable response contracts remain; this does not add offline capability revocation.

## Atomic identity transitions

The selected fresh manifest is inspected without calling registry-wide identity enforcement. A changed identity removes capabilities under the old identity and any orphaned capabilities under the destination identity, so neither set silently transfers to the renamed plugin. Both namespace cleanup manifests commit with the pin. Another registered row's identity cannot be claimed; a concurrently inserted owner makes the transaction unavailable.

Host-held state and sequences move from the previous identity to the destination. The existing source-wins behavior for matching destination keys is preserved, including sequence collisions; unmatched destination keys remain. The receipt identifies all removals, saves and overwritten keys without recording their values. State/sequence creation and update metadata are preserved. This slice does not introduce a new counter-conflict remediation policy. Limits/pricing settings and remote tenant registrations remain unchanged and require their separate lifecycle contracts.

The complete registry and pin catalogue, all three capability approval tables, and (for identity changes) the old/destination state and sequence namespaces are captured and guarded. Final assertions verify the complete expected scoped state, including untouched rows, timestamps and values. Missing required schema, unsafe legacy IDs/pins, skipped writes, trigger rewrites and new concurrent namespace entries refuse rather than producing partial cleanup or a misleading success event.

## Authority, classification and private evidence

Admission and completion check the current account/session, `plugin:manage`, exact role/grant catalogue and classification generation. Registry values, credentials and pins remain guarded throughout remote inspection and local commit. Asset approval also checks the captured authority/registry immediately before fetching candidate bytes, after the existing outbound-management audit gate. Asset integrity is computed from bounded fetched bytes and remains enforced by the existing serving-time hash check.

The highest effective classification includes the registry/pin/approval tables, captured plugin scopes and the destination identity. Relevant delegated page-type scopes include wildcard coverage of classified types; approved storage prefixes include sensitive descendants. Identity state/sequence sources contribute their table classes. Protected source-read evidence is awaited and pending strict reads are flushed before writing. Classification changes at any stage invalidate the transaction snapshot.

Mutation targets use the stable registry UUID with the numeric row ID in details. Receipts contain operation correlation, a fingerprint of the observed normalized manifest, identity/scope/path/prefix/key fingerprints, complete per-table removal/save counts and manifests, affected numeric approval IDs, read/write access and asset integrity where relevant. They exclude raw manifest identity, path/prefix/type/key strings, labels, URLs/query strings, configuration, credentials, state/counter values and stored approver emails. Fingerprints support reconciliation; they are not an anonymization guarantee, and classification/retention still applies. The database's existing approver-email display fields remain private stored metadata.

Each SQL source snapshot is limited to 5,000 rows and 1,000,000 UTF-8 JSON bytes before values return to the Worker. Each planned table and complete evidence manifest is also bounded. Because prefix overlap is global and unchanged capability rows are guarded, the administration service captures the complete approval tables; an oversized catalogue requires reviewed remediation or a separate bounded writer. It never silently truncates approvals or commits a partial approve-all set. New numeric approval IDs are allocated safely above both existing IDs and the stored sequence, with sequence admission and final-state guards; exhausted allocation refuses new entries while safe existing-row edits remain possible.

File-prefix conflict decisions are guarded against the complete global prefix catalogue, closing the prior overlap-read/insert race for these administration routes. `plugin_identity_claimed`, `plugin_identity_required` and `plugin_file_prefix_conflict` refusals use the shared exact primary denial receipt or complete durable outbox envelope. Their fixed reasons and route patterns exclude submitted strings. Failure of both stores remains a refused 503.

## Outcomes and remaining boundaries

Failed/uncertain local outcomes return `plugin_approval_change_unavailable`, 503/no-store, and attempt coarse incomplete health evidence. Successful and uncertain outcomes invalidate this isolate's manifest and effective-configuration caches. A lost acknowledgment may follow a committed state change and exact receipt; no automatic replay or rollback claim is made. Shared operation identity, receipt lookup and reconciliation remain R5.

The remote manifest and asset bytes are bounded observations, not part of a cross-service transaction. A manifest fingerprint records what was inspected; it does not assert that remote bytes cannot change afterward. Existing per-serve integrity and declaration/grant intersections remain the enforcement mechanisms. General external intent/delivery/retry/recovery remains R4/R5.

Automatic first-use identity claims from other registry readers, plugin API/service/background writers and in-flight state/sequence updates retain separate evidence/current-authority contracts under R3/R6. A production-call inventory found no remaining callers of the DB-only explicit approval/repin/state-move helpers after these administration routes moved; reusing those helpers would require its own actor/evidence boundary. A later unmigrated writer can still recreate old state or approvals; this slice does not supply global writer acceptance. Tenant configuration/connect/disconnect, limits/pricing and financial administration remain open. Regulated business-write containment remains enforced for identity/grant mutations. The three existing authenticated capability-revocation exceptions remain available with exact local mutation receipts; unavailable required policy/storage/evidence returns 503 without a partial change. There is no schema migration, production mutation, push, deployment or compliance sign-off in this increment.

## Validation

The final focused run passed **448 tests across eight files**, including **179 new approval regressions** and the preceding registry regressions. New tests exercise all eight actions under none/PII/PHI classification, exact receipt abort/ignore/rewrite rollback, current authority/policy/registry/pin checks, state/sequence conflicts and moves, complete manifests beyond 200 scopes, ignored business writes, trigger-induced final-state changes, nested-prefix races, durable denial fallback and both-store failure, no-ops, source-read privacy/failure, scope sensitivity, byte/row/ID bounds, remote inspection ordering, timestamp boundaries, cache invalidation, allocation-sequence races and lost acknowledgments. The expanded integration run also verifies the existing regulated capability-revocation exception and outbound-audit withholding contract.

Build, TypeScript, all eight feature profiles, import boundaries, generated consistency and whitespace checks passed. The local upgrade drill from `f9719a3` matched fresh private/published schemas, reported zero rollback hazards and listed 13 existing private triggers for review. This is local fixture/schema validation, not deployed rollback acceptance. The final serial suite on `1517d0ea` plus this working-tree increment passed **2,843 tests across 87 files**, scoped with `--dir test`. Its log emitted the previously recorded uncaught Worker request-cancellation diagnostic in `test/routes.test.ts` despite reporting all tests passed. This remains an unresolved R6 investigation item; no runtime fix or clean release acceptance is claimed.

Five packages R2–R6 remain open; the provisional planning range stays **23–41 engineering person-days** pending the remaining financial/service writer inventory. Next R2 scope is plugin limits/pricing and financial administration. See the [scope register](w4b-remaining-scope-2026-11-02.md).

The subsequent [limits/pricing and financial continuation](financial-administration-mutation-evidence.md) completes the R2 local writer register. Four packages R3–R6 remain provisionally 18–32 engineering person-days; the five-package count and range above describe this approval increment's earlier baseline.
