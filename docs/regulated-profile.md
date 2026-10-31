# Regulated deployment profile

`REGULATED_MODE = "true"` opts a deployment into stricter readiness and container inventory checks. Leave it unset (or `"false"`) for ordinary deployments. Any other nonempty value refuses dynamic requests. This is deployment configuration, not a tenant-editable setting.

## Prepare before enabling

1. Enable the audit feature in `cms.features.json`, rebuild and apply all required core/audit migrations.
2. Bind the private `AUDIT_BUCKET`. Verify write access, retention protection, independent integrity evidence and archive operation separately; binding presence alone does not establish those controls.
3. Set a strong `JWT_SECRET` (at least 32 characters) and `CANONICAL_ORIGIN` to the exact HTTPS origin without a trailing slash/path.
4. Inventory every used page type, taxonomy, table/contributor classification and media prefix. Declare intentionally public containers explicitly; unknown is not public. Configure non-public classifications through existing host classification storage.
5. Set `REGULATED_INVENTORY` to a JSON array. Its PII/PHI declarations must exactly match the database policy; public entries must not contradict exact stored policies. Existing page types/taxonomies must all be declared. Prefix lookup retains the existing most-specific classification behavior; public declarations never erase a stored PHI classification.

Example (adapt to the actual deployment; this is not a complete production inventory):

```toml
[vars]
REGULATED_MODE = "true"
CANONICAL_ORIGIN = "https://cms.example.com"
REGULATED_INVENTORY = '[{"kind":"page_type","key":"patient_note","class":"phi"},{"kind":"page_type","key":"default","class":"public"},{"kind":"taxonomy","key":"diagnosis","class":"phi"},{"kind":"media_prefix","key":"records/","class":"phi"},{"kind":"media_prefix","key":"upload/","class":"public"},{"kind":"table","key":"users","class":"pii"}]'
```

Supported kinds: `page_type`, `taxonomy`, `media_prefix`, `plugin`, `table`. Classes: `public`, `pii`, `phi`. An inventory is nonempty, bounded to 1,000 entries, and rejects unknown kinds/classes, blank keys and duplicate kind/key pairs. Public declarations live in deployment configuration; the existing database classification table continues to hold only PII/PHI.

### Metadata source inventory

Include metadata sources used by the enabled screens and APIs. Their labels and configuration are not automatically PHI; owners must assess their actual contents. Missing required inventory entries withhold the response even when the source is intentionally public.

| Kind/key | Returned or derived metadata | Evidence identity |
|---|---|---|
| `table:settings` | Branding, menus, timezone, page-type extensions, defaults, tenant credit/limit configuration | Setting keys; cached config default keys also identify logical defaults without stored overrides |
| `table:locales`, `table:locale_messages` | Language labels/options and stored translation overrides | Locale code; `locale_code:message_key` |
| `table:roles`, `table:role_permissions` | Custom labels, managed/default state and effective grants/counts | Role name; `role_state`/`role_permission_set` identify logical sets including built-in defaults |
| `table:page_types`, `table:block_types` | Stored schemas and cached schema-derived options | Database row IDs retained in the configuration snapshot |
| `table:plugins`, `table:plugin_identity_approvals` | Local registry/configuration and pinned identity, including disabled/unreachable management branches | Registry row ID / pinned registry row ID |
| `table:plugin_asset_approvals`, `table:plugin_file_prefix_approvals`, `table:plugin_page_type_approvals` | Approval state and approver metadata | Unique `plugin_id:path`, `plugin_id:prefix`, `plugin_id:page_type:access` composites |
| `plugin:<manifest-id>` | Contributed schema, visible navigation, permission/locale/price/limit labels and tenant management responses | Host-resolved or pinned contributor ID; opaque external values remain contributor-scoped |
| `taxonomy:<slug>`, `table:users` | Nested taxonomy options and joined audit actor labels | Taxonomy slug / actual joined user ID |
| `table:pages`, `table:trash_pages` | Cross-type draft/search/trash count queries | Query target with count and fingerprint, without record IDs or raw criteria |

Shared metadata calls merge repeated identifiers for the same source/action within a request. The configuration cache keeps serializable source identities, never request actors; warm hits announce sources for the current caller. Cold source loaders and cached provenance merge under the same settings/locale actions. Merged-config evidence conservatively covers all contributing sources, rather than claiming a precise payload-field manifest.

Draft dashboard, advanced-search, contributor page-list, quota, clone-estimate and trash totals/recent counts capture retained sensitivity in their count statement. Grouped trash summaries capture it per returned type. A type containing a private UUID floor protects zero-result probes too. `count=0` on contributor lists still skips the count query/event. Returned record manifests and count metadata remain separate events.

Direct published-dashboard projections use the same D1 source-query primitive as live readers: actual type and complete taxonomy provenance travel with the queried rows, independently of later source deletion or retagging. Identity-only projections retain their narrow columns; internal taxonomy metadata is excluded from returned rows. Manual pull and ingestion use this captured provenance for their existing pre-copy audit and sensitivity-floor propagation. Orphan/unverifiable provenance retains the existing refusal rules. Dashboard tag labels additionally follow the policy of the actual host tag source used to display them.

## Enforcement and repair

Every dynamic HTTP request checks the required feature/bindings, inventory/policy agreement, known database page/taxonomy containers and schema columns. Static `/assets/` and `/views/` remain available. An unready deployment returns generic `503 regulated_profile_unavailable` with no-store; logs carry the diagnostic. There is no long-lived readiness cache. Queue/scheduled work also checks readiness before execution; failed queue work is not silently acknowledged by this check.

Known-sensitive read paths additionally reject objects/containers omitted from the inventory. Media and publication gates apply inventory checks before release. New page types/taxonomies require inventory updates before further dynamic traffic can continue; coordinate changes in maintenance. Repair via authorized deployment configuration/database migration, since an unready profile also blocks the admin UI and auth routes. Back up and rehearse first. Do not disable the profile as an automatic outage fallback.

This profile intentionally disables live-sync WebSockets for the deployment until durable per-delivery stream auditing exists. HTTP editor views remain available; saves are subject to the write containment below. Ordinary deployments retain their existing save behavior. Independently of the mode, PHI page types and PHI taxonomy associations cannot open live sync. Durable Object authorization rechecks policy before incoming/outgoing messages and through its existing idle alarm. Older sockets lacking page identity are closed if any PHI classification exists; clients reconnect through the checked HTTP route. Revocation and capability validation remain in place.

## Write containment pending durable mutation evidence

`REGULATED_MODE = "true"` now enforces the plan's W4b prerequisite: host content/configuration writes stay unavailable until durable mutation evidence is implemented and reviewed. This applies to the entire regulated deployment, including its public content. A matching inventory and healthy audit sink admit protected reads; they do not enable business writes. There is no write-enable bypass flag.

| Operation | Behavior during containment |
|---|---|
| Content, media upload, opaque state, counters, credits, settings, roles, plugin registration/enrollment and approval changes over HTTP | Denied before route work with `503 regulated_writes_unavailable` and `Cache-Control: no-store`. New non-read routes are denied by default; caller headers/query flags do not bypass the gate |
| GET/HEAD/OPTIONS; POST `/__cms/pages/search` and `/__cms/pages/list-batch` | Existing authentication, scope, inventory and classified-read audit requirements still apply. WebSocket upgrades remain unavailable |
| OAuth callback, refresh, logout; profile locale cookie | Existing identity/session/cookie handling remains available. Logout can revoke the current session. These lifecycle operations retain their existing audit behavior; W4b's durable mutation work is not claimed complete |
| Per-page admin unpublish, plugin tenant disconnect, asset/file/page-type capability revoke, profile identity disconnect | Existing authorization/readiness and containment-intent behavior remain available. Destructive page/registry deletes, bulk mutation forms, toggles that could enable access and approval increases remain blocked |
| Audit outage reconciliation | Existing authorization and strict review receipt remain available |
| Queue dispatch and direct job execution/enqueue | Refused before job claim or side effects. Durable queued status/attempts remain unchanged; no terminal failure or business receipt is fabricated |
| Cron | Monitoring runs before admission as before. With a ready profile, audit archival/retention continues; submission ingestion and recurring billing are held. Future scheduled services are held unless explicitly marked as containment maintenance |
| Direct ingestion, manual pull, bulk mutation and subscription-sweep services | Shared write assertion protects the known non-HTTP callers too. Bulk withdrawal remains a containment operation |
| Direct single/bulk page and tag publication | Registry entry points refuse with `writes_unavailable` before source lookup, snapshot building or adapter discovery. The shared transfer audit asserts containment before preparation and after evidence persistence for each target/chunk. Bulk results distinguish deployment containment from record-level PHI/submission refusals |
| Plugin discovery on a read | Existing pinned identities resolve with current grants. Trust-on-first-use pin creation is withheld; prepare and review required pins before entering the regulated profile |

Opaque plugin GETs/renderers and external consumers still require owner verification of their own behavior. The host gate covers its known business/configuration entry points; authentication, read evidence and audit maintenance continue to write their operational state. Storage primitives and privileged database access remain subject to deployment access controls.

The transfer recheck uses the invocation's environment. A flag change in a new deployment does not revoke an old invocation's environment or undo transfers already started/completed. Keep rollout quiescence and historical-copy reconciliation in the operating procedure. Publication events remain intent evidence, not delivery receipts; direct withdrawal remains available with its existing incomplete-evidence reporting.

Before activating this revision, stop new producers and pause/drain queue consumers through the deployment's reviewed procedure; preserve outstanding job IDs/statuses and review unfinished business effects. A rejected consumer invocation is subject to the queue's configured retry limit: exhausted messages can be deleted or sent to a configured dead-letter queue. A queued database row alone is not a delivery guarantee. See [Cloudflare's retry and delivery-failure rules](https://developers.cloudflare.com/queues/configuration/batching-retries/). Verify the actual retry/DLQ/retention configuration and recovery ownership. No consumer was paused, queue drained or job replayed by this implementation.

Do not disable regulated mode to bypass containment for regulated data. Releasing writes requires W4b's atomic business/audit persistence, correct sensitivity, idempotent recovery and failure tests, followed by reviewed deployment acceptance. Persistent publication approvals (W3) and archival/retirement requirements (W5) remain separate dependencies. Existing core/trash sensitivity upgrade requirements still apply.

For the manual deployment/test step, use the [P0 acceptance record](p0-manual-acceptance-2026-10-31.md). Its results are deliberately unfilled; repository tests are not deployed evidence.

## Evidence boundary

The retained-sensitivity schema is required by the current code. Existing
deployments must apply the reviewed core upgrade and, where installed, the
trash upgrade before release. See the [sensitivity floor runbook](sensitivity-floors.md).
The effective inventory includes retained container policies; public declarations
do not override private UUID floors. Unknown history already erased before
installation needs separate review/containment rather than an assumed public label.

Readiness is a local admission check, not full compliance approval. It does not inspect bucket public domains, existing CDN copies, supplier BAAs, storage encryption, IdP MFA, backup restores, endpoint/workforce safeguards or production archive permissions. Complete those operator checks before accepting ePHI. Direct database consumers and external plugins need their own access/audit controls.

## Background read and disclosure coverage

The following safeguards remain in the implementation. Regulated write containment precedes business ingestion/job/POST activity; ordinary deployments retain these guarded execution paths.

Submission ingestion records scanned published-page UUIDs before copying records or advancing its cursor. Page-type and published taxonomy policies apply; autonomous runs use `system:submission-ingest`, and plugin-triggered runs retain the calling plugin identity. A PHI audit failure stops the batch before those side effects.

Lifecycle hooks persist classified disclosure intent before each destination receives a bounded page batch. Page, taxonomy, destination-plugin and forwarded-user classifications apply; submission hooks also retain published-source taxonomy classification. PHI delivery requires both manifest-declared and current host-approved page-type scope. Enablement, secret and approval are rechecked per destination/chunk. The event detail contains stable IDs, destination, operation, delivery ID and `phase: intent`, without page names, slugs or payloads. This establishes intent evidence, not successful receipt.

Queued bulk actions audit each selected page slice before changing it. Queued plugin requests use the `admin_jobs` table, destination `plugin` and `users` table policies before forwarding; the host cannot infer the classification of an arbitrary serialized job body. Inventory and classify those containers for their actual contents. Current account existence, roles and permissions are checked at execution, including fresh role policies within an originating request context. Job execution is not canceled merely by interactive logout or original token expiry.

Page publication now records classified disclosure intent per D1, R2 or plugin destination before that target receives a snapshot/batch. Tag-only catalogue sync applies the same rule per chunk and withholds PHI taxonomy rows. Snapshot/catalogue parent page and tag identifiers are also classified; PHI references or unresolvable parent policy stop the transfer. Null page types use the `default` policy. A classification outage or unknown regulated inventory withholds publication. Plugin destinations recheck current enablement, secret and publish-target capability for every POST. An audit or destination failure is reported through the existing per-target failure result; some other targets may already have succeeded.

Synchronous plugin proxy requests, client-view file requests and custom read/edit/new renderers now audit their destination and forwarded user summary before dispatch. PII evidence is awaited as well as PHI evidence. Renderer source reads are flushed once as destination-attributed export intent. An audit refusal returns 503 before upstream fetch and releases a claimed single-submit token so the form can retry. Inventory every used plugin contributor and the `users` table; classify opaque plugin request bodies at contributor level because the host cannot infer their record-level sensitivity. Queued requests use the existing job audit instead of duplicating this immediate-dispatch event.

Classified outbound hook/job/UI/publication transfers await the audit write for both PII and PHI. Internal background PII reads retain best-effort logging; internal PHI reads require persistence. A failed hook or transfer can follow an already committed source mutation or draft insertion. Hook delivery is still best-effort transport, with no durable outbox, receipt or retry guarantee; blocked ingestion notifications need operator reconciliation. These records prove persisted intent, not successful receipt or downstream deletion. External plugin-owned records/exports and direct published-database consumers still need their own coverage.

## Withdrawal and management exchanges

Identifier-only unpublish/remove-tag operations now attempt attributable intent evidence before each target/batch or fallback POST. All identifiers are retained in bounded administrative envelopes; available draft, trash and published classifications produce supplemental PII/PHI evidence. The administrative envelope uses `data_class: none` and `admin_config` retention; this is not a public-data assertion. Classified supplemental rows retain their existing retention class. Deleted/unresolvable source metadata is reported as unavailable rather than guessed public.

Withdrawals and tenant revocation are containment operations. If classification or audit persistence fails, they still attempt removal, report stable diagnostics and return `auditFailures` (publish helpers) or `auditUnavailable` (tenant revocation). Where the sink still works, degraded envelopes carry `outcome: error` and `classification: unavailable`. The admin unpublish redirect reports incomplete evidence separately from target failures. These are additional attempts, not a durable outage backlog; collect runtime diagnostics independently and reconcile evidence after repair. Existing readiness, authorization, registered-target and submission-mirror restrictions still apply.

Plugin configuration GET/PUT, management asset inspection/approval fetches, enrollment ticket issuance and credential-claim responses now require persisted management intent even for unclassified containers. Inventory each plugin contributor and `table:plugins` according to actual configuration contents. The table policy uses the real registry-row ID; the plugin policy and destination use the pinned manifest ID. Management/enrollment do not forward the administrator's user summary, and their records do not assert that such a summary was sent.

The initiating administrator's internal actor is retained in the short-lived enrollment record instead of an email and propagated into credential-claim evidence, with the redeeming plugin in `acting_via`. A claim consumes the existing single-use, URL-bound ticket before the audit gate; an audit failure returns 503 without the secret, and replay remains forbidden. Start a new Connect attempt after repair. Legacy pending records lacking the actor retain plugin-only attribution rather than inferring a user from their old email field. The existing expiry, callback binding and pending-ticket cleanup remain in place.

New enrollment/configuration exchanges stop on failed classification or audit persistence. Secret rotation can already have committed its local registry change before automatic re-enrollment is withheld; inspect/reconnect after repair. Enrollment and revocation failure records retain only HTTP status, so a plugin cannot echo tickets, secrets or configuration values into stored errors. New intent detail excludes credentials, variable values, payloads, email and raw URLs. Successful intent persistence does not prove recipient deletion or receipt.

Existing published PHI tags/pages/caches are not automatically removed by the publication gates. Operators must inventory and reconcile earlier copies. A complete outbound inventory, external plugin/direct-consumer evidence, independently monitored audit failures and atomic policy/mutation/delivery guarantees remain outstanding.

## Audit outage monitoring and reconciliation

The optional outage controls now extend the existing audit review, archive-health and writer paths. Enable `AUDIT_OUTAGE_MONITORING = "true"` only after preparing a separate private `AUDIT_OUTAGE_BUCKET`, an approved `AUDIT_MONITOR` service receiver, an opaque `AUDIT_MONITOR_SOURCE` and the five-minute scheduled trigger. See the [activation, receiver contract and reconciliation runbook](audit-outage-monitoring.md).

Core audit-write failures and invalid/unavailable classification create bounded private diagnostics when enabled. A separate receiver gets only coarse alert metadata, with persistent retry state and stable idempotency keys where the journal is writable. Scheduled health probes run before regulated admission, so an unready profile does not suppress monitoring. They reuse archive checks, test actual audit/journal writes, check classification/admission, and send heartbeats. The review screen treats a check older than 15 minutes as stale; the independent receiver must separately detect missed heartbeats.

Authorized operators can review incidents from `/admin/audit/review`, inspect diagnostics only after a strict audit-read write, and record an evidence reference/digest and review disposition. A review receipt is idempotent and preserves the original diagnostic; it does not replay a business effect or manufacture historical success. An unrecoverable gap remains explicitly labelled as such. Primary-receipt failure leaves the incident unreviewed; a retry repairs a failed journal review marker without duplicating the receipt.

These controls are implemented locally and disabled by default. They do not establish production receiver delivery, staff response, protected journal retention, independence from a provider-wide outage or recovery of evidence lost while every sink was unavailable. The existing regulated readiness gate is not a sign-off for the monitor deployment. Operators must verify the new bindings, missed-heartbeat alarms and recovery procedure before relying on them.

No new migrations are introduced by this profile. Missing existing classification/audit migrations cause a safe refusal. Durable mutation logging, protected archive operation and historical classification snapshots remain separate work. See the [P0 implementation progress](compliance-p0-progress-2026-10-30.md) for validation and remaining boundaries.
