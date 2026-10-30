# 0xCMS ISO 27001 and HIPAA readiness review

Reviewed 30 October 2026 (Asia/Hong_Kong), source revision `ac27e68`.

See the [ISO 27001 control matrix](iso-27001-control-matrix-2026-10-30.md) and [HIPAA control matrix](hipaa-control-matrix-2026-10-30.md) for separate columns covering implemented controls, confirmed gaps and evidence still to verify. These clarify the earlier broad “Partial” labels without changing the underlying findings.

## Assessment

0xCMS has useful security foundations, but this review does not establish ISO 27001 conformity or HIPAA compliance. Do not approve an ePHI deployment on the current repository evidence alone. Several confirmed application gaps need remediation, and operational safeguards and supplier contracts remain unverified.

Scope: the feature-sliced host in `workers/cms`, its authentication, authorization, publication, media, plugin file API, classification, audit implementation, deployment configuration, and existing security documentation. This is a source/configuration review, not a production penetration test. No production data, Cloudflare account settings, actual IdP policy, contracts, workforce processes, or external plugin implementations were inspected. September assessments were treated as historical context; current code was checked for subsequent improvements.

ISO/IEC 27001:2022 concerns an organization's scoped information security management system (ISMS). Code supports its controls but cannot by itself earn certification. Annex A mappings below are candidate mappings for the Statement of Applicability, not a complete control audit; confirm against the licensed standard, including applicable amendments. [ISO overview](https://www.iso.org/standard/27001).

HIPAA applicability depends on whether the deployment serves a covered entity or business associate and handles PHI. Review Privacy, Security, and Breach Notification obligations together. HHS still presents the 2025 Security Rule changes as a proposal in the official material retrieved for this review; recommendations such as MFA are hardening recommendations here, not assertions that proposed requirements are already binding. [HHS applicability](https://www.hhs.gov/hipaa/for-professionals/covered-entities/index.html), [rule proposal](https://www.hhs.gov/hipaa/for-professionals/security/hipaa-security-rule-nprm/index.html).

## Existing controls worth retaining

- `src/core/auth/sessions.ts`: 15-minute access tokens, rotating refresh tokens, seven-day rolling and 30-day absolute session limits, live session/account validation. Role changes and revocation do not depend solely on JWT expiry.
- `src/core/auth/roles.ts`: capability-based roles; newly registered viewers have no admin capabilities.
- `src/core/http/headers.ts`: security headers and no-store handling for protected surfaces.
- `src/features/media/routes/public.ts`: public registration checks and private-object marker enforcement before thumbnail-cache access.
- `src/core/http/access-log.ts`: classified, instrumented PHI reads await the audit write and return 503 on audit-write failure.
- `src/core/db/audit.ts`: authentication, authorization-denial and mutation event infrastructure, with user/session attribution.
- `src/features/audit/sweep.ts`: archive-before-prune behavior, segment hashes, chained seals, and verification support. No archive bucket means no pruning.

These are implementation observations, not confirmation that production uses this revision or configuration.

## Prioritized findings and improvements

### F1 — High: publication defaults to copying complete content

**Confirmed:** `src/core/publish/projection.ts:30` obtains rules from runtime extensions; line 53 returns the original `lect` when no rule exists. `src/core/publish/index.ts:93` applies this to snapshots sent to all targets. Projection filters only top-level lect fields; page metadata and tags are also included in snapshots. A missing/disabled policy provider can therefore remove intended minimization. A PHI classification does not itself gate this path.

**Improve:** persist host-owned disclosure policies independently of plugin availability. Deny publication of regulated types unless an approved destination and explicit schema permit it. Validate nested fields, page names/slugs, tags, pointers and draft metadata, not just lect keys. Separate public publication from authorized regulated-data transfer; neither should implicitly authorize the other.

**Acceptance:** missing provider, missing policy, nested PHI and PHI in metadata all fail before any D1/R2/plugin target receives data. Test bulk publication and retries too.

**Mapping:** ISO A.5.12, A.5.14, A.8.3, A.8.12; HIPAA §§164.312(a), 164.312(e), and applicable Privacy Rule use/disclosure restrictions.

### F2 — High: classification lookup failures disable read auditing

**Confirmed:** `src/core/db/data-classes.ts:55` catches database lookup errors and returns an empty classification map. `src/core/http/access-log.ts:143` then skips unclassified reads. The strict PHI audit-write path does not protect against failure to determine classification.

**Improve:** add a deployment-level regulated-data profile that fails closed when classification is unavailable, missing, invalid or not migrated. Require an explicit inventory of classified containers before enabling the workload. Treat declassification as a privileged, durably audited change with review.

**Acceptance:** simulate missing table and failed classification query while page reads still work; verify 503 with no sensitive body. Verify the profile cannot start with incomplete policy/schema.

**Mapping:** ISO A.5.12, A.8.15, A.8.16; HIPAA §§164.308(a)(1), 164.312(b).

### F3 — High: PHI classification does not make media private

**Confirmed:** `src/features/media/routes/public.ts:32` permits registered objects unless the private marker is set. Classification only announces an audit event. `src/features/media/security.ts:113` and thumbnail responses use a public one-year cache policy. Thus an ordinarily uploaded, public-registered object remains publicly deliverable even if its prefix is classified PHI. This is a conditional exposure risk, not evidence that actual PHI was uploaded.

**Improve:** reject classified PHI on both public media routes. Use private-by-default regulated uploads, authenticated per-object authorization, no-store responses, and preferably separate public/private buckets. Inventory direct bucket domains and downstream image processing. For previously exposed objects, assess disclosure, purge controlled caches and rotate URLs; downloaded copies cannot be recalled.

**Acceptance:** anonymous originals and thumbnails are denied for PHI, including pre-existing cache entries and alternate bucket domains. Authorized private downloads remain functional and auditable.

**Mapping:** ISO A.8.3, A.8.12; HIPAA §164.312(a), applicable Privacy Rule disclosure controls.

### F4 — High: audit coverage and mutation durability remain incomplete

**Confirmed:** `src/features/plugins/api/files.ts:117` serves authenticated object GET/list requests without announcing a classified read. Global access logging only processes announced reads, so classifying the prefix does not cover this path. `src/core/db/audit.ts:123` labels ordinary mutations `dataClass: 'none'`; mutation/auth writes remain best-effort and errors are swallowed. Classification changes also use this best-effort path.

**Improve:** instrument private file GET/list and relevant HEAD/export surfaces with plugin/delegated-user identity. Build a coverage matrix for page history, search, export, WebSockets, jobs, submission ingestion and downstream plugin/public consumers; do not assume middleware sees direct D1/R2 access. Persist regulated mutations and their audit/outbox rows atomically where possible, with durable retry, duplicate handling and failure alerts. Classify PHI mutations correctly. For bulk access retain an authorized restricted manifest of all affected IDs rather than only the first 100 where incident reconstruction requires it.

**Acceptance:** each sensitive read/export has attributable evidence; no committed regulated mutation loses its event during injected audit failures. A reviewer can reconstruct a private-file download and a bulk disclosure.

**Mapping:** ISO A.8.15, A.8.16; HIPAA §§164.312(b), 164.308(a)(1)(ii)(D).

### F5 — High readiness gap: durable archive protection is not configured in the production file

**Confirmed configuration, live state unknown:** `wrangler.production.toml` comments out `AUDIT_BUCKET`. The sweep consequently does nothing with that configuration. Hashes and seals in the application's own mutable database do not alone establish independent tamper resistance.

**Improve:** provision and bind the archive; restrict retention-management privileges; anchor checkpoints outside the application writer's authority; alert on backlog, missing segments and verification failure. Validate R2 bucket-lock semantics and administrative override capabilities rather than assuming the configuration comment's “Object Lock” implies an irreversible retention guarantee. [Cloudflare bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/).

The current sweep retries `bucket.put` at the same key if the object write succeeds but seal insertion fails. Bucket locks prevent overwrites, so test this crash window before enabling them: recognize an existing segment, verify its hash, and recover its seal safely. Test concurrent sweeps as well.

**Acceptance:** archive crash/retry and concurrency tests pass with actual retention controls; verification detects missing/changed data; a compromised application writer cannot rewrite historical evidence undetected.

**Mapping:** ISO A.5.33, A.8.15; HIPAA §§164.312(b), 164.316(b).

### F6 — High readiness gap: stronger identity and scoped authorization need deployment evidence

**Observed:** OAuth providers are enabled in production config, but reviewed host code does not enforce MFA assurance or a user-inactivity timeout. Token expiry and rolling session expiry are not inactivity logout. Built-in content capabilities are broad, and classification controls auditing rather than patient/record access.

**Improve:** use an enforced enterprise IdP/Access policy with MFA and prove there is no alternate-origin or provider bypass. Restrict enrollment and provider tenants as appropriate. Add server-side inactivity expiration and reauthentication for exports, role changes and policy changes. Add record/container/field authorization matching job duties, and test tenant boundaries where applicable. Define logged emergency access with post-event review and timely workforce offboarding.

**Acceptance:** bypass and stale-session tests fail safely; a staff member sees only authorized records; emergency access is accountable. Document the risk-based decision for addressable automatic-logoff/encryption specifications rather than treating “addressable” as optional.

**Mapping:** ISO A.5.15–A.5.18, A.8.2, A.8.3, A.8.5; HIPAA §§164.308(a)(3)–(4), 164.312(a), 164.312(d).

### F7 — Deployment gate: supplier eligibility and BAAs are unverified

No signed agreements or service eligibility evidence were inspected. Obtain written confirmation for every actual PHI path: Workers, D1, R2, Durable Objects, Queues, Images, logs, backups, plugin hosts and any email/analytics/AI services. Cloudflare's general HIPAA statement is not proof that this account and every used service are covered. Cloud providers handling ePHI can be business associates even when data is encrypted and they lack its key. [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html), [Cloudflare privacy FAQ](https://www.cloudflare.com/trust-hub/us-privacy-compliance/).

Maintain a data-flow/subprocessor register and approved destinations. Disable uncovered services for PHI. Review trusted plugin UI as code with the user's authority, and separately authorize hooks and publish destinations.

**Mapping:** ISO A.5.19–A.5.23; HIPAA §§164.308(b), 164.314(a).

## Organizational and operational evidence still required

| Workstream | Required improvement/evidence | Suggested owner |
|---|---|---|
| ISMS | Scope and boundaries; interested parties; named security leadership; asset/data inventory; risk assessment and treatment; Statement of Applicability; measurable objectives; internal audit; management review; corrective actions. Include applicable 2024 amendment considerations. ISO clauses 4–10. | Management/security lead |
| HIPAA governance | Determine covered-entity/business-associate role; security official; workforce training and sanctions; documented risk analysis covering all ePHI; access reviews; security policies and periodic evaluation. | Security/privacy lead |
| Privacy workflows | Permitted uses/disclosures and minimum-necessary rules where applicable; access/amendment and accounting workflows; authorization handling; customer/business-associate responsibilities. An access log is not automatically a disclosure accounting. | Privacy lead/product |
| Incident response | Detection, escalation, containment, evidence preservation, breach assessment and legally applicable notifications; supplier reporting commitments; tabletop exercises. | Operations/privacy lead |
| Recovery | Inventory draft/published D1, media, DO state, configuration and plugin dependencies; agree RPO/RTO; separate recoverable copies; test isolated restoration and attachment consistency. Page versions in the same database are not independent backups. | Operations |
| Encryption and keys | Verify actual TLS/storage encryption coverage, privileged access and key lifecycle; isolate and rotate secrets; evaluate application-level encryption for selected PHI/credentials against the threat model. Document any addressable-specification alternatives and rationale. | Platform/security |
| Retention/disposal | Policies for content, versions, trash, files, exports, logs and backups; holds; deletion verification; archive access restrictions. | Privacy/operations |
| Monitoring | Explicitly verify deployed logging/tracing configuration, redaction and sink coverage; alert on audit outage, anomalous export, privilege changes and archive backlog; retain evidence of review. Source config does not explicitly enable observability; account-side configuration is unknown. | Operations |
| Secure delivery | Required CI checks, dependency/secret scanning, review and branch protections, approved releases, vulnerability remediation deadlines and independent testing. Repository CI evidence was not found; external CI may exist. | Engineering |
| Physical/workforce | Cloud assurance reports plus staff endpoint security, device disposal, workstation access, training and termination procedures. Cloud hosting does not eliminate customer physical safeguards. | IT/HR/security |

HIPAA's six-year Security Rule documentation period runs from creation or last effective date, whichever is later. It is not a blanket six-year retention rule for every access log or medical record. Set those periods from purpose, applicable law, contracts and risk assessment. Clarify the “by convention” wording in the existing access-logging design so it is not treated as a statutory audit-log rule. [HHS Security Rule summary](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html), [HHS medical-record retention FAQ](https://www.hhs.gov/hipaa/for-professionals/faq/does-hipaa-require-covered-entities-to-keep-medical-records-for-any-period/index.html).

For implementation planning use [NIST SP 800-66r2](https://www.nist.gov/publications/implementing-health-insurance-portability-and-accountability-act-hipaa-security-rule-0) alongside the actual regulatory text; controls must be tailored to the deployment.

## Suggested delivery sequence

1. **Before accepting ePHI:** confirm applicability and supplier contracts; inventory data flows; close F1–F4; prove private media and production identity enforcement; establish recovery and incident owners. Isolate any existing PHI from public publication/media paths pending verification.
2. **Next 30 days:** configure and test archive protection/recovery; add the regulated profile, full sensitive-access coverage, durable mutation events, scoped authorization, idle logout and alerts. Complete baseline risk assessment and policies.
3. **Following 30–90 days:** conduct restore and incident exercises, independent application testing and access reviews. Complete ISMS documentation, internal audit, management review and corrective actions before seeking certification assessment. Timing is a planning estimate, not a certification promise.

Release evidence should include negative tests for every F1–F6 scenario, inspected deployed settings, executed supplier agreements, approved residual risks and exercised recovery/incident procedures. Passing unit tests alone is insufficient.

## Validation

Static review completed. The initial sandboxed test run could not start the Cloudflare runtime because localhost listening was denied (`EPERM`); it executed no tests. The approved retry of `access-log`, `audit-log`, `audit-sweep` and `security-hardening` passed **44 tests across four files**. These existing tests do not demonstrate closure of the new findings or production compliance. No application behavior or production configuration was changed by this review.
