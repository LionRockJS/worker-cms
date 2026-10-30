# 0xCMS shared ISO 27001 / HIPAA implementation plan

Prepared 30 October 2026. Planning baseline: `e50a467`; findings originated in the [readiness assessment](compliance-readiness-2026-10-30.md). See the [ISO matrix](iso-27001-control-matrix-2026-10-30.md) and [HIPAA matrix](hipaa-control-matrix-2026-10-30.md) for control/evidence distinctions.

## Objective and scope

Close the confirmed application and repository-configuration gaps with shared changes that support both standards. This plan does not treat unverified controls as absent, or the ISO matrix's “Not relevant — prior review scope” rows as approved exclusions. Finishing this engineering work does not alone establish organizational compliance.

Rechecked the affected source while planning. Publication remains permissive without a rule; classification errors produce an empty map; PHI classification does not restrict public media; private file reads lack announcements; mutation audit writes remain best-effort; the production file still comments out AUDIT_BUCKET; sessions have no inactivity expiry.

**Existing work to reuse:** the current audit feature includes `/admin/audit/review`, bulk-read/refused-access/contributor signals, archive backlog/health reporting and archive verification. Those are implemented foundations. Alert delivery, accountable review evidence and production configuration still require verification; do not rebuild the review screen. Earlier 44-test results belong to the original review and are not validation of this newer revision.

## Priorities and shared control mapping

P0 means a prerequisite for enabling the affected regulated-data path, not a claim that an active incident exists. P1 follows containment and closes accountability/operational gaps. Owners are proposed roles; assign named owners before implementation. Estimates are engineering effort, including focused tests/review, not elapsed calendar time or compliance deadlines.

| Order / work package | Priority / finding | Shared change | ISO Annex A mapping | HIPAA mapping supported | Owner / estimate | Dependency |
|---|---|---|---|---|---|---|
| W0 — deployment inventory and containment | P0 / F1–F3, F5 | Identify affected data/routes; restrict regulated publication/public files pending fixes; inspect actual archive configuration | A.5.9, A.5.12, A.8.3, A.8.12 | §§164.308(a)(1), 164.312(a); applicable disclosure restrictions | Platform + security/privacy / 1–2 days | None |
| W1 — reliable classification and regulated profile | P0 / F2 | Authoritative policy resolution; deny regulated access on missing/failed policy; readiness checks | A.5.12, A.8.15, A.8.16 | §§164.308(a)(1), 164.312(b) | Core maintainer / 2–4 days | W0 inventory |
| W2 — private regulated media | P0 / F3 | Reject classified PHI from public originals/thumbnails; authorize private delivery before bytes/cache access | A.8.3, A.8.12, A.5.34 | §164.312(a); applicable Privacy Rule disclosures | Media/plugin maintainer / 3–5 days | W1; private audit hook from W4a before release |
| W3 — explicit publication policy | P0 / F1 | Host-owned, persistent allowlists and destination approvals; validate the entire snapshot before transfer | A.5.14, A.8.3, A.8.12, A.5.34 | §164.312(a); §§164.502, 164.514(d) where applicable | Core/plugin maintainer / 5–8 days | W1; W4b for durable policy-change records |
| W4a — complete sensitive-read coverage | P0 for PHI delivery / F4 | Instrument private file reads/lists/exports with actor and classification; reconcile all sensitive read paths | A.8.15, A.8.16, A.5.28 | §§164.312(b), 164.308(a)(1)(ii)(D) | Core/plugin maintainer / 3–5 days | W1; coordinate private-delivery contract with W2 |
| W4b — durable mutation and policy evidence | P1; before regulated writes enabled / F4 | Atomic mutation + audit/outbox persistence; idempotent delivery and correct PHI mutation class | A.8.15, A.5.28, A.5.33 | §§164.312(b), 164.308(a)(1)(ii)(D) | Core maintainer / 5–8 days | W1; shared event contract agreed with W3 |
| W5 — protected archival and actionable monitoring | P1 / F5 | Retry-safe archive sealing, concurrency control, restricted retention, independent checkpoints and alerts | A.5.28, A.5.33, A.8.15, A.8.16 | §§164.312(b), 164.308(a)(1)(ii)(D) | Platform + audit maintainer / 4–7 days | W0 live-config check; W4 event contract for end-to-end tests |
| W6 — inactivity expiration | P1 / application part of F6 | Server-side idle limit for regulated sessions, distinct from refresh/absolute lifetime | A.8.5, A.5.18 | §164.312(a)(2)(iii) | Auth maintainer + security / 2–4 days | Approved session policy and external-control check |
| W7 — release and evidence closure | P1 / all confirmed gaps | Fault injection, staging verification, migration/rollback drills and matrix updates | A.8.29, A.8.32; operational evidence for mapped controls | §164.308(a)(8) and verification of safeguards above | Engineering + operations + security / 3–5 days | W1–W6 and deployment evidence |

Estimated total: **28–48 person-days**, excluding supplier/legal lead time, large data migrations, external plugin rewrites, independent penetration testing and organization-wide ISMS work. W2/W3/W4 can overlap after shared interfaces are agreed; archive engineering and identity evidence collection can proceed independently. Estimates should be refined after W0; they are not a delivery commitment.

## Implementation details and acceptance criteria

### W0 — establish the deployment boundary first

Inventory classified page types, registered public media, private prefixes, published copies, direct bucket domains, plugin destinations and actual deployed revision/bindings. Record whether PHI exists in each location; do not infer exposure from the code alone. If affected PHI exists, restrict those paths pending migration, preserve relevant evidence and involve the incident owner for exposure assessment. Keep ordinary public-site functionality where it is demonstrably outside that data boundary.

**Done when:** named data owners approve the inventory; regulated paths have containment or a documented safe configuration; deployed versus repository archive settings are recorded. This is an operational task, not an instruction to delete data or declare an incident automatically.

### W1 — one authoritative policy boundary

Primary files: `src/core/db/data-classes.ts`, `src/core/http/access-log.ts`, `src/core/schema.sql`, `src/types.ts`; profile validation tools and additive migrations.

- Add an explicit regulated deployment mode and readiness checks. Missing schema, unknown required classifications or policy-read errors must produce a safe unavailable result for affected routes, never silently become “unclassified.” Distinguish an intentionally public container from an unknown/unclassified container in this mode.
- Resolve policy before any sensitive body, stream or external transfer starts. A post-handler middleware guard cannot recover bytes already streamed or a plugin request already sent.
- Keep enforcement and neutral policy contracts in core. Optional audit UI must not control whether logging/security policy exists. Reject regulated profile combinations that omit required operational capabilities; ordinary non-regulated profiles retain documented behavior.
- Version policy and constrain changes to authorized administrators. W4b supplies durable events for classification/declassification changes; policy-change failures must not leave an unrecorded downgrade.

**Acceptance:** missing table, missing binding, invalid classification, query timeout/error and unknown regulated type all deny affected access with no sensitive body. Explicitly public reads work. Both enabled/disabled feature profiles pass. Failure signals contain no PHI.

### W2 — authorize private media before delivery

Primary files: `src/features/media/routes/public.ts`, media upload handlers, `src/features/media/security.ts`, `src/features/plugins/api/files.ts`.

- Check classification and existing private markers before public object retrieval, transformation or cache lookup. Deny PHI on both original and thumbnail routes.
- Mark regulated uploads private by default. Provide or reuse an authenticated private route with prefix/object authorization, delegated user or service identity and `Cache-Control: no-store`. Do not weaken existing plugin scopes to make downloads work.
- Attach W4a audit recording to successful sensitive delivery, with the strict record persisted before streaming begins. Cover supported HEAD/range/list variants as appropriate; negative responses must not expose protected metadata.
- Stage an object migration manifest. Verify public R2 domains and caches independently of Worker routes. Purge controlled exposed caches and replace affected keys when needed; downloaded copies cannot be recalled. Separate buckets where required by the deployment's isolation policy.

**Acceptance:** anonymous PHI originals/thumbnails fail, including cached paths; authorized private delivery succeeds and is auditable; unauthorized/expired/revoked identities and out-of-scope keys fail; ordinary public assets still render. Direct storage endpoints cannot bypass the selected private boundary.

### W3 — approve the complete publication snapshot

Primary files: `src/core/publish/projection.ts`, `src/core/publish/index.ts`, `src/core/publish/adapter.ts`, core policy schema and plugin contribution interfaces.

- Persist a host-owned versioned policy per regulated type, independent of plugin availability. Plugins may propose policies but cannot silently loosen host approval. No rule means deny regulated publication.
- Start with a blanket regulated-publication block as containment, then introduce explicit approved schemas/destinations. Separate a public, approved projection from authorized private data transfers.
- Validate nested objects/arrays and all snapshot components: lect, page names/slugs, tags, pointers and draft metadata. Reject malformed/unknown regulated fields rather than relying on a top-level denylist. Keep legacy behavior only for explicitly public types.
- Enforce once before every adapter side effect, covering single/bulk publish, jobs, retry and resync. Validate the current policy/destination on retry; do not send stale queued snapshots after approval is revoked. Align draft/live comparison with the same projection.
- Record policy changes via W4b, including version and approver without sensitive payloads. Retire or re-project already published copies through a reviewed migration rather than assuming future enforcement cleans old data.

**Acceptance:** disabled/missing plugin, absent policy, invalid nested data and PHI in metadata all produce zero transfer to any target. Unapproved destinations and revoked policies fail on retries. Approved public projection is stable; drift indicators remain correct; ordinary public publication remains functional.

### W4 — make evidence durable and complete

Primary files: `src/core/db/audit.ts`, `src/core/http/access-log.ts`, plugin file/page APIs, admin mutation callers, core schema, relevant job/ingest handlers.

**W4a: reads.** Inventory direct/indirect reads: private files, metadata/listing, pages/history, search/export, WebSockets, jobs, service contributors and downstream consumers. Instrument confirmed omissions first; treat remaining routes as a coverage audit rather than asserting they are all broken. Preserve per-event actor identity and delegation, correct classification, target counts and a restricted full manifest where truncated IDs cannot support investigation. Avoid raw query terms, tokens and document bodies. Define how autonomous service actions map to an accountable service owner.

**W4b: mutations.** Introduce a shared audit statement/event builder. Where business changes and audit rows share D1, commit them in one supported atomic database operation. Prefer an atomic audit row directly; add an outbox when asynchronous external delivery is needed, with unique event/idempotency keys, bounded retry and failure/backlog visibility. A queue alone is not atomic with a database mutation. For R2/plugin/external side effects, persist intent, execute idempotently and reconcile outcomes; do not claim a cross-service transaction. Re-evaluate authorization when deferred work executes.

Instrument regulated content writes and classification/publication-policy/role changes first. Correct PHI mutation classification and retention class. For authentication events without a business mutation transaction, define durable recording/failure handling separately: preserve logout/revocation during audit failure while recording or alerting through a recoverable mechanism. Don't log a rolled-back action as successful.

**Acceptance:** inject audit-write failure and confirm no unrecorded regulated D1 mutation commits; crashes/redelivery do not duplicate the business operation; external partial failures remain reconcilable; private reads and representative exports are attributable; audit failure cannot leak a streaming response. Declassification is either committed with evidence or refused.

### W5 — finish archival protection and operational delivery

Primary files: `src/features/audit/sweep.ts`, existing `signals.ts`/review route, audit schema, deployment configuration and runbooks.

- Verify the production binding before changing it. Provision/configure the intended private archive if missing; prove its access and retention settings rather than relying on source comments.
- Make a segment recoverable if object creation succeeds but seal insertion fails. Freeze the intended segment range in durable state; on retry verify an existing object's contents/hash instead of blindly overwriting. Prevent overlapping concurrent sweep ranges or forks using a durable serialization/claim mechanism.
- Reconcile older orphaned segments, and prune only verified sealed ranges. Test actual bucket-lock behavior before activation. Independently protect trusted checkpoints so the application writer cannot replace both data and its only integrity reference undetected.
- Reuse existing backlog/health/signals and review UI. Connect an approved alert sink or existing SIEM, with bounded PHI-free payloads, delivery retry and escalation. Confirm whether operational review/acknowledgment evidence already exists before adding workflow storage. Alert on classification/audit outages, archive lag, missing buckets and verification failures.
- Set retention from approved policy. Do not hardcode six years for every audit record merely because HIPAA documentation has a six-year requirement.

**Acceptance:** locked-object crash recovery, duplicate/concurrent sweeps, object/DB outages and missing/corrupt segments all behave safely; no unverified range is pruned. Archive backlog drains under representative peak load. A test signal reaches its owner, is acknowledged and produces retained review evidence. No shared mutable hash ledger is presented as independent tamper protection.

### W6 — bound inactivity without breaking revocation

Primary files: `src/core/auth/sessions.ts`, access guards, core session schema, WebSocket session validation and refresh routes.

Choose an inactivity limit with the security owner; a 15-minute candidate can be evaluated, but is not asserted as a universal standards requirement. Verify external session controls first. Add server-side last-activity/idle-expiry state with atomic expiry checks and bounded write frequency; document the maximum timing tolerance. Enforce it on HTTP, refresh and WebSocket paths. Background refresh/polling and socket keepalives must not perpetually extend an otherwise idle interactive session. Define meaningful activity and clock behavior explicitly.

Preserve the existing absolute lifetime, rotation grace and immediate revocation. Initialize existing sessions conservatively or require sign-in on rollout; do not silently extend old sessions. Fail closed if session state is unavailable.

**Acceptance:** clock-controlled tests distinguish idle expiry from token/absolute expiry; background refresh cannot keep an idle session alive; concurrent activity cannot revive an expired/revoked session; socket access stops within the documented interval. The addressable-specification decision and any external alternatives are documented separately from the code result.

## Sequence, migrations and release gates

1. **Contain and prepare:** W0; agree classification, event and publication-policy contracts. Start supplier/IdP/archive evidence checks in parallel.
2. **Apply additive schemas:** core policy/session/event schema and optional archive state where needed. Update owning fragments and regenerate baselines; add explicit migrations for existing installations. Never hand-edit generated registries. Rehearse on a representative restored database.
3. **Close disclosure paths:** W1, W2, W4a and the initial W3 block. Non-regulated deployments get compatibility tests; affected PHI paths stay restricted until their acceptance tests pass.
4. **Complete persistence and policy:** W4b and full W3. Implement/test W5 and W6 independently where possible. Do not enable protected writes before their evidence path is durable.
5. **Stage and release:** W7 verifies the exact release revision and production settings. Enable the regulated mode only after policy inventory and migrations are ready. W0 checks alone cannot prove all deployment controls.

For each package run meaningful fault-injection/negative tests plus affected existing suites. Before integrated release run build, type-check, feature-profile/boundary/generated checks and the full suite. Verify feature-disabled behavior and existing-schema upgrades. Staging checks include login/refresh/logout, private original/thumbnail reads, public assets, single/bulk publishing, plugin reads, job retry, role revocation and archive recovery. Use synthetic regulated records, not production PHI, in tests.

Rollback must retain new private/default-deny boundaries. Use additive schema compatibility and forward fixes; if the old binary would expose regulated data, keep the affected route disabled instead of restoring it. Take an authorized recovery copy before migration, preserve policy/event evidence, and document the operator procedure. This plan does not authorize deployment or destructive migration automatically.

**Release exit evidence:** acceptance results per package; migration/recovery rehearsal; deployed policy/binding/IAM checks; private endpoint/cache verification; audit crash/retry evidence; acknowledged operational alert; session policy decision. Update matrix rows only with the exact scope demonstrated. “Implemented — source verified” does not become full compliance without operational evidence.

## Evidence work kept separate from confirmed fixes

| Evidence task | Owner | Decision/output |
|---|---|---|
| Cloud/plugin BAA and service eligibility (F7) | Legal/privacy + platform | Signed coverage for actual PHI paths; exclude uncovered destinations from regulated use |
| IdP MFA, tenant/enrollment restrictions and bypass resistance (external part of F6) | Identity/platform | Deployed policy proof and negative tests; create remediation only if deficient |
| Job-duty authorization | Security + data owner | Decide whether existing roles suffice or narrower access is needed; scope any new authorization work from this matrix |
| Independent backup and recovery | Operations | Backup inventory and restore exercise; external backups may already exist |
| TLS, storage encryption and keys | Platform/security | Actual configuration and key-lifecycle evidence; token hashing is not storage-encryption evidence |
| ISMS, workforce, physical and incident procedures | Security/privacy + management | Existing records, applicability decisions and owners; separately assess the 66 previously unmapped ISO controls |

These are release/assessment dependencies where applicable, not invented software defects. Operational findings can create additional work after inspection. Compliance stakeholders should approve their evidence independently of the engineering implementation review.

## Plan validation

The targeted source paths and existing audit-review implementation were inspected at `e50a467`. Only documentation was changed to create this plan; no new runtime test result, remediation, deployment or contract verification is claimed.
