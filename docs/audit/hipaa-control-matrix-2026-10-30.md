# 0xCMS: HIPAA control matrix

Updated 30 October 2026. Based on the source review at revision `ac27e68` and the [readiness assessment](compliance-readiness-2026-10-30.md). This separates implemented controls, confirmed gaps and evidence to verify; it is not a new production assessment or implementation change.

## How to read the statuses

| Status | Meaning |
|---|---|
| Implemented — source verified | Supporting application controls were inspected. This does not claim that the entire regulatory requirement is satisfied or that production runs this revision. |
| Partially implemented — known gap | Supporting controls exist, but a specific source/configuration gap was identified. The gap column states it. |
| Supporting feature only | A feature contributes to the objective but does not demonstrate the required process or safeguard by itself. |
| Not evidenced | Relevant organizational, supplier or deployment evidence was not reviewed. This does not mean the control is absent. |

All source-verified controls still require deployment verification. “None identified in reviewed scope” is not an assertion that no other gaps exist. Recommendations dependent on workload or risk assessment appear in the evidence column rather than being presented as proven defects. No requirement has been declared not applicable; applicability and any exclusions need documented scope and justification.

F1–F7 refer to findings in the readiness assessment. In particular, F6 contains both application observations and unverified external controls; lack of host MFA code does not establish that MFA is absent at the IdP or gateway. Likewise, record/field-level restrictions are needed only where the authorized-access model requires them.

## HIPAA requirements mapping

This preserves the previous table's scope, not every HIPAA provision. Applicability and responsibilities depend on covered-entity/business-associate role and data use. “Implemented” applies to the stated supporting mechanism, not the entire legal obligation. MFA recommendations are risk-based hardening recommendations, not an assertion that the 2025 proposal is already effective. [HHS Security Rule summary](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html), [HHS applicability](https://www.hhs.gov/hipaa/for-professionals/covered-entities/index.html).

| HIPAA reference | Requirement / area | Status and implemented controls | Confirmed gaps in reviewed scope | Evidence to verify / decision required |
|---|---|---|---|---|
| §164.308(a)(1)(ii)(A–B) | Risk analysis and management | **Supporting feature only:** technical assessments and remediation findings | Review identifies technical risks, not failure of an organizational risk program | Complete ePHI inventory, enterprise risk analysis, treatment decisions, owners and review history |
| §164.308(a)(1)(ii)(D) | Information system activity review | **Supporting feature only:** audit viewer and security-event records | F2/F4 logging gaps limit available activity evidence | Review schedule, responsible staff, investigation records, alert rules and follow-up evidence |
| §164.308(a)(2) | Assigned security responsibility | **Not evidenced** | No missing appointment established | Named security official, authority and responsibilities |
| §164.308(a)(3) | Workforce security | **Implemented — source verified:** user roles, deletion and revocable sessions support workforce controls | No workforce-process deficiency established | Authorization, clearance, supervision, termination and actual revocation timing |
| §164.308(a)(4) | Information access management | **Implemented — source verified:** capability roles and current-role validation | Broad roles do not establish a defect without the required access model | Approved job-duty/access matrix, approvals, reviews, required record restrictions and applicable clearinghouse separation |
| §164.308(a)(5) | Security awareness and training | **Not evidenced:** logs are supporting operational data, not training evidence | No training absence established | Training, reminders, malware protections, login monitoring and password/credential procedures |
| §164.308(a)(6) | Security incident procedures | **Supporting feature only:** attributable logs and archive verification | F2/F4 weaken incident evidence; response processes not assessed | Response/reporting procedures, exercises, incident records and corrective actions |
| §164.308(a)(7)(ii)(A) | Data backup plan | **Supporting feature only:** page history | Same-database history alone does not demonstrate backup; external arrangements unknown | Complete recoverable ePHI copies, attachments, backup jobs, access restrictions and restoration evidence |
| §164.308(a)(7)(ii)(B–C) | Disaster recovery and emergency-mode operation | **Not evidenced:** cloud storage alone does not prove these plans | No external recovery-plan deficiency established | Recovery plan, secure emergency operation, RPO/RTO, dependency coverage and successful drills |
| §164.308(a)(7)(ii)(D–E) | Contingency testing and criticality analysis | **Not evidenced** | No absence of exercises established | Criticality analysis, exercise results, revisions and documented addressable-specification decisions |
| §164.308(a)(8) | Evaluation | **Supporting feature only:** code review and security tests | These do not establish full technical and nontechnical evaluation | Periodic evaluations, changes that trigger reevaluation, findings and treatment evidence |
| §§164.308(b), 164.314(a) | Business-associate arrangements | **Not evidenced:** relevant cloud/plugin relationships identified | No missing BAA established; agreements were not inspected | Executed BAAs, covered services/account, subprocessors, permitted uses and incident commitments (F7) |
| §164.310(a) | Facility access controls | **Not evidenced:** hosting provider operates cloud facilities | No physical-control deficiency established | Supplier assurance plus customer facility access, contingency access and maintenance procedures |
| §164.310(b–c) | Workstation use and security | **Not evidenced:** browser administration is not workstation-control evidence | No endpoint-control deficiency established | Workstation policies, physical safeguards, screen locking, authorized use and endpoint management |
| §164.310(d) | Device and media controls | **Supporting feature only:** application deletion/storage functions | No device/media-process deficiency established | Disposal, reuse, accountability and backup/storage procedures for endpoints, downloads and media |
| §164.312(a)(1) | Access control | **Partially implemented — known gap:** permissions, scopes and private-object checks | PHI classification does not prevent delivery through registered public media routes (F3) | Actual PHI locations, private delivery, bucket domains, job-duty authorization and deployed negative tests |
| §164.312(a)(2)(i) | Unique user identification | **Implemented — source verified:** internal user IDs and session-linked audit actors | None identified in reviewed identification mechanism | Unique-person assignment, no shared accounts, account lifecycle and historical attribution after deletion |
| §164.312(a)(2)(ii) | Emergency access procedure | **Not evidenced** | Absence of a dedicated application feature does not establish absence of a valid procedure | Authorized emergency process, responsible personnel, authentication, logging and post-event review |
| §164.312(a)(2)(iii) | Automatic logoff | **Partially implemented — known gap:** access expiry and bounded refresh sessions | Reviewed application lacks inactivity-based session expiry; token expiry is not equivalent (F6) | IdP/gateway or workstation compensating controls, actual inactivity behavior and documented addressable decision |
| §164.312(a)(2)(iv) | Encryption and decryption | **Not evidenced for stored ePHI:** token cryptography is implemented but serves a different purpose | No plaintext-storage finding established | Encryption of all relevant stores/copies, keys, access and risk-based addressable decision |
| §164.312(b) | Audit controls | **Partially implemented — known gap:** auth/denial/mutation events, strict classified reads and archive code | Classification lookup fail-open, missing private-file read events, best-effort mutations and inactive archive in checked config (F2/F4/F5) | Production coverage, archive protection, actor identity, review procedures and audit-outage tests |
| §164.312(c)(1–2) | Integrity and authentication of ePHI | **Supporting feature only:** page versions; audit hashes protect audit evidence rather than all content | No specific content-integrity failure established | Mechanisms against improper alteration/destruction, access controls, validation, transfer/restore checks and addressable decisions |
| §164.312(d) | Person or entity authentication | **Implemented — source verified:** OAuth, signed tokens and live session validation | No authentication bypass established by this review | Identity-provider assurance, production configuration, risk-appropriate MFA and alternate-origin/provider bypass testing |
| §164.312(e)(1–2) | Transmission security | **Implemented — source verified:** HTTPS-oriented configuration and authenticated plugin communication | No unencrypted transport path established; unsafe disclosure destinations remain a separate F1 concern | TLS/integrity on all deployed ePHI paths, plugin endpoints, exports and addressable-specification decisions |
| §164.316(a–b) | Policies, procedures and documentation | **Supporting feature only:** technical designs and security assessments | No organizational documentation/retention failure established | Approved policies, decisions, evaluations, availability, updates and required six-year documentation retention |
| §§164.502, 164.514(d) | Permitted uses/disclosures and minimum necessary where applicable | **Partially implemented — known gap:** projection and role controls | Missing-rule publication and public classified-media risks (F1/F3) | Permitted purposes, authorizations, exceptions, approved destinations, role needs and export procedures |
| §§164.524, 164.526 | Individual access and amendment | **Supporting feature only:** editing and version history | No failure to honor individual rights established | Applicable records, request verification, handling/timelines, amendments and covered-entity/BA responsibilities |
| §164.528 | Accounting of disclosures | **Supporting feature only:** general audit events | General access logs do not establish a complete disclosure-accounting workflow | Applicable disclosures/exceptions, recipient/purpose data, request handling and allocation of responsibilities |
| §§164.400–414 | Breach notification | **Supporting feature only:** logs can support investigation | No notification-process failure established; F2/F4 limit evidence | Breach assessment procedure, reporting roles, applicable deadlines, BA escalation and notification exercises |

Addressable implementation specifications still require assessment and an appropriate implementation or documented rationale/alternative; “addressable” does not mean optional. Six-year Security Rule documentation retention is not a blanket retention mandate for every access log or medical record. [HHS summary](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html), [medical-record retention FAQ](https://www.hhs.gov/hipaa/for-professionals/faq/does-hipaa-require-covered-entities-to-keep-medical-records-for-any-period/index.html).

## Practical distinction for remediation

Implementation sequencing, shared fixes, owners and acceptance tests are in the [shared implementation plan](compliance-implementation-plan-2026-10-30.md).

- **Confirmed engineering work:** F1 publication policy, F2 classification failure behavior, F3 classified public-media behavior, F4 logging coverage/durability, and application inactivity controls where the chosen session policy requires them.
- **Confirmed repository configuration issue:** F5 has no active audit archive binding in the checked production file. Verify the deployed configuration before concluding production also lacks it.
- **Evidence collection first:** MFA/IdP enforcement, independent backups, actual storage/transport encryption, account permissions, supplier contracts, workforce controls, incident procedures and security/privacy governance. Do not label these absent or rebuild them before checking existing controls.

No application code changed for this matrix update. The prior 44-test result belongs to the initial assessment; no new runtime tests were needed for this documentation-only clarification.
