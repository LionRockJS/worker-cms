# Audit outage monitoring and reconciliation

This extends the existing audit writer, archive health and `/admin/audit/review` screen. It does not replace the sealed archive or turn a review into compliance sign-off. No production configuration was enabled by this implementation.

## Prepare and activate

1. Keep the audit feature enabled and the existing five-minute cron configured. The health-only hook runs before regulated readiness; content ingestion, billing and other normal work still require admission.
2. Bind a **separate, private** R2 bucket as `AUDIT_OUTAGE_BUCKET`. It must have no public domain or public development access. Diagnostics can contain regulated record identifiers, container keys and internal actor IDs. Approve its supplier/data handling, access and retention before use. Do not reuse `MEDIA_BUCKET` or weaken the sealed archive's protections.
3. Restrict writes/deletes and operator access. Incident objects and review receipts are retained by this code; there is no automatic purge. Apply the approved retention/backup controls to `audit-outages/incidents/` and `audit-outages/reviews/`. Health, probe and alert retry state under `health/` and `alerts/` must remain writable. Retention/integrity protection is deployment work, not established by the binding.
4. Bind an approved receiver Worker as `AUDIT_MONITOR`. It must restrict write access to approved CMS service callers, validate allowed source identities and deduplicate incident deliveries. Do not expose an unauthenticated heartbeat endpoint: false heartbeats could conceal an outage. The CMS does not provision or publish this receiver.
5. Set an opaque, non-personal `AUDIT_MONITOR_SOURCE`, matching `^[a-z0-9][a-z0-9._-]{0,63}$`, such as `cms-prod-01`. Keep it stable across revisions; captured source identity stays attached to pending alerts. Use a dedicated journal bucket per deployment rather than sharing tenant diagnostics. Set `AUDIT_OUTAGE_MONITORING = "true"`. Missing/invalid source or an absent receiver is reported as an unhealthy configuration. Other flag values do not enable monitoring.
6. Optionally set `AUDIT_ARCHIVE_MAX_LAG_SECONDS`; the default is 3600. This is an engineering threshold, not a standards requirement. The review screen marks health older than 15 minutes stale. The receiver must independently alert on missed heartbeats, with a threshold appropriate to the configured cron and response objectives.
7. Rehearse the tests below in an isolated deployment with synthetic records, verify receipt with the responsible operator, and retain the evidence. Existing readiness does not itself verify this receiver or the journal's access/retention protections.

See the commented resource bindings and variables in `wrangler.example.toml`. The checked production `wrangler.toml` is unchanged.

## Receiver contract

The service binding receives JSON POSTs. No arbitrary user-configured HTTP URL is used.

| Path | Fields | Required receiver behavior |
|---|---|---|
| `/incidents` | `version`, `kind: audit-outage`, `source`, `incidentId`, `observedAt`, `reason`, `eventCount`, `journalRecorded`, `captureComplete` | Deduplicate `Idempotency-Key`/incident ID within the source; retain operational receipt and open/escalate an accountable investigation; return 2xx only when accepted |
| `/heartbeat` | `version`, `kind: audit-heartbeat`, `source`, `checkedAt`, `primaryWritable`, `classificationAvailable`, `journalWritable`, `archiveHealthy`, `admissionReady`, `alertDeliveryHealthy` | Maintain per-source health, alert on failed checks/pending alert delivery and missed heartbeats, and record recovery independently |

Alert payloads exclude actor IDs, record identifiers, container keys, raw actions/details, source IPs, email, URLs, query strings, credentials and content. A receiver acknowledgement is transport acceptance, not proof that a person investigated it.

A health check performs a real audit probe insert and a nonce write/read in the journal. It reuses classification/readiness validation and existing archive health, verifies the newest archive segment and checks archive lag. It does not verify the entire archive, supplier eligibility or every application mutation. Wider archive verification remains in the existing review surface/W5 work.

## Capture, retries and failure behavior

- Core authentication/mutation/batched/disclosure audit writers capture failures through the same journal hook. Invalid/unavailable classification records a policy failure. With monitoring disabled, these new capture paths are inert and existing fail-closed/containment semantics remain.
- A private incident stores observed failure time, reason, source identity, internal initiating actor/plugin and a diagnostic projection of attempted events. Raw event `detail`, separate name/body/credential fields and error response text are not copied. Email/URL-shaped identifiers are redacted and mark capture incomplete. Other record/container identifiers can themselves contain regulated information.
- Capture is limited to 50 event projections, 100 identifiers per projection, bounded text fields and 256 KiB per object. `eventCount` retains the original row count. `captureComplete: false` explicitly marks truncation or an already incomplete identifier manifest. Even a complete projection is not a copy of the whole original event or evidence that the underlying operation succeeded.
- The alert is attempted immediately. When the journal is writable, receiver state persists, retries back off from one minute to at most one hour, and scheduled scans rotate across at most ten incidents per tick. The review list pages through twenty incidents at a time. These are bounded scans, not an unlimited per-tick drain.
- Alerts use a two-second service-call deadline. Failure-path journal operations have one-second deadlines so a stalled secondary sink does not indefinitely postpone containment failure handling. Timed-out writes are not claimed durable even if a provider later completes them.
- Concurrent ticks or a failed acknowledgement-state write can resend an alert. Receiver idempotency is required; exactly-once delivery is not claimed. A review marker stops further incident-notification retries, while current failed health checks continue in heartbeats.
- If the journal is unavailable, the receiver is still attempted with `journalRecorded: false`, and structured console diagnostics include the incident ID and coarse failure facts. If every path fails, there is no guaranteed durable incident or complete identifier manifest. Independent runtime-log collection and missed-heartbeat detection remain necessary.
- Feature monitoring does not replay a withdrawal, revocation, publish, hook or other side effect. Strict reads/transfers still refuse on audit failure; containment operations retain their existing availability exception. Normal scheduled content work remains gated even though the health-only checks run first.

## Review and reconcile

1. Repair and verify the failing primary/journal/receiver path. A green current heartbeat does not close historical incidents.
2. Open `/admin/audit/review`. It extends the existing archive and security-signal screen with outage state and a paginated incident list. Unavailable or stale state is shown as requiring attention, rather than an empty healthy list.
3. An `audit:read` operator may inspect the incident JSON. That read must itself be durably recorded before diagnostics are returned, with known PII/PHI classification retained. A primary audit outage therefore blocks this private detail view; the independent receiver and authorized out-of-band storage operators remain the outage response paths.
4. Compare the diagnostic with independent request/receiver records, actual source state and recipient evidence. Do not treat an attempted success value or a containment intent as proof of delivery/deletion. A failed mutation audit may follow a committed mutation; a strict failed read may have returned no bytes.
5. An operator holding both `audit:read` and `menu:manage` records one disposition: **evidence located**, **containment independently verified**, or **unrecoverable evidence gap**. Provide a case/evidence reference and its lowercase SHA-256. The server checks format, not the external artifact's truth; the reviewer remains accountable. Do not put patient names, email, credentials or content in the reference.
6. The receipt records reviewer, time, disposition, reference and digest in the existing audit stream under the incident's stable ID, then writes a separate journal review marker. The original incident remains unchanged. Repeated identical submissions do not create extra receipts. Conflicting decisions are rejected. A failed marker write is retryable against the original canonical receipt; a failed primary receipt leaves the incident unreviewed.
7. **Reviewed does not mean recovered.** An unrecoverable gap remains labelled; retain the investigation and follow organizational exception/incident procedures. This workflow neither backfills historical success rows nor restores omitted details. Changing an earlier decision requires a separately governed follow-up, not overwriting it.

Journal incidents, alert acknowledgement state and review markers use separate prefixes. Configure retention so acknowledged incidents and their canonical receipts remain available together; a review is not authority to delete evidence.

If a marker is missing and an incident is older than the existing hot retention period for administrative receipts, the application requires archived-receipt investigation rather than blindly creating a new review. An already retained journal review remains idempotently readable after primary pruning. Repair older unresolved cases through a controlled recovery using the sealed archive and investigation evidence; no automatic archive backfill is implemented here.

## Deployment evidence to retain

- Actual deployed revision, private bucket policy, receiver/source registration and retention/backup settings.
- Synthetic primary-write/classification outage: strict refusal, incident/journal contents, PHI-free alert receipt, bounded retry and recovery heartbeat.
- Journal outage and receiver outage: independent diagnostics/receipt where available, pending retry behavior and external alarm on missing heartbeats.
- Failed regulated admission: health heartbeat occurs while normal content work remains refused.
- Reconciliation by an authorized operator, denial to a read-only operator, idempotent retry and failed primary/marker-write recovery.
- Staff acknowledgement/escalation and a periodic exercise schedule. These operational controls, provider-wide failure independence and recipient verification are not established by local tests.
