# P0 implementation progress - 30 October 2026

Current status after the fifteenth increment (31 October): **five P0 acceptance packages remain open — W0, W1, W2, W3 and W4a**. The [coverage review](sensitive-read-outbound-coverage-2026-10-31.md) records the listed host read/source changes and COV-13 containment, now including direct publication and transfer boundaries. Regulated writes/queue execution/ingestion/billing remain held; designated session/containment/audit maintenance remains available. W3 persistent schema/destination approvals and W4b durable mutation/policy evidence remain engineering work. Queue/pin preparation, historical recovery, governed retirement, owner inventory and external/deployment evidence remain dependencies. The user will deploy and test manually using the [acceptance record](p0-manual-acceptance-2026-10-31.md); no deployed results are recorded. Existing deployments need the reviewed core/trash upgrades before release; see the [runbook](sensitivity-floors.md). Earlier sections are chronological records, not the current remaining-gap count.

This records successive implementation increments against the [shared plan](compliance-implementation-plan-2026-10-30.md). Source was inspected before editing; existing safeguards were retained. This is local implementation evidence, not deployed-control verification.

| Plan item | Existing implementation confirmed | This increment | Remaining work |
|---|---|---|---|
| W0: deployed inventory and containment | Repository configs and local source are available | Identified source-level status; no production data/account inspection | Data-owner inventory, actual deployed revision/bindings, direct bucket domains, caches and any required containment |
| W1: reliable classification | Classification resolution already exposes an `ok` flag; publish/media consumers fail closed | Classified-read middleware now returns 503/no-store on failed lookup; malformed class/kind/empty-key policy also invalidates resolution | Regulated-profile readiness, explicit public-versus-unknown inventory, broader route coverage and durable policy changes |
| W2: private regulated media | Public originals/thumbnails already reject PHI and unavailable classification; uploads set private markers; authenticated route requires `media:regulated` | Reused existing code and regression suites | Inspect deployment/storage/cache boundaries and remaining delivery variants; verify operational grants |
| W3: publication prevention | Host-owned blanket gate already rejects PHI page types and classified taxonomies, including classification outages; unpublishing remains available | Reused existing code and regression suites | Explicit host-persisted schema/destination policies if regulated transfers are introduced; broader snapshot/target coverage and production inventory |
| W4a: sensitive reads | Pages/search/public media have read announcements and strict PHI audit writes | Private plugin files now audit GET/HEAD/list; classification failure withholds results; PHI audit is awaited before a file body is returned; HEAD is metadata-only | Broader export/history/WebSocket/job/downstream coverage review; full restricted bulk manifests where required |

## Behavioral details

- Existing valid unclassified content still works and does not generate classified read events. A classification outage now withholds announced reads instead of silently treating them as unclassified. Deployments missing the classification migration must apply it; an outage does not silently downgrade protection.
- File access still requires the plugin's own credential, declared prefix and host approval. Revocation behavior is preserved.
- Private lists classify actual returned object keys and delimiter prefixes, including nested policy prefixes. Events aggregate by matched prefix, cap recorded IDs at 100 and retain the full returned count. Plugin-wide classifications are also honored.
- Audit attribution preserves the authenticated plugin and its claimed acting-user ID under the existing plugin delegation contract. That ID is not an independently authenticated end-user session. Core batching now keeps distinct actors separate rather than attributing every row to the first actor.
- A missing/failed PHI audit sink denies bytes and metadata. Ordinary PII audit writes retain existing best-effort behavior. GET streams are not returned until strict auditing succeeds.
- No schema migration, feature switch, production deployment, bucket change, cache purge or supplier-contract action was performed. Existing generated-build metadata changes and unrelated documentation work were left in place.

## Verification

Build, type checking, feature profiles, import boundaries and generated consistency checks pass. Regression tests cover missing classification storage, invalid class/kind/key, existing public/regulated publication and media behavior, private GET/HEAD/list attribution, nested prefix listings, plugin-wide classification, revoked prefixes and classification/audit outages. Full suite: **964 tests passed across 51 files**. The initial sandboxed attempt could not start the runtime (localhost permission); the approved local retry completed successfully.

## Follow-on packages

Continue with the outstanding P0 readiness and coverage tasks above before marking W1/W2/W3/W4a fully complete. W4b durable mutations and W5 protected archival remain separate P1 packages, with regulated-write activation gated on their required evidence. The PDF export predates this progress note and has not been regenerated.


## Second increment: regulated readiness and metadata reads

The implementation was inspected again before changes. No regulated profile previously existed; the publication/media safeguards and private-file audit helper were reused.

- Added opt-in `REGULATED_MODE` and deployment-owned `REGULATED_INVENTORY`, with explicit public/PII/PHI declarations, policy agreement, known page/taxonomy checks, required audit feature/archive binding, strong secret/canonical-origin validation and audit-schema checks. Dynamic HTTP and background entrypoints refuse unready configuration. See the [activation and repair runbook](regulated-profile.md).
- Instrumented page-reference/parent-page, user and taxonomy tag lookups, editor history/version previews, media-browser listings and linked-page metadata, and page presence reads.
- Page reads now inherit classified taxonomy associations. Expansion happens before the recorded-ID cap, avoiding omission of a sensitive association beyond the first 100 results. Existing 100-ID storage cap and authoritative total remain; a complete restricted bulk manifest is still future work.
- PHI live sync is withheld, including taxonomy-classified pages. The regulated profile disables live sync entirely until durable stream auditing exists. Durable Object authorization rechecks policy on messages/delivery/idle checks, including sockets established before classification changed.

| Read surface | Coverage after this increment | Boundary |
|---|---|---|
| Admin page list/read/edit/history | Classified reads and distinct version-history events; taxonomy inheritance | Parent options and other nested chrome reads still need a comprehensive inventory |
| Admin JSON page/user/tag lookups | Actual returned IDs and page types, table or taxonomy classification | Classification/public inventory must be maintained by the deployment owner |
| Plugin page list/search/batch/read | Existing events retained; taxonomy inheritance added; empty typed reads still check inventory | External CSV exports rely on plugin data reads; downstream copies are outside host audit |
| Plugin private files | Existing strict GET/HEAD/list audits retained; unknown inventory denied | Bulk IDs remain capped; no independent end-user authentication is inferred from delegated IDs |
| Admin media listing/private reads | Listing and linked-page metadata now announced; existing private download auditing retained | Actual bucket domains and external caches require operator verification |
| Live sync | PHI/profile streams refused rather than served without durable delivery evidence | Durable regulated collaboration is not implemented |
| Queue/cron entrypoints | Regulated readiness gate before execution | Per-job/hook/outbound disclosure auditing remains open |

This increment does not mark all P0 work complete. Deployment inventory/containment, profile activation verification, broader nested/plugin/UI read coverage, external consumer coverage and full bulk manifests remain open. No production profile was enabled and no production data was accessed.

Validation: **987 tests passed across 52 files** in the full suite. The subsequently added real-WebSocket reclassification test passed separately (**1 test / 1 file**). Build, TypeScript checking, feature profiles, import boundaries, generated consistency and diff whitespace checks passed. No production settings were changed.

## Third increment: remaining host read paths - 31 October 2026

Checked the working tree and the earlier implementation before editing. Existing readiness, lookup/private-file auditing, publication/media gates and regulated-sync restrictions were retained. This increment extends the same shared read-audit pipeline rather than adding a second log.

### Implemented coverage

| Surface | Implementation | Validation / boundary |
|---|---|---|
| Nested editor/search/dashboard options | Parent page options retain their actual page type; taxonomy/tag options and displayed editor/modifier user names are announced under their own classifications | A public child page cannot hide access to a PHI parent; classified option data is withheld on audit failure |
| Tag/taxonomy management | Lists, forms, taxonomy choices and selected parent tags announce their actual taxonomy | Includes taxonomy definitions themselves; no labels or lect bodies are copied into audit detail |
| Trash listing | Returned page rows and displayed type summaries are announced; classification inheritance reads `trash_page_tags` rather than active `page_tags` | Deleted records remain subject to their page-type/taxonomy policy; summary counts represent aggregates, not individual-record manifests |
| User administration | List and form reads use the `users` table classification | UI authorization is preserved; PHI-classified table reads fail closed if the audit sink fails |
| Plugin state | GET/list events carry authenticated plugin attribution and honor both contributor and `plugin_state` table classifications | Values never enter audit detail; delegated user IDs retain the existing plugin assertion semantics |
| Plugin content metadata and grouped/list/search tags | Returned taxonomy definitions and tag groups are announced independently of page classifications | Includes tag metadata that cannot be inferred solely from returned page identifiers |
| Plugin custom read/edit renderers | Pending classified page/history events are flushed at the actual renderer dispatch before the page context is sent upstream | A failed audit sink prevents the upstream renderer call, not merely the eventual HTTP response |
| Plugin admin/download/export proxy | A classified contributor-level event is persisted before upstream GET/HEAD dispatch/streaming | This records access to the plugin surface; it is not a claim to know every record in a plugin-owned export |
| Bulk PHI identifiers | Split into bounded audit rows of up to 100 identifiers; chunk counts sum to the original returned total | No early truncation in file/search callers. Projected plugin lists select IDs internally for auditing while preserving requested response fields. PII retains its existing compact cap |

Shared helpers group tag/table reads and preserve actor attribution. The HTTP middleware and pre-disclosure renderer checks share one flush operation; a flushed page read is not recorded again at response time. No new schema, migration or audit storage feature was required. All changes are local.

### Verification

Build, type checking, feature profiles, import boundaries, generated consistency and whitespace checks passed. Final full regression suite: **1,006 tests passed across 54 files**. Failure injection covers nested taxonomy options, user administration, invalid-edit rerenders and plugin state; a PHI trash association is recorded; tests prove plugin render/export upstream calls do not occur during audit failure. Bulk tests reconstruct all 120 core read identifiers and all 111 projected plugin-list identifiers from bounded rows while keeping internally selected IDs out of the response. No runtime diagnostics or unhandled errors were reported in this final run (the existing experimental binding/deprecation warnings remain).

### Remaining boundaries

- W4a is materially extended but not declared globally complete. External plugin-owned databases/exports and direct published-DB consumers need their own record-level coverage and deployment verification. The proxy event cannot infer their actual returned records.
- Background jobs, lifecycle hooks and other outbound side effects still need explicit attributable read/disclosure handling before they send regulated content. These are not covered merely by HTTP middleware or readiness checks.
- Full taxonomy inheritance requires referenced tags to remain resolvable; historical classification/association snapshots across later tag removal or reclassification are not introduced here.
- Nested feature panels/chrome and less common read surfaces require continued targeted inventory. This increment covers the specific paths listed above, not every SQL read in the repository.
- Storage domains, cache purge, configured production classifications, supplier coverage and operational containment remain deployment evidence tasks. No production change, profile activation or compliance sign-off is claimed. Durable mutation logging and protected archive operations remain separate packages.

## Fourth increment: background reads and plugin disclosures - 31 October 2026

Inspected the existing hook, submission-ingest and queued-job implementations before editing. Reused the classification resolver, bounded read evidence, audit schema, plugin approvals and job state machine. This extends W4a and its existing shared ISO/HIPAA mapping; it does not change the assessed control counts or mark the wider package complete.

| Surface | Implemented control | Evidence / boundary |
|---|---|---|
| Off-request audit path | HTTP and background execution share classification, inventory checks, actor grouping, taxonomy inheritance and bounded PHI IDs; background writes have no invented HTTP identity | `src/core/http/access-log.ts`, `src/core/db/audit.ts`; fresh policy resolution for background work |
| Plugin lifecycle hooks | Persist disclosure intent before sending each destination/chunk; classify page metadata, taxonomy associations, destination contributor and forwarded users; PHI requires declared and host-approved page-type scope | `src/features/plugins/hook-audit.ts`, `hooks.ts`; current plugin enablement/secret/subscription and scope approvals rechecked per chunk |
| Submission ingestion | Record scanned published UUIDs before copy/cursor changes; inherit published tag classifications; retain source taxonomy policies for submission hook disclosure | `src/core/db/submission-ingest.ts`; autonomous actor `system:submission-ingest`, or calling plugin attribution |
| Queued bulk actions | Audit selected page slices before the existing mutation engine; refresh the initiating account and effective capabilities | `src/features/jobs/runner.ts`; deleted accounts and revoked grants fail the job before mutation |
| Queued plugin actions | Audit classified `admin_jobs`, destination-plugin and forwarded-user containers before replay; recheck current host/plugin permissions; exclude response bodies from failure records | `src/features/jobs/runner.ts`, `src/features/plugins/extensions.ts`; opaque request-body classification depends on configured container policy |
| Contributor-originated hooks | Preserve authenticated initiating plugin separately from destination; retain a plugin-asserted acting-user ID when supplied | `src/features/plugins/api/hooks.ts`, `api/ingest.ts`; a delegated ID is not independent end-user authentication |

Classified outbound transfers await persistence for PII as well as PHI. Internal background PII reads remain best-effort; PHI reads are strict. Hook evidence uses `event_class: export` with destination, operation, delivery ID and `phase: intent`. It does not prove delivery/receipt; no names, slugs, payloads or credentials are added to the new read/disclosure detail.

### Remaining work and deployment evidence

- This supersedes the previous open item for the specific background paths above. Other outbound paths, nested reads, plugin-owned data/exports and direct published-DB consumers still require a coverage inventory and their own evidence.
- Hooks remain best-effort transport. A blocked hook can follow a committed mutation/draft insertion; no atomic outbox, retry guarantee or receipt is implemented. Operators must reconcile blocked notifications. Durable mutation evidence remains W4b.
- Current account and capability checks do not cancel accepted jobs on interactive logout/token expiry. Background service-owner assignment and production grants must be verified by the deployment owner.
- Configure/inventory `admin_jobs`, destination-plugin and `users` classifications according to actual job payloads. A generic request replay cannot infer record-level sensitivity from arbitrary serialized bodies.
- Published taxonomy associations are evaluated where they currently exist. Historical association/classification snapshots, production bucket/cache containment and protected archival are not established by these tests.
- No production deployment, profile activation, feature switch, new schema migration or compliance sign-off was performed. The PDF export still predates these implementation increments.

### Validation

Build, TypeScript checking, all feature profiles, import boundaries, generated consistency and diff whitespace checks pass. Full suite: **1,020 tests passed across 55 files**, including **14 new background-read/disclosure tests**. These cover strict audit failure, source/destination attribution, approval revocation between 100-page chunks, stale classification/role caches, published taxonomy inheritance, PII outbound failure, deleted accounts and permission revocation.

Validation limitation: the complete run emitted workerd request-cancellation/RPC-stub cleanup diagnostics despite passing assertions; a verbose diagnostic run reproduced them. The new 14-test file, existing 61-test plugin file, existing 8-test ingestion file and the existing cross-invocation bulk-job test each passed separately without those diagnostics. The suite-level cleanup issue remains unresolved and is not treated as production verification.

## Fifth increment: publication and synchronous plugin disclosures - 31 October 2026

Checked the existing publication gate, background audit helper, hook/job audit paths and renderer flush before editing. Reused those controls and the existing per-target failure reporting. No second audit stream, schema migration or replacement publication engine was introduced. This extends the shared W3/W4a work; assessed-control totals and compliance sign-off are unchanged.

| Outbound surface | Confirmed gap addressed | Implementation / evidence |
|---|---|---|
| Page publication to D1, R2 and plugin targets | No classified disclosure intent persisted before copying snapshots | `src/core/publish/audit.ts` reuses classification, inventory, taxonomy inheritance and bounded audit rows; intent is persisted per target/batch, or per fallback page POST |
| Tag-only catalogue publication | Tag sync bypassed the PHI page-publication gate and lacked attributable disclosure evidence | `src/core/publish/index.ts` withholds PHI taxonomy rows, refuses unreadable policy/schema or unknown inventory, and audits each allowed chunk; sync reports withheld counts and target failures |
| Parent metadata in published payloads | Child page/tag payloads can contain identifiers of classified parents | Page and tag parent references are classified before transfer; PHI or unresolvable parent policy withholds the target operation; null page types honor `default` classification |
| Source/destination attribution | Core publication previously had no initiating actor contract | Admin/manual/automatic republish, queued bulk actions and plugin-originated publication pass the existing user/delegated plugin actor; standalone calls identify `system:publish`; destination is separate stable metadata |
| Plugin destination revocation | Bulk fallback calls could retain an earlier plugin registration/secret | Production adapters re-resolve current enablement, secret and publish-target declaration before every POST |
| Synchronous plugin admin requests | POST/PUT/PATCH/DELETE skipped the contributor audit used by reads/queued actions | `src/features/plugins/disclosure-audit.ts` shares strict destination/user disclosure handling; no upstream call on audit failure; claimed single-submit tokens are released for retry |
| Plugin view files and read/edit/new renderers | Forwarded user summaries lacked independent policy/evidence; renderer PII flushing remained best-effort | Shared dispatch check covers empty/new contexts as well as existing records; renderer source reads are flushed once as destination-attributed intent, including PII, before upstream dispatch |

New classified transfers await audit persistence for both PII and PHI. Export detail contains destination, operation, delivery ID and `phase: intent`; payloads, names, slugs, query strings, credentials and arbitrary request bodies are excluded. Successful persistence is not proof of downstream receipt. Publication still collects per-target failures, so a later target/chunk failure cannot undo earlier successful copies. Ordinary unclassified transfers remain compatible and produce no classified rows.

### Remaining P0 review and operational boundaries

- W4a is extended, not declared globally complete. Identifier-only unpublish/remove-tag exchanges still need dedicated attributable evidence; the existing withdrawal path remains available without a new strict audit dependency that could block containment.
- Plugin management/configuration/enrollment exchanges and less common outbound paths need a separate classification/accountability review. The controls above cover the named dispatch points; they are not an exhaustive claim about every `fetch` or storage operation.
- Opaque plugin bodies require correct contributor classification and inventory. Host events do not establish a record-level manifest for plugin-owned databases/exports or direct published-DB consumers.
- The new gates do not purge earlier published PHI tags/pages, CDN copies or external plugin data. Production inventory, supplier eligibility, containment and independently verified recipient controls remain operator evidence tasks.
- Current policy and associations are checked before transfer; no transaction spans policy checks, audit persistence and an external target. Historical classification snapshots, a durable outbox, delivery receipts and atomic source mutations remain separate work.
- No deployment, production profile activation, new migration or feature switch was performed. The PDF export predates these progress increments.

### Validation

Build, TypeScript checking, all feature profiles, import boundaries, generated consistency and diff whitespace checks pass. Final full suite: **1,048 tests passed across 56 files**, including **28 new outbound/publication tests** in `test/outbound-publication-audit.test.ts`. Existing publication, PHI gate, sensitive-plugin-read, background-job and bulk round-trip regression tests also pass; the bounded bulk operation remains below its existing round-trip threshold.

Failure injection verifies that PII audit failure prevents D1/R2 copies and plugin dispatch, PHI tag and parent references are withheld, classification/schema/inventory outages refuse transfers, classification and destination revocation stop later fallback sends, source actor attribution survives HTTP/plugin entrypoints, new/empty render contexts still audit forwarded users, and a single-submit form can retry after refusal. New export detail is checked for absence of content/labels.

The earlier suite-level runtime cleanup diagnostic appeared in an intermediate full run but **did not recur in the final 1,048-test run**; no runtime cancellation, RPC-stub cleanup or unhandled-error diagnostic was found in that final log. This does not claim the intermittent harness issue has been fixed. These results remain local evidence; no production recipient, storage domain or existing external copy was verified.

## Sixth increment: withdrawal metadata and plugin management/enrollment - 31 October 2026

Inspected existing withdrawal adapters, management fetches, enrollment/claim logic and the shared disclosure pipeline first. Retained the submission-mirror refusal, registered destination checks, bounded bulk operations, credential protections and prior read/disclosure controls. Added intent evidence to the named open paths using the same `audit_events` stream and classification/writer helpers. This extends W3/W4a source evidence without changing assessed-control totals or compliance sign-off.

| Surface | Implemented control | Source/test evidence and boundary |
|---|---|---|
| Single/bulk page withdrawal | Persist actor, destination, operation and every withdrawn UUID before each target/batch/fallback POST; resolve available draft, trash and published metadata without reading bodies | `src/core/publish/audit.ts`, `index.ts`; PHI taxonomy inheritance retained after soft-delete; submission mirrors never reach withdrawal adapters |
| Tag catalogue withdrawal | Persist the tag identifier and available taxonomy policy before removing it from targets | Shared withdrawal path; preserves removal when audit evidence is degraded |
| Containment during an audit/policy outage | Attempt withdrawals/revocation, emit stable diagnostics and expose explicit audit-degradation results | `src/core/http/outbound-audit.ts`; missing policy is marked unavailable, not public; no claim of durable evidence when the sink cannot write |
| Management configuration and asset exchange | Require intent before tenant-config GET/PUT, asset inspection batches and asset-approval fetches, including ordinary unclassified management operations | `src/features/plugins/routes/manage.ts`, `disclosure-audit.ts`; actual registry-row IDs for table classification, pinned IDs for contributor/destination |
| Enrollment and automatic re-enrollment | Require management intent before minting/storing/sending a new enrollment ticket; retain the initiating internal actor in short-lived state | `src/features/plugins/enroll.ts`; no administrator email is added to the pending record or new audit evidence |
| Credential claim | Require separate intent after a valid single-use URL-bound claim and before returning the secret; retain the initiating actor plus redeeming plugin | `src/features/plugins/api/tenant.ts`; failure returns 503 without the secret, consumes the ticket and prevents replay |
| Tenant revocation | Attempt intent before remote revocation, preserve containment on sink failure and return `auditUnavailable` | Actor is explicit for management routes; standalone revocation uses a named system actor; recipient deletion is not independently verified |
| Safe failure detail | Enrollment/revocation retain HTTP status only, rather than plugin-controlled response text | Prevents echoed secrets/tickets/configuration values entering stored failure details; transport diagnostics contain stable operation/plugin identifiers |

Administrative exchange envelopes are unconditional and bounded to 100 identifiers per row. They use `data_class: none`/`admin_config` retention, with separate classified rows using existing PII/PHI retention. `none` does not assert public content. A single delivery ID links envelope chunks and supplemental policy evidence. The audit describes intent, including degraded classification state; it does not describe a successful downstream receipt/deletion. Source actors are preserved for HTTP, delegated plugin and queued bulk withdrawal paths.

### Remaining implementation and deployment evidence

- The specifically listed withdrawal, management and enrollment audit gaps are implemented locally. W4a remains open for a complete outbound/indirect-read inventory and external plugin-owned or direct-consumer record-level evidence.
- Containment is an explicit availability exception: an audit outage can still leave a withdrawal/revocation without durable intent evidence. Runtime diagnostics and helper result flags expose this; an independent monitored sink and operational reconciliation remain deployment work. Bulk/API callers retain their existing target-failure behavior; no new alert-delivery system or durable replay backlog is claimed.
- Source metadata that has already disappeared cannot be historically classified. The administrative identifier envelope remains, with unavailable policy reported. Classification/association history and a durable transactional outbox remain separate work.
- Ticket consumption, audit persistence and external delivery are not one transaction. A claim audit refusal requires a fresh Connect attempt; automatic enrollment can be withheld after local secret rotation. Existing expiry, callback binding and cleanup are retained, without a new atomic credential-rotation/revocation protocol.
- The `plugin` and `table:plugins` inventory must match actual configuration data. Asset inspection evidence is contributor/batch level, not a full file-level export manifest. No secret, ticket, variable value, payload, email or raw URL is added to the new intent detail.
- Existing published copies, vendor eligibility, archive protections, audit-diagnostic collection and deployed configuration still need operator verification. No production deployment, profile activation, new migration or feature switch was performed. The PDF export predates these implementation increments.

### Validation

Build, TypeScript checking, all feature profiles, import boundaries, generated consistency and diff whitespace checks pass. Final full suite: **1,069 tests passed across 57 files**, including **21 new withdrawal/management/enrollment regression tests** in `test/withdrawal-management-audit.test.ts`. The focused existing/new outbound, plugin, enrollment and publication suites passed **159 tests across six files**. Existing bulk round-trip limits still pass.

Failure injection verifies preserved D1/R2/plugin containment with per-target audit-degradation results; unavailable-policy envelopes; taxonomy inheritance after trashing; published-only and orphan metadata; all 120 bulk UUIDs in bounded envelope rows; submission exclusion; HTTP/delegated source actors; management fetch refusal before dispatch; actual registry-row identifiers; secret/configuration value exclusion; enrollment refusal before ticket creation; a separate credential-claim audit; secret withholding and replay refusal when claim auditing fails; and tenant revocation during an audit outage. Enrollment/revocation errors are verified to retain status rather than echoed sensitive bodies.

No request-cancellation, RPC-stub cleanup or unhandled-error diagnostic appeared in the final complete run. The historical intermittent harness issue is not claimed fixed. These are local implementation results; production sinks, monitored diagnostics, recipient deletion/receipt, storage boundaries and operational evidence remain unverified.

## Seventh increment: audit outage monitoring and reconciliation - 31 October 2026

Inspected the existing audit review, archive backlog/verification, scheduled service dispatcher, writers and containment diagnostics first. Extended those controls instead of building another review screen or replacing archival. This implements repository support for the P0 outage/reconciliation dependency and part of W5; production monitoring and protected-archive sign-off remain separate evidence tasks.

| Area | Implemented control | Source evidence / boundary |
|---|---|---|
| Failure detection | Core single/batched authentication, mutation and strict/background audit writers report failed writes; invalid/unavailable classification reports a policy fault | `src/core/db/audit.ts`, `data-classes.ts`; normal strict refusal and containment behavior retained |
| Separate failure evidence | Opt-in private `AUDIT_OUTAGE_BUCKET`, separate from primary D1 and sealed archive, retains bounded diagnostic projections with original actor/source attribution | `src/core/db/audit-outages.ts`; raw detail/payloads excluded; URL/email-shaped identifiers redacted; incomplete capture is explicit |
| Independent receiver integration | PHI-free alert contract, stable source/incident identity, persisted acknowledgement/backoff and bounded rotating retry scans | Deployment-owned `AUDIT_MONITOR` binding; acknowledgements prove transport acceptance only; duplicate delivery requires receiver deduplication |
| Scheduled health | Actual primary/journal write probes, classification/readiness and reused archive checks; checks run before regulated admission and normal content work remains gated | Neutral `monitor` feature-service hook; newest archive segment and lag checked; no whole-archive or provider-wide availability claim |
| Accurate health state | Corrupt journal entries and pending failed alerts affect heartbeat state; missing receiver/configuration is unhealthy; review rejects stale all-green checks after 15 minutes | Extends existing `/admin/audit/review`; monitoring does not stop merely because a regulated request/job would be refused |
| Accountable reconciliation | Evidence reference/digest, reviewer, time and explicit disposition; original diagnostic preserved; canonical primary receipt and separate journal review marker | Idempotent identical retry and marker repair; conflicts rejected; primary failure leaves incident unreviewed; old/pruned receipt ambiguity requires controlled archive investigation |
| Access and confidentiality | `audit:read` for diagnostics, plus `menu:manage` for review decisions; private detail reads require a strict recorded read with known PII/PHI classification | A broken primary sink blocks private detail disclosure; coarse external monitoring and authorized out-of-band storage response remain available |
| Existing detection signals | Classified export events now count in the existing bulk/contributor review queries alongside reads | Avoids losing visibility as newer pre-disclosure paths use `event_class: export`; no duplicate signal engine introduced |

No reconciliation action replays a withdrawal, revocation, publish, hook or mutation, or inserts a historical success event. “Reviewed” does not mean evidence was recovered; the unrecoverable-gap disposition stays explicit. Evidence hashes/references are validated for format; external evidence truth and recipient state still require accountable human verification.

### Activation and remaining evidence

- The feature defaults off. Enable only after configuring the separate private journal, approved receiver, opaque source identity, retention/access controls and scheduled trigger. See the [outage monitoring and reconciliation runbook](audit-outage-monitoring.md) and commented example configuration. No production bindings, flags, deployment or external notification destination were configured.
- The receiver must independently alarm on missed heartbeats and route/escalate incidents to responsible staff. A same-provider service binding and separate storage paths do not establish independence from a provider-wide outage. Actual receiver receipts, staff acknowledgement and recovery exercises remain unverified.
- Simultaneous failure of primary, journal and receiver can still lose evidence. Capture is bounded/redacted and cannot restore omitted detail. Independent runtime-log retention, a durable transactional outbox and atomic regulated mutations remain separate controls.
- Reconciliation preserves the original incident and recorded decision. Historical policy/association snapshots and automatic reconstruction from the sealed archive are not introduced. Missing review markers beyond the hot receipt-retention period require controlled recovery rather than blind re-insertion.
- Journal incident/review retention, archive immutability/checkpoints, a comprehensive sensitive-read/outbound inventory, external plugin/direct-consumer coverage and previous recipient-copy verification remain open operating/control work. No assessed-control totals or compliance sign-off changed. No D1 schema migration or change to `cms.features.json` was made; the PDF predates these progress increments.

### Validation

Build (including views/CSS), TypeScript checking, all feature profiles, import boundaries, generated consistency and diff whitespace checks pass. Final full suite: **1,095 tests passed across 58 files**, including **24 new outage/reconciliation tests** and **two new export-signal regressions**. Existing archive, audit, containment, enrollment and bulk round-trip checks remain passing.

Coverage includes primary/journal outages and stalls, preserved strict refusals, best-effort failure capture, redacted/bounded metadata, stable receiver source and idempotency keys, persistent alert backoff, actual health probes before failed admission, archive lag, bounded scan pagination, corrupt-journal and pending-alert health, stale UI status, reader/reviewer permissions, strict private-detail reads, evidence validation, idempotent/conflicting review submissions, primary/marker failure recovery and archived/pruned receipt ambiguity. The final complete log contains no request-cancellation, RPC-stub cleanup or unhandled-error diagnostic; historical intermittent harness behavior is not claimed fixed.

These are local source/test results. No real monitor receiver, staff escalation, bucket protection, production heartbeat, outage exercise or independent failure-domain guarantee was verified or activated.

## Eighth increment: comprehensive sensitive-read/outbound source review — 31 October 2026

Reviewed the existing seven increments before changing code. Enumerated HTTP/admin/contributor route families, nested feature contributions, shared live readers, background work, storage/cache/WebSocket boundaries and network/service-binding dispatches. Reused the classified-read pipeline, existing intent guards and the one audit stream; no replacement monitor, proxy, publication guard or new event store was introduced. The [coverage inventory and follow-up ledger](sensitive-read-outbound-coverage-2026-10-31.md) records source/evidence and the remaining boundaries for each family.

### Implemented source omissions

| Finding group | Change |
|---|---|
| COV-01: full plugin mutation responses | Single/batch creates and PUT/PATCH results now announce the actual returned page IDs/types and contributor actor; partial updates cannot return previously stored PHI fields without strict read evidence |
| COV-02: manual published pull | The actual live source is classified/audited before copying, including published taxonomy inheritance; an existing-draft shortcut also records its draft source. The initiating actor is passed explicitly |
| COV-03: identity/profile/chrome | Shared authenticated chrome announces the user row once at its common entry point; profile adds actual linked-identity row IDs rather than repeating its own user-row announcement |
| COV-04: financial feature reads | Credit sidebar/panels, balances/quotes/charge responses and subscriptions announce actual wallet keys, ledger and subscription IDs, with contributor attribution where appropriate |
| COV-05: contributor metadata/aggregates | Counter GET/next results honor contributor and table policies; quota counts honor the actual page-type policy and hash criteria |
| COV-06: local registry list/edit | Local registry IDs are announced even when a plugin is disabled/unreachable or no tenant exchange occurs, so a classified local secret/configuration response is withheld on audit failure |
| COV-07: reading audit evidence | Returned event IDs and signal aggregates retain their known source sensitivity as a floor; an absent/lower table policy cannot downgrade PHI evidence. Classification rows also honor table policy. Existing administrative access events remain distinct |
| COV-08: runtime schema rows | Stored page/block-type list and edit/view rows honor table policy through actual row IDs; config-derived/nested metadata remains explicitly open |

No returned content, credential/configuration values, identity values, ledger notes or raw query criteria are added to the new read-event detail. Classification and explicit regulated inventory continue to govern table/contributor targets. For deployments preparing an inventory, the new table sources include `users`, `user_oauth_identities`, `plugins`, `plugin_sequences`, `credit_wallets`, `shared_credits`, `credit_ledger`, `shared_credit_ledger`, `credit_subscriptions`, `audit_events`, `data_classes`, `page_types` and `block_types` as applicable; classify real usage rather than copying an assumed public inventory. Composite/logical keys are documented in the review.

### Remaining work, count and release boundaries

**Five P0 packages are still open; eight coverage fixes do not equal eight closed ISO controls.** Four shared repository follow-ups are now recorded with implementation/acceptance criteria:

1. **COV-09 — actual live-source read provenance:** D1/R2 comparison/status readers must carry and audit source type/tag provenance, including a live PHI source paired with a public draft; unverifiable regulated adapters must refuse disclosure.
2. **COV-10 — historical sensitivity continuity:** prevent unsafe retyping/classification reductions and preserve sensitivity for old versions/published copies. Current-container lookup is insufficient. Governed transitions depend on W4b durable policy/mutation evidence.
3. **COV-11 — remaining nested/configuration metadata:** cover settings/translations/custom roles, config/plugin-derived options, joined identities and remaining approval/tenant metadata with real source identities and owner classifications.
4. **COV-12 — inline clone processing and full export evidence:** audit full source chunks before inline clone processing; reconcile complete protected manifests for large PII/projected/mixed exports and downstream plugin records. Existing all-ID PHI read chunking is retained.

These four are grouped repository engineering tasks, not four leaf routes. W0 actual inventory/containment, W2 storage domains/cache purge, W1 production activation, W3 explicit persisted policies before regulated transfers, external plugin/direct-consumer record-level instrumentation, previous recipient-copy verification and monitor/archival operating evidence remain separate acceptance work.

Read-response protection does not make a business mutation atomic. The regression deliberately confirms that an update can commit before its classified response is withheld on audit failure. W4b remains P1 and a **release prerequisite before regulated writes are enabled**. Ordinary PII reads retain their existing best-effort persistence policy; PHI reads are awaited and existing outbound export intents remain strict. Manual pull uses those same read semantics. No production profile, bindings, deployment, recipient notification or standards sign-off changed; no migration was added. The PDF remains the earlier plan export.

### Validation

Build (views/CSS/JS), TypeScript, all feature profiles, import boundaries, generated consistency and diff whitespace checks pass. Full suite: **1,119 tests passed across 59 files**, including **24 new coverage regressions**. The initial focused failure was a test fixture using SQLite rowid instead of the registry's actual ID; it was corrected and the focused/full runs pass.

Failure injection leaves database reads available while rejecting only audit inserts, proving that classified mutation/profile/identity/ledger/configuration/audit evidence responses are withheld. Tests also cover contributor attribution, preserved stored fields, tag-result IDs, subscription IDs, counter results, hashed aggregate criteria and manual-copy refusal before creating a draft. Existing publication/withdrawal, enrollment, monitoring/reconciliation, background read, archive and bulk query-budget suites remain passing. The final complete log contains no request-cancellation, RPC-stub cleanup or unhandled-error diagnostic. These are local results; production operation is unverified.

## Ninth increment: actual live-source read provenance — 31 October 2026

Implemented the host COV-09 follow-up after tracing the registry, D1/R2 adapters, editor/search/dashboard callers, contributor live-status responses and queued status filters. Reused the existing classified-read pipeline; did not infer live sensitivity from a corresponding draft.

| Source boundary | Implementation |
|---|---|
| Live snapshots | Add actual `page_type` and complete `taxonomy_slugs` to the neutral snapshot contract; undefined provenance is distinct from a verified empty set |
| D1 source | Resolve type and taxonomy keys from the published database's own catalogue in the same set-based query; orphan links are unverifiable |
| R2 source | Newly published tag links retain the taxonomy from the snapshot catalogue. Legacy objects lacking that metadata are refused when taxonomy policies apply; malformed page documents are withheld |
| Shared live reads | `getLiveLect`, `liveMapForDraftPages`, `listLiveByTypes` classify/announce actual source UUIDs and containers; HTTP uses the common flush and retains request/session/IP; off-request reads await the existing writer |
| Contributor/background actors | Contributor status reads retain the authenticated contributor/asserted user; queued status filters pass the current job actor. Truly autonomous callers use a service identity with no invented user |
| Direct dashboard reads | Status-filter and published-membership paths announce actual published UUIDs and use that catalogue's taxonomy inheritance. Published-only results are no longer additionally announced as draft IDs |
| Failure response | Unverifiable required provenance produces 503/no-store through a shared safe error. Unknown taxonomy associations are refused under relevant policy or the regulated profile |

The regulated profile requires both source type and taxonomy provenance. Outside that profile, ordinary unclassified custom-reader compatibility remains; missing type is refused when page-type policies apply, and missing taxonomy provenance is refused when taxonomy policies apply. Current source classification is proven; **historical policy/sensitivity continuity is still COV-10**, including copies that lose classified associations. Low-level adapter methods remain storage primitives; production callers use the audited registry wrappers. See `src/core/publish/README.md` for the contract and legacy R2 containment boundary. No existing object was rewritten or republished, and PHI publication denial remains in force.

### Validation

Added **18 live-source regressions**. Source/draft type mismatch, source-only taxonomy classes, unrelated host tag IDs, D1/R2 provenance, orphan and legacy/custom reader refusal, real HTTP withholding, contributor/session/IP attribution, autonomous reads and policy failure pass. A 110-source test retains every PHI UUID in bounded evidence while making exactly two published snapshot queries. Existing dashboard/editor route tests pass. Build, types, profiles, boundaries and generated checks pass.

Full suite at this increment: **1,137 tests passed across 60 files**. That run also emitted the previously observed intermittent workerd RPC-stub/request-cancellation cleanup diagnostic, so it is not presented as a clean runtime-diagnostic run or a fixed harness issue.

## Tenth increment: inline clone source guards and complete identifier manifests — 31 October 2026

Implemented the host portion of COV-12 after checking existing PHI chunking, shared export guards, clone charging/refund behavior and the source selector/chunk loop. Reused `auditReads` and the private audit stream; no separate manifest bucket or competing event pipeline was added.

| Boundary | Implementation |
|---|---|
| Inline clone sources | Await classification and source-read persistence before processing each selected source chunk, for PII as well as PHI. Include the selected look-ahead row, explicit contributor/user attribution, and one operation ID across chunks |
| Large classified identifier sets | Preserve all supplied PII and PHI identifiers in rows of at most 100; each part carries a shared manifest ID, part number/count, total identifier/target counts and completeness flag |
| Classified record exports | Reject an explicitly incomplete supplied identifier manifest before writing success evidence/dispatch; aggregate query counts remain distinct from a record list |
| Investigation | Reassemble IDs from linked parts in the existing private audit stream, retaining actor, classification, fingerprints and destination/operation metadata. New metadata contains no source bodies, raw criteria or credentials |
| Partial work | Refuse further copying on later source-audit failure; retain earlier committed clones. Evidence is source-read intent, not a claim of completed copies or rollback |
| Source scope and counts | Require current contributor read approval for the actual live type in single/list live-status responses, with generic no-store refusals; deduplicate page counts when several source tags share one taxonomy |

The clone handler preserves its existing refund behavior. It does not automatically replay committed work. Mutation atomicity/idempotent recovery remain W4b; preserving sensitivity in new copies remains COV-10. Ordinary PII HTTP reads retain their existing best-effort audit persistence policy; PHI reads and outbound exports retain strict persistence, and clone source reads explicitly use strict persistence for both classes.

The coverage ledger now has **two remaining grouped repository follow-ups: COV-10 (historical sensitivity/propagation) and COV-11 (nested configuration metadata)**. External plugin/direct-consumer record manifests, deployment inventory/containment, private storage/cache evidence, historical recipient-copy cleanup and monitor/archival exercises still require their owners' work. **All five P0 acceptance packages remain open.** No standards-control totals, production flags/bindings or deployments were changed. No migration was added; the PDF remains the earlier plan export.

### Validation

New coverage verifies PII/PHI clone refusal before copying, actual actor/source intent, stopping a later chunk without replaying the first 100 committed clones, complete mixed-class/actor manifests, explicit incomplete-read metadata, incomplete-export refusal (missing/overstated/understated identifiers), failed PII export persistence, real projected PII list IDs, duplicate-taxonomy counts and revoked actual-source read approval.

Final combined validation: **1,151 tests passed across 61 files** (32 additional cases since the eighth increment). Build (views/CSS/JS), TypeScript, all feature profiles, import boundaries, generated consistency and diff whitespace checks pass. Existing publication/withdrawal, plugin/API, archive/outage/reconciliation and bulk query-budget regressions remain passing.

The final full run exited successfully but emitted the previously observed intermittent workerd request-cancellation diagnostic. An earlier combined 1,146-case run was clear of that diagnostic; no harness fix is claimed. The focused source/manifest/scope suites pass. These are local results, with no production activation, live receiver exercise or compliance sign-off.

## Eleventh increment: retained sensitivity for history and copies — 31 October 2026

Inspected existing classification, retyping, tag/taxonomy changes, versions, trash, known copies, live readers and publication gates first. Implemented COV-10 as conservative containment: preserve the highest observed sensitivity and refuse reductions until a reviewed declassification process exists. This extends existing policy/read/audit boundaries rather than introducing a parallel audit system.

| Boundary | Implemented safeguard |
|---|---|
| Container policy | Core `data_class_floors` retains the highest assigned container level. The resolver validates active and retained policy, deduplicates keys and takes the stronger class. A narrow media prefix cannot lower a retained broader PHI boundary |
| Durable record identity | Core `page_sensitivity_floors` retains the derived level by UUID without a cascading foreign key. SQL capture records classification assignments, type/tag associations and UUID changes in the source statement; a floor survives unlinking, trash/restore and purge |
| Optional trash | Feature-owned capture/backfill covers trash-only records, later policy assignments and restored identities. Core has no optional-table dependency; public sparse delete hooks remain functional without trash when no retained sensitive identity is at risk |
| Unsafe transitions | SQL refuses lower-class page retyping and tag moves; taxonomy renames retain classification under the new slug. Admin policy reduction/removal is refused. Direct lower/deleted policy rows cannot override retained floors. The policy screen displays effective and retained-only entries without fake data-class row IDs in evidence |
| Read/probe/history paths | Existing read preparation applies floors to page/trash/version/live sources and type-level count/zero-result probes. Stable UUID provenance is retained internally for full/projected page reads, history and deferred/withdrawal metadata, so deleting the loaded row cannot erase its floor before response auditing |
| Copies | Clones propagate the source floor in the same D1 batch as the new page/version; a failed floor write rolls the clone back. Manual pulls commit the actual published source's floor with the new draft. Ingestion pins audited incoming UUIDs before materialization, including source-only taxonomy classification |
| Publication/live sync | The existing PHI gate additionally checks the UUID floor, so removing an association or relabelling a container does not make protected content publishable or streamable |
| Schema admission | Classification admission checks required tables/views/capture-trigger presence, including trash capture whenever trash tables exist. Missing capture objects or invalid policy/floor values withhold affected reads/publication; regulated admission fails before normal route work |
| Performance/privacy | Floor lookups are grouped by source. Existing bulk round-trip budgets pass; projected API output retains its requested shape. Floor/manifest metadata contains identities/classes rather than bodies, raw criteria or credentials |

### Upgrade and operating boundaries

The baseline was regenerated from owning core/trash fragments. Existing deployments must apply **core first**, then trash if its tables exist, using the reviewed files [core upgrade](../migrations/manual/2026-10-31_sensitivity_core.sql) and [trash upgrade](../migrations/manual/2026-10-31_sensitivity_trash.sql). These manual files are not automatically discovered/applied by the normal migration command. No live migration, deployment, flag or binding changed.

Backfill can establish only sensitivity still observable from current policy/type/tag data. It cannot infer erased pre-installation associations, historic retypes, unlabelled bodies or copies at external recipients. Review backups, quarantine unknown history/copies and apply reviewed additive floor backfill from verified UUIDs where evidence exists. Retained metadata must be included in backup/access/retention policy and effective regulated inventory. A public declaration cannot override a private UUID floor.

There is no supported floor-clearing/declassification API. Lowering or retiring floors requires a governed workflow, complete copy/history evidence, durable transition audit and approved retention handling. Those remain W4b/W5/owner dependencies. The privileged table resets used by isolated test fixtures are not a production procedure. Presence checks do not prove resistance to a privileged attacker replacing trigger definitions or deleting protected metadata.

Keep affected traffic contained through upgrade and rollback: old workers can ignore retained floors. Existing public R2/CDN objects and direct DB consumers still require their owners' containment/cleanup. See the [sensitivity runbook](sensitivity-floors.md). **All five P0 acceptance packages remain open**; assessed ISO/HIPAA control totals and compliance sign-off have not changed. The PDF remains the earlier plan export.

### Validation

The new suite covers **33 cases**: monotonic classification for all container kinds, prefix reductions, classification/association ordering, retyping/tag moves, taxonomy renames, history/probes, trash-only assignment/restore/purge, published-only taxonomy copies, clone atomicity, deleted-source hooks and responses, missing floor storage/capture triggers, retained policy visibility, queued write refusal and actual idempotent core/trash upgrade execution. It also verifies an ordinary sparse delete hook against a schema without trash and stable UUID protection when a loaded row is deleted before response auditing.

Final full suite: **1,184 tests passed across 62 files**. Build (views/CSS/JS), TypeScript, all feature profiles, import boundaries, generated consistency and diff whitespace checks pass. The profile check confirms independently removable optional features with core-only floor capture; bulk publication/withdrawal round-trip budgets remain passing. Final logs contain no request-cancellation, RPC-stub cleanup or unhandled-error diagnostic; historical intermittent harness behavior is not claimed fixed.

These are local source/test results. No production migration or trigger behavior, rollout load, historical recovery, public-copy removal, effective live inventory or declassification/retirement workflow was verified. Without operator containment, unknown legacy content with no remaining classification evidence can still follow its current unclassified policy. Do not activate regulated operation until the runbook's review/quarantine and other release dependencies are satisfied.

## Twelfth increment: shared metadata and count source evidence — 31 October 2026

Rechecked existing shared loaders, caches, metadata routes, plugin management, quota queries and audit readers before changing them. Extended the existing request buffer and classified audit stream; existing publication/management intent and containment behavior remain the transfer controls. No parallel logger or replacement configuration service was added.

| Boundary | Implemented safeguard |
|---|---|
| Settings and language metadata | Shared setting, locale and stored-translation loaders announce keys/codes/composite source IDs. Repeated calls merge IDs for the same source/action rather than repeating an event. Values, credentials and translation text are excluded from evidence |
| Role metadata | Custom label pickers/list/edit and effective grant counts/sets announce their role sources. Built-in/default state uses explicit logical `role_state`/`role_permission_set` targets rather than invented permission-row IDs |
| Cached effective configuration | Cache retains serializable page/block row IDs, locale/default-setting keys and host-attested contributor IDs. Cold and warm reads announce provenance for the current request. Actors and request context are never cached; settings/locales merge with their shared-loader evidence |
| Nested/contributed labels | Taxonomy options, visible plugin navigation, schema contributors, locale/permission labels and credit/limit summary labels follow their taxonomy/table/contributor policy. This is conservative source-dependency evidence, not a claim that every label is PHI or that every source field was forwarded |
| Plugin management | GET responses announce registry, pinned identity and resolved/pinned contributor sources, including disabled/unreachable branches. Asset/file/type approvals use unique source composites; file-prefix conflicts include the actual competing contributor. Existing outbound management gates and revocation containment are reused |
| Joined actor names | Audit list/review retains the actual joined user ID and applies `table:users` policy to the displayed name; synthetic fallback labels do not invent a user source |
| Authenticated contributor attribution | After secret validation, shared metadata reads inherit the authenticated contributor and its asserted acting-user identity. Explicit event actors still take precedence; cached configuration cannot retain a previous caller |
| Selected aggregate snapshots | Draft dashboard, advanced-search, contributor page-list and quota queries return total and retained source sensitivity in one SQL statement. Type-wide UUID floors protect zero-result probes. Count metadata carries a fingerprint and no raw criteria/record IDs; record manifests remain separate. Contributor `count=0` still skips counting |

### Remaining scope and activation

**COV-11 remains open** for trash total/recent/type-summary aggregates, clone estimate counts and direct published-dashboard projections that still defer some source sensitivity lookup. The next increment should capture aggregate sensitivity and published type/taxonomy provenance with the source statement, then test concurrent source deletion/retagging and audit-only failure. These are the remaining grouped repository coverage follow-up, not new standards-control counts.

Metadata policies require an owner review and deployment inventory. The [regulated profile](regulated-profile.md#metadata-source-inventory) now lists source keys and logical identifiers. Warm merged-config evidence conservatively covers all contributors; it is not a precise field-level payload manifest. Count sensitivity scans the relevant type namespace as well as the filtered result, so zero-result probes remain private. Representative production query cost has not been measured.

**Five P0 acceptance packages remain open: W0, W1, W2, W3 and W4a.** Historical recovery, effective production inventory, external record manifests, private media/storage/cache evidence, profile activation and monitor/archival exercises remain owner/deployment dependencies. W4b is still required before enabling regulated writes. No migration, production configuration, deployment, ISO/HIPAA control total or compliance sign-off changed. The PDF remains the earlier plan export.

### Validation

Added **22 regressions** across `test/metadata-read-audit.test.ts` and `test/sensitive-read-coverage.test.ts`: shared-loader policy/refusal/privacy, deduplication, cache warming outside HTTP, current actors on warm hits, configuration source coverage, zero-result/deleted-source count snapshots, audit-only persistence failure, approval composites, disabled pinned identity, authenticated cold/warm schema attribution and joined audit actor names. Existing list/search/projected-manifest assertions now distinguish returned counts from actual record manifests.

Final full suite: **1,206 tests passed across 63 files**. Build, TypeScript, all feature profiles, import boundaries and generated consistency checks pass. Full runs emitted a Workerd request-cancellation diagnostic without a failing test; this remains an unresolved runtime/harness diagnostic, not a claimed fix or evidence of production behavior. No RPC cleanup diagnostic was observed in the final log.

## Thirteenth increment: remaining aggregate and published-source snapshots — 31 October 2026

Continued the COV-11 review through the remaining trash/clone counts and direct D1 dashboard paths. Reused the existing source-provenance and audit pipeline; removed the now-unused dashboard-only deferred published-read announcer. Also applied the shared D1 query to manual pull and ingestion, so their pre-copy evidence protects the actual loaded source if the published record is later retagged or removed.

| Boundary | Implemented safeguard |
|---|---|
| Trash metadata | Total, recent count and grouped type summaries capture retained sensitivity in the same SQL statement as their values. Grouped queries remain inside the optional trash feature. Audit-only failure withholds the metadata even after the source is purged |
| Clone estimate | The quota/charge pre-check uses the shared count snapshot and announces a separate `page.duplicate-count` with a hashed selector and current contributor actor. Existing source-chunk intent, floor propagation and partial-progress behavior remain in place |
| Published dashboard | Identity and full-page D1 projections capture the actual source type and complete taxonomy set. The source audit no longer depends on a later published-catalogue lookup. Query-only metadata is separate from returned rows; identity-only queries retain their narrow projection |
| Displayed tag names | Draft/published-fallback labels announce the actual host tag ID/taxonomy from the same query that loads the displayed name. A host label's sensitivity cannot be inferred solely from a different published catalogue |
| Pull/ingestion | Shared D1 provenance feeds the existing awaited background source evidence and incoming-floor propagation before materialization. Ingestion retains its bounded cursor and narrow submission projection. A loaded existing draft also retains UUID provenance for deferred floor lookup |

The concurrent-source tests use a UUID never stored in the CMS, classified only by its published taxonomy. Both identity/full projections retain their private source through retagging/deletion; failed audit persistence withholds the result. This specifically tests source snapshots rather than accidentally relying on a pre-existing CMS UUID floor.

**The listed COV-11 host changes are now implemented locally.** No remaining confirmed host item is recorded in the COV-01–12 ledger. This is bounded source coverage, not proof that every external consumer or deployment is safe. Owner inventory/classification, representative deployed query cost, source-change/outage exercises, historical recovery and external record-level manifests remain acceptance evidence. **All five P0 packages remain open: W0, W1, W2, W3 and W4a.** W4b/W5 release dependencies still apply; no migration, production configuration/deployment or standards-control total changed.

### Validation

Added **14** regressions for trash total/recent/grouped sensitivity, post-purge audit failure, published identity/full projections under retagging/deletion with healthy/failed audit persistence, nested taxonomy options and clone-estimate actor/fingerprint privacy. The two metadata increments add **36 cases** altogether.

Final full suite: **1,220 tests passed across 63 files**, including existing sensitivity-copy, ingestion, live-read, publication and bulk round-trip checks. After moving the grouped query into the optional trash feature, **28 metadata tests** and TypeScript/profile/boundary/generated checks passed again. Build and diff whitespace checks pass. The final full log has no request-cancellation, RPC cleanup or unhandled-error diagnostic; the intermittent diagnostic observed in the preceding run is not claimed fixed. These are local results; no production activation or compliance sign-off occurred. The PDF remains the earlier plan export.

## Fourteenth increment: enforce the regulated write prerequisite — 31 October 2026

Rechecked the five remaining P0 acceptance packages against current admission, HTTP routes, job replay, scheduling, plugin identity resolution and the existing W4b release prerequisite. Confirmed COV-13: regulated readiness checked policy/schema/bindings but still admitted business/configuration mutations without W4b's durable mutation evidence. Implemented containment at known entry points rather than treating successful read auditing as a write-release decision.

| Boundary | Implemented safeguard |
|---|---|
| HTTP | Regulated mode denies non-read methods before route work by default. Exact POST exceptions cover the two read APIs, session lifecycle, locale cookie, per-page withdrawal, designated capability/identity revocation and strict outage reconciliation. Unknown routes and client method/query overrides cannot enable writes; WebSocket upgrades stay closed |
| Known direct services | Shared write assertion protects ingestion, manual pull, bulk mutations and recurring billing outside HTTP. Bulk withdrawal remains a containment operation |
| Queued work | Enqueue, queue dispatch and direct job runners refuse before claim or side effects. Queued job status/attempts remain intact instead of being converted to a failed/completed business action. Queue dispatch also refuses when no job handler is installed |
| Scheduled work | Monitoring still runs before readiness. With a ready profile, audit archival/retention runs through an explicit maintenance declaration; ingestion and billing remain held. Future scheduled contributions default to held |
| Plugin reads | Existing pinned identities and current capability grants still resolve. First-use identity pinning is withheld while contained, avoiding an implicit trust change on a read |
| Ordinary operation | Unset/false mode retains existing behavior. Invalid nonempty mode values remain unavailable; there is no write-enable bypass flag |

This restricts the **whole regulated deployment**, including public content; it does not infer that a proposed mutation is harmless from a partial payload or a current type label. Authentication/session bookkeeping, read evidence and audit maintenance retain their existing contracts and operational writes. External plugin GET/render behavior and privileged storage access remain owner/deployment boundaries. W4b's atomic mutation/evidence contract has not been implemented by this gate.

### Activation and remaining work

The [regulated-profile runbook](regulated-profile.md#write-containment-pending-durable-mutation-evidence), README and example configuration now describe the changed admission behavior. Before activation, prepare/stop producers and pause or drain consumers using the deployment's reviewed procedure; preserve/reconcile outstanding jobs and verify actual retry, dead-letter and retention settings. Rejected delivery is not an indefinite queue hold: retry exhaustion can remove a message or move it to a DLQ. Durable queued rows support recovery but do not guarantee a future wake-up. No queue was paused/drained and no job was replayed here.

Prepare required plugin identity pins and current grants through reviewed registration before entering this profile. This change does not create those approvals or automatically downgrade the regulated mode. Existing core/trash sensitivity upgrade and historical-containment requirements remain. A future write release must implement/review W4b rather than add an operator bypass.

**Five P0 acceptance packages remain open: W0, W1, W2, W3 and W4a.** COV-13's local gate is implemented; owner inventory, deployed activation/queue/pin evidence, historical recovery, private-delivery/storage/cache evidence, external manifests and operating exercises still prevent acceptance. W3 persistent approvals and W5 archival/retirement requirements remain dependencies. No production configuration, deployment, migration, standards-control total or certification status changed. The PDF remains the earlier plan export.

### Validation

Added **42 regressions**: representative content/configuration/upload/state/counter/credit/enrollment/future HTTP writes are withheld without side effects; exact containment exceptions reject suffix variations; both POST read APIs retain authorization and PHI audit refusal; real logout, authenticated withdrawal and grant revocation work; unauthenticated withdrawal remains denied; bulk/opaque jobs stay queued at zero attempts; direct services refuse; cron archives evidence without ingestion/billing; unpinned plugin reads do not create trust; ordinary writes still succeed; malformed modes and WebSockets remain contained.

Final full suite: **1,262 tests passed across 64 files**. Build, TypeScript, feature profiles, import boundaries, generated consistency and diff whitespace checks pass. No request-cancellation, RPC cleanup or unhandled-error diagnostic was observed in the full log; earlier intermittent harness behavior is not claimed fixed. Results are local implementation evidence, not production or compliance acceptance.

## Fifteenth increment: contain direct publication and prepare manual acceptance — 31 October 2026

Rechecked W3 against the existing PHI publication block, projection, transfer-intent audit, HTTP write lock and non-HTTP producers. Confirmed a deeper COV-13 omission: direct registry publication calls could bypass the HTTP write lock, including calls on unclassified/PII content. Persistent approval workflows still depend on unfinished W4b; this increment strengthens containment without pretending to approve regulated transfers.

| Boundary | Implemented safeguard |
|---|---|
| Single/bulk page and single/all-tag publication | Regulated or malformed nonempty mode refuses before source lookup, snapshot assembly or target discovery. A missing/unreadable source database cannot bypass that early guard |
| Shared transfer intent | Assert write admission before preparing source evidence and again after awaited audit persistence. Apply the same boundary to bulk adapters, fallback pages and tag chunks |
| Result/consumer contract | `writes_unavailable` identifies whole-deployment containment. Bulk output keeps it separate from PHI/submission refusals. Native page/tag messages and the contributor router report containment correctly, including a router mounted without the outer Worker guard |
| Withdrawal | Direct page/tag withdrawal still attempts removal under existing authorization, source evidence and incomplete-inventory diagnostics. No new publication denial was added to the removal path |
| Manual acceptance | Added a release identity/evidence template and 14 test groups across all five P0 packages, with explicit not-run/pass/fail/blocked results and owner/reviewer references |

The transfer recheck observes the environment supplied to the invocation. Tests changing that object demonstrate rechecking after an await and before later serial transfers; a new deployment's flag does not automatically change an already running old invocation. Concurrent targets or earlier chunks may already have transferred data. Intent evidence is not a successful receipt, and a later refusal does not undo a previous transfer. Rollout quiescence, external state/recipient checks and W4b reconciliation remain necessary.

### Manual deployment handoff and next priority

The user will deploy and test manually in the next step. No deployment/account inspection, migration, queue operation or live test occurred here. Use the [manual acceptance record](p0-manual-acceptance-2026-10-31.md) to capture the exact deployed artifact/source digest, feature/configuration fingerprint, applied upgrade evidence, real bindings and owners. A bare HEAD does not describe the uncommitted implementation in this working tree. Completed evidence belongs in restricted storage; the template deliberately contains no invented pass results.

**Five P0 acceptance packages remain open: W0, W1, W2, W3 and W4a.** W0/W1/W2/W4a still need deployment/owner/external acceptance. W3 has actual engineering gaps: persistent host schema/destination approvals and durable policy-change evidence. The recommended next engineering prerequisite is W4b's atomic mutation/policy evidence and idempotent recovery, followed by W3 approvals. Keep regulated writes and PHI publication blocked while those are unfinished. No control/certification totals changed; the PDF remains the earlier export.

### Validation

Added **15 regressions** for direct entry-point refusal in regulated/malformed mode without source queries, manifest discovery, storage/recipient effects or export events; prepared-payload admission; post-persistence recheck; later serial fallback/tag-chunk refusal; direct withdrawal under incomplete inventory; truthful native messaging and a standalone contributor-router refusal. Existing ordinary publication, PHI denial, per-target intent and bulk round-trip checks still pass.

Final full suite: **1,277 tests passed across 64 files**. Build, TypeScript, feature profiles, import boundaries, generated consistency and diff whitespace checks pass. Workerd emitted a request-cancellation/uncaught-exception diagnostic despite no failing Vitest test; it remains unresolved. The focused publication suites pass without that diagnostic; this is not a claimed runtime/harness fix or deployed verification. No RPC cleanup diagnostic was observed in the final full log.
