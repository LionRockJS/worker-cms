# P0 manual deployment and acceptance record

Prepared for the user's manual deployment/test step. **No deployed result is recorded here.** The repository progress log contains local test evidence; the five packages below remain open. Store completed evidence in the deployment's restricted evidence system, keeping only opaque references/digests in this repository. Use synthetic records and files for exercises.

## Identify the tested release

| Field | Record before testing |
|---|---|
| Environment / Worker / date | Pending |
| Exact deployed revision and source/bundle digest | Pending; a bare Git HEAD is insufficient while the working tree contains uncommitted changes |
| Feature profile and non-secret configuration fingerprint | Pending |
| Actual DB, published DB, media, audit/journal buckets and monitor receiver | Pending; include resource references and access owners, never secret values |
| Core/trash upgrade rehearsal and applied-version evidence | Pending |
| Tester, accountable data/platform owner and reviewer | Pending |
| Restricted evidence location and follow-up incident/change reference | Pending |

Record each result as **not run**, **pass**, **fail** or **blocked**, with UTC time, tested revision, evidence reference/digest and reviewer. A pass applies only to the stated test and deployment. A blocked or unrun criterion cannot be used to close a package. A bodyless error without proof of no side effects is insufficient for a transfer/write test.

## Preparation and rollout

1. Rehearse existing-database upgrades and failure injection on an isolated staging copy with synthetic data. Follow the [core-first/trash upgrade and historical-containment procedure](sensitivity-floors.md). Retained trash tables need their upgrade even when the feature is disabled. Preserve floor metadata in backup/recovery evidence.
2. Keep affected traffic and existing public/recipient copies contained through migration and code rollout. Inventory direct bucket/custom domains, caches, published-DB consumers and plugin recipients; new Worker guards do not remove earlier copies.
3. Stop producers and prepare/pause/drain queue consumers through the reviewed deployment procedure. Record outstanding durable job states, actual retry/DLQ/retention settings and recovery ownership. Queue rejection is not an indefinite hold or a guarantee of later delivery. Do not replay jobs automatically.
4. Prepare reviewed plugin identity pins and current grants before enabling the regulated profile. Configure the effective inventory, including metadata sources and retained policies. Do not turn regulated mode off to bypass a failed test on regulated data.
5. Deploy manually using the exact reviewed artifact/configuration. Check migration/schema admission before releasing even read traffic. This document does not deploy, apply SQL, alter queues or activate flags.

See the [regulated profile and write-containment rules](regulated-profile.md) for configuration, source inventory and the precise read/lifecycle/containment exceptions.

## Test sequence

| ID / package | Manual test | Required result / evidence |
|---|---|---|
| A01 / W0 | Reconcile actual routes, data types, private files, public/recipient copies, bindings and deployed revision against the owner inventory | Named owners approve the scope; unknown history/copies have reviewed containment/recovery dispositions. Do not infer public status from absent historical metadata |
| A02 / W1 | With the reviewed effective inventory, visit a representative protected read | Correct authorized response and attributable read evidence; deliberately public data is explicitly declared. Record inventory/configuration version |
| A03 / W1 | On staging, introduce an omitted container, conflicting policy or missing required schema/binding; then repair it | Dynamic traffic returns `503 regulated_profile_unavailable` without private content. Repair restores protected reads without disabling regulated mode. Exercise actual installed core/trash capture objects |
| A04 / W1/W3 | In regulated mode, attempt representative page create/update/delete/publish, upload, state/counter/credit write, plugin enrollment and configuration change | `503 regulated_writes_unavailable`, no-store, with unchanged business records/objects and zero new recipient transfers. Query/header overrides do not bypass the gate |
| A05 / W1 | Inspect pre-existing queued jobs and run a scheduled tick under the contained profile | Queued jobs remain unclaimed with unchanged attempts/business state; no ingestion cursor/content or billing changes. Monitoring and designated audit archival still operate. Record queue-level disposition separately |
| A06 / W1 | Resolve a reviewed pinned plugin, then exercise an unpinned synthetic registration on staging | Existing identity/grants are honored; a read does not create a new first-use pin or grant. Required production registrations are reviewed before activation |
| A07 / W2 | Try anonymous, expired, revoked and out-of-scope access to synthetic PHI originals, thumbnails and private GET/HEAD/list paths; include cache-hit, Range and legacy URL variants that the deployment supports | No private bytes or metadata escape. Authorized delivery follows the endpoint's documented behavior, private no-store policy and audit contract. Record unsupported variants rather than asserting support |
| A08 / W2 | Inspect actual public R2/custom domains, CDN routes and previously cached object URLs independently of the CMS route | The selected private boundary cannot be bypassed. Record owner-approved cleanup/purge/recipient evidence for historical copies; a successful new-route denial alone is insufficient |
| A09 / W3 | Attempt publication in the contained profile, including tags/resync and any deployed job/custom caller | No new D1/R2/plugin content transfer; record destination state and recipient-side observations. Direct shared publication helper regressions are local evidence, not proof about an external consumer |
| A10 / W3 | Exercise authorized withdrawal and capability revocation of synthetic prior copies | Removal/revocation is attempted under existing authorization/readiness guards. Check destination removal and any incomplete-audit diagnostics separately. Earlier successful transfers are not rolled back by a later refusal |
| A11 / W4a | Read representative pages/history/search, private file metadata, settings/translations/roles, contributed schemas/approvals, profile/credits and audit evidence | Correct source/container, classification, identifiers/counts, actor, session and delegation. Plugin-asserted user IDs are distinguishable from independently authenticated users. Evidence excludes bodies, credentials and raw criteria |
| A12 / W4a | Query more than 100 classified records and a zero-result probe of a type with private UUID floors; exercise staged source deletion/retagging | Every supplied record ID is reconstructible from bounded manifest parts; counts and fingerprints remain accurate. Captured private sensitivity survives the tested source change; aggregate events are separate from record manifests |
| A13 / W4a | On staging, fail only audit persistence after a successful PHI read; repair and retry | PHI response/stream/metadata is withheld with no-store; outbound intent failure causes zero new transfer. Repair yields attributable evidence. Do not simulate this by corrupting a production audit store |
| A14 / W0/W1/W4a | Exercise classification/audit outage alerts, heartbeat loss, reconciliation and archive verification with approved operators | Actual independent receiver alert, accountable acknowledgment, evidence reference/digest and truthful gap disposition. No automatic business replay or fabricated historical success; archive/journal permissions and retention have separate evidence |

Logout, authorized per-page withdrawal, grant revocation and strict outage reconciliation should remain available under their existing guards. Validate failed authorization as well as the allowed case. Live-sync upgrades remain unavailable in the regulated profile. Ordinary behavior can be checked on a separate synthetic ordinary deployment; do not downgrade the regulated deployment to test it.

## Package disposition

| Package | Current disposition | Required closure input |
|---|---|---|
| W0 — inventory and containment | Open; deployment evidence not run here | A01, rollout/queue preparation, historical-copy dispositions and named owner approval |
| W1 — classification and regulated profile | Open; local safeguards implemented | A02–A06, actual upgrade/trigger/configuration behavior and reviewed activation |
| W2 — private regulated media | Open; local guards implemented | A07–A08, actual storage/IAM/cache/private-delivery evidence |
| W3 — explicit publication policy | Open; containment implemented; approval workflow unfinished | A09–A10 prove containment only. Persistent host schema/destination approvals and durable policy-change evidence remain engineering gaps before approved regulated transfers |
| W4a — complete sensitive-read coverage | Open; listed host changes implemented | A11–A14, representative deployed coverage and record-level manifests from external consumers |

W4b remains the prerequisite for releasing regulated writes: atomic business/audit persistence, sensitivity, idempotency and crash/retry recovery must be implemented and tested. W5 protected archival/retirement and owner/supplier requirements also remain. Neither the checklist nor local regression results establish full ISO/HIPAA compliance or certification.
