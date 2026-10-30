# Remaining 66 ISO 27001 controls: CMS repository feasibility

Assessed 30 October 2026 against revision `2e6965e`. This extends the original 27-control assessment with feasibility and sampled implementation evidence, not a completed compliance audit. All 66 identifiers below were previously labeled “Not relevant — prior review scope”; that placeholder is now retired. Unassessed did not mean irrelevant.

Source evidence inspected: package scripts/lockfile, Vitest bindings, feature/build validation tools, HTTP headers/origin/body/rate controls, plugin URL handling/asset approvals, upload validation, privacy-table masking, audit signals and current regulated-data modules. No runtime tests, dependency advisory scan, live account inspection or workforce/facility verification was performed for this evaluation. Existing external CI or controls may exist even where no repository workflow was found.

The code has advanced since the original plan: `src/core/publish/regulated.ts`, regulated media guards and associated tests now exist. This evaluation does not revalidate or close the original findings, and does not overwrite their historical statuses. Refresh those separately against the current revision before scheduling duplicate work.

## Results and interpretation

| Delivery category | Count | Meaning |
|---|---:|---|
| Repo-led engineering | 13 | Substantial application, tool or CI implementation belongs here; operating evidence is still needed. |
| Hybrid: repo + external enforcement | 19 | Useful code/configuration/integration belongs here, but a provider, operator or external service must also enforce it. |
| Repository documentation/process support | 17 | Policies, runbooks, templates or evidence references can live here; organizational execution is the control. |
| External control; no meaningful CMS enforcement | 17 | People, facilities, devices or network services implement the control; adding a CMS feature is not an appropriate substitute. |

**32 controls have substantive engineering contributions (13 repo-led + 19 hybrid).** Another 17 can receive documentation/process support, while 17 principally require external implementation. These counts describe delivery feasibility, not new implemented-control counts or compliance percentages. Existing support in a row is a sampled observation; proposed work is not automatically a confirmed defect.

This allocation is an engineering judgment based on the CMS boundary. Risk assessment determines final applicability; do not exclude a control merely because Cloudflare or IT implements it. ISO distinguishes management-system requirements from control implementation guidance. [ISO 27002 overview](https://www.iso.org/standard/75652.html).

## All 66 controls

### Organizational — 22

| Control | Area | Delivery | Existing evidence / limit | Useful repository work | External evidence / completion condition |
|---|---|---|---|---|---|
| A.5.1 | Security policy framework | Repository documentation/process support | No policy approval evidence reviewed | Version security policies and review history | Management approves and communicates policy; a committed document alone is insufficient |
| A.5.2 | Security roles and ownership | Repository documentation/process support | No responsibility register reviewed | Maintain control owners and engineering responsibilities | Management assigns authority and verifies ownership |
| A.5.3 | Separation of conflicting duties | Repo-led engineering | Roles/capabilities exist | Separate author/approver permissions; prevent self-approval for selected high-risk changes; test bypasses | Agree conflicting duties and review privileged exceptions |
| A.5.4 | Management security duties | Repository documentation/process support | Management practices not inspected | Provide management review/checklist templates | Managers enforce responsibilities and retain evidence |
| A.5.5 | Liaison with authorities | Repository documentation/process support | Authority relationships not inspected | Document escalation route and restricted contact-register reference | Authorized staff maintain contacts and make notifications |
| A.5.6 | Security community contacts | Repository documentation/process support | External memberships not inspected | Record subscribed security communities and review cadence | Assigned staff participate and act on relevant information |
| A.5.7 | Threat intelligence | Hybrid: repo + external enforcement | Dependencies and plugin inventory supply context | Correlate advisory feeds with deployed versions and create triage tasks | Human relevance assessment and action tracking; feed retrieval alone is insufficient |
| A.5.8 | Security in project delivery | Repository documentation/process support | Security assessments and implementation plan exist | Add threat/risk review milestones to project templates | Project owners apply them throughout delivery |
| A.5.10 | Acceptable asset use | Repository documentation/process support | Acceptable-use process not inspected | Maintain approved acceptable-use guidance and acknowledgment integration instructions | Workforce acknowledgment and enforcement outside application code |
| A.5.11 | Asset return | Repository documentation/process support | Session revocation supports offboarding but not asset return | Add offboarding runbook linked to IT asset-return workflow | IT/HR collect devices and credentials and retain confirmation |
| A.5.13 | Classification labels | Repo-led engineering | Container PII/PHI classes exist | Carry classification labels through admin screens, exports and file metadata with propagation tests | Data owner chooses labels and handling rules; labels do not grant access |
| A.5.21 | ICT supply-chain security | Repo-led engineering | Lockfile and hash-pinned plugin asset approvals exist | Generate SBOM, verify release provenance, review dependency/plugin changes and pin approved artifacts | Supplier assurance and artifact trust decisions; SRI alone is not supply-chain assurance |
| A.5.22 | Supplier service oversight | Repository documentation/process support | Supplier review evidence not inspected | Maintain service-review checklist, change triggers and evidence references | Supplier owner evaluates service/contract changes and follows up |
| A.5.25 | Security-event assessment | Hybrid: repo + external enforcement | Audit review signals exist | Integrate severity, assignment and decision records with an existing incident system | On-call staff assess events; define severity criteria and exercise triage |
| A.5.26 | Incident response | Hybrid: repo + external enforcement | Session revocation and plugin approvals support containment | Add audited containment runbooks/tools for sessions, integrations and affected routes | Authorized incident lead decides action and validates recovery |
| A.5.27 | Lessons from incidents | Repository documentation/process support | Earlier security assessments document findings | Provide post-incident review and corrective-action templates | Conduct reviews, assign actions and verify effectiveness |
| A.5.29 | Security during disruption | Hybrid: repo + external enforcement | Security boundaries and failure handling exist | Test safe degraded/read-only modes that preserve authorization and logging guarantees | Business continuity owner approves emergency operation; no fail-open recovery |
| A.5.31 | Legal and contractual obligations | Repository documentation/process support | Compliance matrices exist | Maintain obligations register with applicability and owner references | Legal/privacy validate jurisdiction, contracts and changes |
| A.5.32 | Intellectual-property protection | Repo-led engineering | Dependency manifest/lockfile exists | Generate license inventory, notices and CI license-policy checks | Legal determines permitted use; editorial content rights need separate ownership evidence |
| A.5.35 | Independent security review | Repository documentation/process support | Internal code assessment exists | Prepare restricted independent-review evidence pack and remediation register | Qualified independent reviewer performs review; self-tests do not establish independence |
| A.5.36 | Policy and standards compliance | Repo-led engineering | Boundary/profile/generated checks exist | Add machine-checkable policy/configuration gates and exception-expiry checks | Periodic human compliance review and approved exceptions remain necessary |
| A.5.37 | Operational procedures | Repository documentation/process support | Build/install tools and security documentation exist | Version tested deployment, recovery, rotation and incident runbooks | Operators execute them and record actual outcomes |

### People — 8

| Control | Area | Delivery | Existing evidence / limit | Useful repository work | External evidence / completion condition |
|---|---|---|---|---|---|
| A.6.1 | Personnel screening | External control; no meaningful CMS enforcement | Workforce checks not inspected | No CMS enforcement appropriate; link to HR evidence only | HR performs lawful role-appropriate screening |
| A.6.2 | Employment security terms | Repository documentation/process support | Employment terms not inspected | Reference controlled security obligations in onboarding guidance | HR/legal approve and execute terms; do not store personnel contracts in the repo |
| A.6.3 | Security awareness and training | Repository documentation/process support | Developer documentation exists | Create role-specific secure-development/operator training material | Deliver training, verify understanding and retain attendance/completion evidence |
| A.6.4 | Disciplinary measures | External control; no meaningful CMS enforcement | Disciplinary process not inspected | No CMS implementation appropriate | HR/management own fair disciplinary process and confidential records |
| A.6.5 | Duties after role change or departure | Repository documentation/process support | Live session revocation exists | Document departure/role-change actions and continuing duties | HR/legal communicate obligations; operators complete and evidence offboarding |
| A.6.6 | Confidentiality agreements | Repository documentation/process support | Confidentiality agreements not inspected | Reference NDA requirements and restricted agreement register | Legal executes and reviews agreements; code cannot create enforceability |
| A.6.7 | Remote-work security | Hybrid: repo + external enforcement | Browser authentication/security headers exist | Integrate approved identity/device access gateway; test alternate-origin bypass | Remote-work policy, endpoint management and secure working environment |
| A.6.8 | Reporting security events | Hybrid: repo + external enforcement | Audit signals cover machine events, not workforce reporting | Add safe reporting link/integration, acknowledgment and routing | People know how to report; responder ownership and exercise evidence |

### Physical — 14

| Control | Area | Delivery | Existing evidence / limit | Useful repository work | External evidence / completion condition |
|---|---|---|---|---|---|
| A.7.1 | Physical security boundaries | External control; no meaningful CMS enforcement | Physical facilities not inspected | No CMS physical perimeter implementation | Provider and customer facility boundaries and assurance |
| A.7.2 | Physical entry controls | External control; no meaningful CMS enforcement | Physical access not inspected | No CMS building-entry implementation | Visitor/access controls, revocation and records |
| A.7.3 | Office and facility protection | External control; no meaningful CMS enforcement | Office protection not inspected | No CMS facility protection implementation | Office/server-room safeguards and assurance |
| A.7.4 | Physical security surveillance | External control; no meaningful CMS enforcement | Physical surveillance not inspected | No CMS CCTV/alarm implementation | Physical monitoring, authorized access and appropriate retention |
| A.7.5 | Environmental threat protection | External control; no meaningful CMS enforcement | Environmental protections not inspected | No CMS fire/flood protection implementation | Provider/customer environmental protections and exercises |
| A.7.6 | Working in restricted areas | External control; no meaningful CMS enforcement | Restricted-area practices not inspected | No CMS secure-area operating implementation | Facility rules, supervision and evidence |
| A.7.7 | Clear desks and screens | Hybrid: repo + external enforcement | Client-side table masking exists | Default concealment and idle screen lock can reduce incidental viewing | Clear-desk/workstation policy; masking cannot secure an unattended device or paper |
| A.7.8 | Equipment location and protection | External control; no meaningful CMS enforcement | Equipment siting not inspected | No CMS equipment-placement implementation | IT/facility safeguards and asset reviews |
| A.7.9 | Off-site asset protection | External control; no meaningful CMS enforcement | Off-site equipment controls not inspected | No CMS device custody implementation | Device inventory, encryption, transport and loss procedures |
| A.7.10 | Storage media handling | External control; no meaningful CMS enforcement | Media lifecycle not inspected | Export/delete tools support data handling but not physical media custody | IT/provider own storage-media inventory, transport and disposal |
| A.7.11 | Supporting utilities | External control; no meaningful CMS enforcement | Power/cooling dependencies not inspected | No CMS utility implementation | Provider/customer utility resilience and evidence |
| A.7.12 | Cabling protection | External control; no meaningful CMS enforcement | Cabling not inspected | No CMS cabling implementation | Provider/customer installation and physical protection |
| A.7.13 | Equipment maintenance | External control; no meaningful CMS enforcement | Equipment maintenance not inspected | No CMS hardware maintenance implementation | Approved maintainers, access supervision and maintenance records |
| A.7.14 | Safe equipment disposal and reuse | External control; no meaningful CMS enforcement | Hardware disposal not inspected | Logical data deletion is not physical sanitization | IT/provider verify sanitization, disposal and reuse |

### Technological — 22

| Control | Area | Delivery | Existing evidence / limit | Useful repository work | External evidence / completion condition |
|---|---|---|---|---|---|
| A.8.1 | Endpoint device security | External control; no meaningful CMS enforcement | No endpoint management evidence reviewed | CMS security headers are supporting only; use existing endpoint-management tooling | IT enforces device hardening, encryption, patching and protection |
| A.8.4 | Source-code access | Hybrid: repo + external enforcement | Git repository exists; host access rules unverified | CODEOWNERS and checks plus Git-host branch protection/access configuration | Actual membership, protected settings and access reviews must be enforced externally |
| A.8.6 | Capacity planning | Repo-led engineering | Body limits, optional IP limiters, plugin deadlines and bounded batch operations exist | Add representative load tests, capacity budgets, backpressure and resource/backlog metrics | Verify account quotas and operational scaling/alert response |
| A.8.7 | Malware defenses | Hybrid: repo + external enforcement | Upload extension/MIME/magic checks and sandbox headers exist | Quarantine uploaded files until an approved scanner reports clean; handle pending/failure paths safely | Scanner service coverage, operations and endpoint anti-malware; current checks are not antivirus |
| A.8.8 | Technical vulnerability management | Repo-led engineering | Lockfile and security tests exist; repository CI workflows not found | Add dependency/SAST/secret scanning, triage metadata, remediation gates and regression tests | Verify external scanners first; owners prioritize/remediate and manage exceptions |
| A.8.9 | Configuration control | Repo-led engineering | Versioned Wrangler configs and profile/generated checks exist | Add configuration schema, baseline/drift checks and unsafe-production-setting validation | Read-only deployed-state comparison and owner-approved changes |
| A.8.11 | Data masking | Repo-led engineering | privacy-table.js hides text but preserves original values in DOM attributes | Implement server-side role/purpose-based masking and controlled audited reveal; cover APIs/exports | Agree masking policy; visual concealment and pseudonymization are not anonymization |
| A.8.14 | Processing redundancy | Hybrid: repo + external enforcement | Cloud hosting and persistent services exist; redundancy not verified | Add dependency-failure tests, idempotent recovery and safe failover/readiness tooling | Provider/service architecture and business availability objectives; edge hosting alone proves neither redundancy nor failover |
| A.8.17 | Clock synchronization | Hybrid: repo + external enforcement | Runtime/DB timestamps and event sequences exist | Standardize UTC/time parsing, test ordering/skew tolerance and avoid user clocks for security decisions | Cloud provider supplies synchronized host clocks; Worker code cannot configure host NTP |
| A.8.18 | Privileged utility programs | Hybrid: repo + external enforcement | Migration/install/CLI tooling exists | Add explicit target selection, least-privilege recipes and audit evidence for privileged utilities | Cloud/DB/CI permissions, utility access reviews and authorized operator procedures |
| A.8.19 | Operational software installation | Hybrid: repo + external enforcement | Build/deploy scripts and plugin asset approvals exist | Deploy approved immutable build artifacts with version verification; forbid unreviewed production installs | CI/cloud deployment IAM and approvals; workflow YAML alone does not restrict console operators |
| A.8.20 | Network protection | Hybrid: repo + external enforcement | Origin checks, HTTPS URL validation and fetch deadlines exist | Harden egress/SSRF boundaries and verify gateway/network rules through tests/configuration | WAF/Access/egress service policy and network ownership outside the app |
| A.8.21 | Network service security | Hybrid: repo + external enforcement | Cloud/plugin service integrations exist | Validate secure endpoint settings and service health; retain configuration evidence | Provider service assurances, agreed security levels and service reviews |
| A.8.22 | Network separation | Hybrid: repo + external enforcement | Different logical bindings exist; actual isolation unverified | Validate separate environment resources/credentials and minimize service permissions | Account/network/gateway segmentation; separate table names are not segmentation |
| A.8.23 | Web filtering | External control; no meaningful CMS enforcement | Plugin URL restrictions protect application calls only | Do not build workforce web filtering into CMS; retain approved gateway configuration reference | IT-managed DNS/proxy/browser filtering and policy; SSRF prevention is a different control |
| A.8.26 | Application security requirements | Repo-led engineering | Security tests and regulated-data guards provide requirements examples | Create testable authentication, access, confidentiality, integrity and availability requirements; trace to tests | Product/security owners approve requirements and acceptance criteria |
| A.8.27 | Secure architecture and engineering | Repo-led engineering | Feature boundaries, neutral contracts and isolated plugin UI options exist | Document trust/data-flow architecture and enforce isolation/least-privilege rules with boundary tests | Architecture review and deployment validation; account-level controls remain external |
| A.8.28 | Secure coding | Repo-led engineering | Bound SQL parameters, CSP, origin guards, sanitization and size limits exist in reviewed paths | Codify secure patterns; add focused lint/static checks and negative tests for parsers, XSS, SSRF and auth | Reviewer competence and consistent use; sampled patterns do not prove all code secure |
| A.8.30 | Outsourced development | Hybrid: repo + external enforcement | Plugin extension architecture exists; outsourcing arrangements unknown | Use contributor review gates, restricted build credentials and approved dependency intake | Vendor contracts, personnel access and deliverable review; only applicable if outsourced development exists |
| A.8.31 | Development/test/production separation | Hybrid: repo + external enforcement | Vitest uses local runtime and test identity bindings; prod/dev config files exist | Separate environment configuration, credentials and data; make test scripts reject remote production targets | Separate deployed resources/accounts and CI environment permissions need external verification |
| A.8.33 | Test-data protection | Repo-led engineering | Test fixtures and test credentials exist | Require synthetic data factories, detect accidental secrets/PHI in fixtures and sanitize approved imports | No test with production PHI absent explicit approved safeguards; automated detection is not exhaustive |
| A.8.34 | Protection during audit testing | Hybrid: repo + external enforcement | Local tests exist; audit-test operating authorization not inspected | Add target allowlists, read-only modes, bounded probes and stop/cleanup mechanisms | Approved scope/window, access, monitoring and data handling; tools cannot authorize their own production tests |

## Recommended additions to the implementation backlog

These recommendations are now integrated as G1–G8 in the [shared implementation plan](compliance-implementation-plan-2026-10-30.md), with priorities, existing-package ownership, dependencies, acceptance tests and 32-control traceability.

| Order | Shared change | Controls benefiting | Plan integration / acceptance |
|---|---|---|---|
| 1 | Supply-chain and vulnerability gates: SBOM, advisory/secret/static checks, license inventory and approved artifacts | A.5.7, A.5.21, A.5.32, A.8.8, A.8.19 | Extend W10/W14. Verify existing external scanning first; exercise a synthetic finding through triage, fix/exception and protected release. Do not submit private manifests to external scanners without the applicable authorization. |
| 2 | Production/environment configuration checks and Git/CI enforcement | A.5.36, A.8.4, A.8.9, A.8.18, A.8.22, A.8.31 | Extend W9/W14. A test deploy cannot target production; unauthorized Git/cloud users cannot bypass protected release or environment gates. |
| 3 | Server-side masking and classification labels | A.5.13, A.8.11; supportive A.7.7 | Extend W1/W12. Unauthorized roles never receive original values in HTML, DOM attributes, JSON or exports; approved reveal is separately authorized/audited. Current visual masking remains a convenience only. |
| 4 | Separation of duties for high-risk changes | A.5.3 | Extend W9/W3/W4. Where the risk policy requires it, proposer cannot approve their own publication-policy/plugin-trust change; test direct API and queued-job bypass. Avoid blanket two-person approval for all editing. |
| 5 | Requirements, trust-boundary tests, secure coding and synthetic test-data gates | A.5.8, A.8.26–A.8.28, A.8.33, A.8.34 | Extend W7/W14. Trace requirements to negative tests; use synthetic sensitive data; constrain security probes to approved environments. |
| 6 | Capacity, degraded operation and time/failover testing | A.5.29, A.8.6, A.8.14, A.8.17 | Extend W11. Demonstrate bounded workloads and recovery against approved targets while retaining access controls; verify provider-dependent behavior. |
| 7 | Event reporting, triage and containment integration | A.5.25–A.5.27, A.6.8 | Extend W13 using the existing review screen and an existing incident system where available. Exercise report-to-owner, severity decision, containment, recovery and lessons learned. |
| 8 | Upload quarantine and malware-scanner integration, where risk requires it | A.8.7 | Extend media hardening only after approved scanner/service selection. Pending, failed and rejected scans must not release files; test bypass through every delivery path. Bound scan size/time and evaluate supplier/PHI eligibility. |

These are additions to assess and prioritize, not authorization to replace the existing P0 disclosure/audit work. Scope current implementations first. Do not add all 32 as separate projects or add their count to the previous “implemented” total: many are shared outcomes of the same change, and hybrid controls still require external proof. The previous 27-control person-day estimate does not include this expanded scope.

## Important boundary decisions

- **Masking:** `src/core/views/assets/privacy-table.js` stores original HTML/text in `data-private-original-*` attributes. It can reduce shoulder-surfing but cannot prevent the browser user from recovering those values. Real data minimization must happen before the server sends the response.
- **Malware:** extension, MIME and magic-byte checks in `src/features/media/security.ts` are useful input controls, not malware detection. A scanner needs quarantine semantics and independent service approval.
- **Repository access:** a CODEOWNERS file or CI YAML provides no enforced protection until the hosting/CI settings require it and operator bypasses are controlled.
- **Time:** Workers timers advance after I/O; use server timestamps and event sequencing without assuming each synchronous action has a distinct timestamp. Host clock synchronization is provider-managed, not an NTP feature to add to CMS. [Cloudflare timer behavior](https://developers.cloudflare.com/workers/runtime-apis/performance/).
- **Network/web controls:** CMS origin/SSRF checks protect application requests. They do not replace corporate web filtering, physical networks or account-level isolation. [Cloudflare runtime security model](https://developers.cloudflare.com/workers/reference/security-model/) describes runtime isolation, not proof of this deployment's entire network policy.
- **Documentation:** store runbooks, policy versions and restricted evidence references in the repo. Keep personnel files, incident PHI, secrets and signed confidential agreements in approved restricted systems. A document or empty template is not evidence that a process operates.
- **Provider responsibility:** provider assurance and customer endpoint/facility controls remain in scope where applicable. No physical or workforce control is excluded solely because this is a serverless CMS.

## Validation

All 66 prior placeholder IDs were evaluated exactly once; 22 organizational + 8 people + 14 physical + 22 technological = 66. The original 27 assessed row bodies remain unchanged. Repository changes are documentation only; no controls are newly marked implemented and no production action was performed.
