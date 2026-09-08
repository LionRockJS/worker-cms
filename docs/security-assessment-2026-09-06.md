# Worker CMS security assessment and hardening plan

Assessment date: 6 September 2026. Source revision: `323b1e5eeaf81758d5ec70995948b338b957f9f3`.

**Decision: do not sign off the current implementation as secure for sensitive production data.** The code has substantial security controls, but six local probes demonstrated four access-control weaknesses. Address the High findings before accepting sensitive workloads or treating plugins as isolated components.

This is a CISSP-style, risk-based code assessment, not a certification or a production penetration test. Severity is qualitative, based on prerequisites and confidentiality, integrity, and availability impact; it is not a calculated CVSS score. Existing production exploitation was not investigated or established.

## Scope and evidence

Reviewed the current feature-sliced Worker in this repository: entry middleware, OAuth login/linking, JWT/cookies/sessions, roles and user management, representative admin/API routes, plugin authentication/identity/transport/UI/file storage, media delivery, WebSocket live editing, publication projection, audit logging, and deployment configuration. Followed sensitive call paths and inspected existing security tests. This was a targeted security review, not a line-by-line verification of every source file or optional feature.

All features in `cms.features.json` are enabled. Trust boundaries are browser → CMS; CMS → identity providers; CMS ↔ independently deployed plugin Workers; CMS → draft D1/published D1/R2; and CMS → Durable Objects and background jobs. Principal assets include admin sessions, content and submission PII, role assignments, plugin credentials, publication integrity, audit evidence, and service availability.

Validation results:

| Check | Result |
|---|---|
| `npm run type-check` | Passed |
| `npm exec --no -- vitest run` | 833 tests passed across 43 files |
| Feature profiles, dependency boundaries, generated-file checks | Passed |
| Six synthetic assessment probes, run separately | All six demonstrated the suspected unsafe behavior |
| Dependency advisory query | Not completed: initial network/DNS failure; escalated npm audit rejected by automatic approval review because it would disclose dependency metadata to npm |
| Latest published Workers type retrieval | Network/DNS failure; installed types used by the successful type check |
| Production configuration, account IAM, WAF/Access policies, logs, data exposure, backup restoration | Not inspected |

The existing suite passing does not negate the findings: the added probes exercise cross-boundary cases absent from that suite. No production traffic or production data was used for these reproductions. No application source or deployment configuration was changed.

The [probe source](/Users/colin/Documents/code/workers/cms/docs/security-assessment-probes.ts) is retained as assessment evidence, outside normal test discovery. Its assertions describe vulnerabilities, not acceptable future behavior. To reproduce locally, copy it to `test/security-assessment-local.test.ts`, run `npm exec --no -- vitest run test/security-assessment-local.test.ts`, then remove that temporary copy. Convert its assertions to rejection expectations when implementing fixes.

## Findings

### R1 — High: authenticated plugin files are anonymously downloadable

**Demonstrated.** `/__cms/files` authenticates a plugin and requires approved prefixes, but stores the bytes in `MEDIA_BUCKET`. Both `/media/*` and `/media-preview/*` read arbitrary keys from that same bucket without checking visibility, registration as public media, or authorization. Non-image preview requests fall back to returning the entire original file. Responses permit public caching for one year.

Evidence: [plugin file storage](/Users/colin/Documents/code/workers/cms/src/features/plugins/api/files.ts:177), [public media routes](/Users/colin/Documents/code/workers/cms/src/features/media/routes/public.ts:12), [response caching](/Users/colin/Documents/code/workers/cms/src/features/media/security.ts:108).

The probe wrote a synthetic private marker through the authenticated file API. An unauthenticated API read was denied, while both media URLs returned the marker with HTTP 200. An attacker must know or obtain the key; directory listing was not demonstrated. Download disposition and sandbox CSP do not protect confidentiality. Ordinary uploads are also public regardless of a referencing page's draft status.

**Fix:** separate public media from private plugin/document storage, preferably with distinct R2 bindings. Introduce explicit object visibility and authorize both original and thumbnail reads before cache lookup. Use authenticated downloads or short-lived scoped links for private files. Inventory existing objects before migration; invalidate affected caches and assess exposure if sensitive files exist. Blocking only `/media/` is insufficient.

**Acceptance:** private objects return 401/403/404 through both routes, including warmed preview caches; approved public images continue to work; revocation removes access; unpublished/private attachment tests cover originals and thumbnails.

### R2 — High: plugins can grant themselves additional page access

**Demonstrated.** The host derives write scope directly from `Object.keys(manifest.contentTypes.blueprint)` and also grants those types read scope. Manifest validation checks only that `blueprint` is an object. It does not bind page-type ownership to a host-approved owner or reject a `*` blueprint key. The page-scope helper interprets `*` as access to every concrete type.

Evidence: [scope construction](/Users/colin/Documents/code/workers/cms/src/features/plugins/api/auth.ts:38), [manifest validation](/Users/colin/Documents/code/workers/cms/src/features/plugins/registry.ts:199), [wildcard semantics](/Users/colin/Documents/code/workers/cms/src/features/plugins/page-types.ts:21).

The probes first received 403 for an unrelated `default` page. Changing the same registered plugin's manifest to add `default`, or to add `*`, changed that result to 200 without delegated approval. The read bypass was executed; write/delete/publish exposure follows from the shared `allowedTypes` checks in those routes and was not destructively exercised. This requires control of an enabled plugin's served manifest and its credential, such as compromise of that plugin Worker. Possession of a credential alone, without manifest control, is a narrower threat.

**Fix:** persist host-approved ownership for concrete page types, with uniqueness/conflict checks against built-in and other plugin types. Reject wildcard/invalid blueprint keys. Treat manifest changes as requests, requiring approval for capability expansion. Derive effective scopes from host records; enforce the same rules for custom editors, hooks, auto-publishing, and publication projections. Pinning only `manifest.id` does not pin capabilities.

**Acceptance:** both probe variants remain 403; a plugin cannot claim a core/other-plugin type; manifests cannot expand scopes without approval; every read/write/batch/delete/publish endpoint uses the same resolved permissions.

### R3 — High: WebSocket handshakes lack origin validation and sessions have no ongoing expiry check

**Handshake demonstrated; lifetime issue established by code inspection.** The global origin guard skips GET, and `/admin/api/sync/:pageId` accepts a cookie-authenticated WebSocket without checking `Origin`. The probe supplied a valid cookie and a sibling-site origin and received HTTP 101. A browser exploit requires the browser to send the victim's cookie; SameSite=Lax mitigates unrelated-site requests but does not establish an exact-origin boundary against a hostile HTTPS sibling site. A real browser exploit was not executed.

Evidence: [upgrade route](/Users/colin/Documents/code/workers/cms/src/routes/admin/api.ts:227), [socket attachment](/Users/colin/Documents/code/workers/cms/src/core/durable-objects/page-sync.ts:143), [message handler](/Users/colin/Documents/code/workers/cms/src/core/durable-objects/page-sync.ts:214).

The Durable Object retains user ID/name, without session ID or token expiry, and handles later messages without checking whether the user was deleted, demoted, or logged out. The channel exposes live edit overlays and allows operations to be relayed to other editors. It is not itself a direct page-save endpoint, so a durable unauthorized page save was not demonstrated.

**Fix:** require the exact configured origin before upgrading; reject missing/null/untrusted browser origins. Bind sockets to a revocable session and expiry, revalidate authorization, and close them on logout/revocation. Add connection, message, field-count, and stored-document budgets.

**Acceptance:** hostile sibling origins fail before upgrade; valid-origin editing still works; expiry/logout/demotion close existing sockets; new messages cannot revive revoked access. These controls align with [OWASP WebSocket guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

### R4 — High: demotion and deletion leave existing admin access tokens usable

**Demonstrated; already documented as a design tradeoff in README.** Access-token authentication verifies the signature and expiry but does not check the current user or session. Per-route guards therefore use the old role claim. Refresh rotation reads current user data, but only after access-token expiry.

Evidence: [access-token acceptance](/Users/colin/Documents/code/workers/cms/src/core/auth/guards.ts:55), [role update](/Users/colin/Documents/code/workers/cms/src/features/users-roles/routes/users.ts:152), [user deletion](/Users/colin/Documents/code/workers/cms/src/features/users-roles/routes/users.ts:183), [token lifetime](/Users/colin/Documents/code/workers/cms/src/core/auth/sessions.ts:4).

Two probes issued an admin token, then changed its user to viewer or deleted the user. Both still reached `/admin/users` with HTTP 200. The normal HTTP exposure lasts up to the remaining 15-minute token lifetime. During incident response that can let a compromised administrator retain dangerous authority; the WebSocket issue can extend access beyond that window.

**Fix:** include a session ID and authorization version in access tokens and validate current account/session status. Advance the version on privilege changes, revoke on deletion/logout, and provide revoke-all. Establish an explicit revocation latency target and design caches around it. Shortening JWT lifetime alone does not provide immediate revocation. Add an absolute session lifetime as well as the current rolling refresh expiry.

**Acceptance:** after demotion/deletion/logout/revoke-all, replaying old tokens fails on sensitive read and mutation routes; refresh and open sockets also fail; concurrent legitimate refreshes remain supported.

### R5 — High: plugin UI trust is chosen by the plugin, on the CMS origin

**Architecture finding; no browser takeover demonstrated.** `pluginTrustLevel()` reads the manifest and defaults to `trusted-ui`. The admin proxy uses it to decide whether to sandbox. A remote manifest can therefore change the isolation mode without a host-owned trust approval. Full-document responses also retain an upstream CSP when present. Existing HTML sanitization and approved-asset SRI checks are useful controls, but cannot turn executable same-origin plugin code into a separately trusted principal.

Evidence: [trust default](/Users/colin/Documents/code/workers/cms/src/features/plugins/types.ts:364), [sandbox choice](/Users/colin/Documents/code/workers/cms/src/features/plugins/routes/admin-proxy.ts:230), [upstream response policy](/Users/colin/Documents/code/workers/cms/src/features/plugins/proxy.ts:89). The proxy already warns about this shared-origin trust model and restricts non-admin access.

**Fix:** store maximum approved trust in the host registry; a manifest may request less privilege but cannot raise it. Default new plugins to isolated UI. Serve untrusted plugin UI from a separate origin, with a narrow authenticated capability bridge. Define an allowlist for proxied headers, especially CSP and Set-Cookie, and make host policy authoritative. Treat any retained trusted UI as admin-equivalent code in supplier reviews and change approval.

**Acceptance:** changing `sandboxed-ui` to `trusted-ui` remotely cannot escape isolation; unapproved plugin responses cannot relax host CSP or set CMS session cookies; origin-isolation tests demonstrate that plugin scripts cannot read CMS DOM or call arbitrary privileged endpoints.

### R6 — Medium: size controls often act after allocation; availability budgets are incomplete

**Code finding; resource exhaustion was not attempted.** Uploads call `formData()` before enforcing per-file size, with no aggregate file-count/byte budget. Plugin file PUT buffers the entire body before its final 50 MiB check when Content-Length is absent. Plugin state JSON is parsed before its value limit. Plugin assets are buffered before hashing. Manifest reads correctly enforce a streaming byte ceiling, but registry fetches have no application deadline and resolving one plugin loads manifests for all enabled plugins. WebSocket ordinary field operations lack the text-update path's size limits and a total state budget.

Evidence: [upload parsing](/Users/colin/Documents/code/workers/cms/src/features/media/routes/upload.ts:26), [file buffering](/Users/colin/Documents/code/workers/cms/src/features/plugins/api/files.ts:172), [state parsing](/Users/colin/Documents/code/workers/cms/src/features/plugins/api/state.ts:63), [asset buffering](/Users/colin/Documents/code/workers/cms/src/features/plugins/routes/admin-proxy.ts:126), [manifest fetch](/Users/colin/Documents/code/workers/cms/src/features/plugins/registry.ts:108).

**Fix:** enforce route-specific streamed byte limits before parsing, aggregate multipart limits, JSON depth/field limits, and bounded hashing. Add upstream deadlines/cancellation and isolate slow plugins. Apply authenticated-principal limits plus IP limits to expensive APIs, enrollment, and WebSocket traffic; verify required limiter bindings at deployment. Use current [Workers resource-handling guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) when implementing these controls.

**Acceptance:** oversize/chunked/many-file/deep JSON inputs terminate within documented budgets; slow plugin calls time out; unrelated admin functions remain available; socket floods cannot grow state without bounds.

### R7 — Medium: publication minimization is permissive and schema-dependent

**Code finding; actual sensitive production records were not inspected.** `projectLect()` copies everything when a rule is missing or its keep/drop lists are empty. A nonempty keep list still preserves every underscore-prefixed field. Thus `{keep: []}` is not a deny-all rule, and a new private `_...` field survives an ordinary allowlist. The rules originate from live plugin manifests, so plugin unavailability or configuration changes must also be considered.

Evidence: [projection behavior](/Users/colin/Documents/code/workers/cms/src/core/publish/projection.ts:52), [plugin rule contribution](/Users/colin/Documents/code/workers/cms/src/features/plugins/extensions.ts:72).

**Fix:** classify public versus operational/submission types, and persist publication policy in the host. Require an explicit allowlist for sensitive types; define empty-allowlist semantics; enumerate permitted metadata instead of preserving all `_` keys. Refuse publication when required policy is unavailable. Check nested fields and every D1/R2/plugin publish target; treat access to a published DB as access to all rows it contains, not merely to the intended public pages.

**Acceptance:** seeded private fields, including nested and underscore-prefixed fields, never reach publish targets; missing-plugin/empty-policy cases fail closed; intentional public fields remain present.

### R8 — Medium: audit evidence is incomplete and best-effort

**Code finding; external monitoring controls remain unknown.** Administrative mutations commonly log useful audit records, but `logAudit()` writes after the mutation through `waitUntil()` and logs failures without retrying. OAuth login/logout, refresh failures, and account linking/unlinking lack equivalent durable security-event records in the reviewed routes. Deployment files do not explicitly configure observability, and no tracked repository CI workflow was found; external systems may provide either.

Evidence: [audit delivery](/Users/colin/Documents/code/workers/cms/src/core/db/audit.ts:19), [authentication routes](/Users/colin/Documents/code/workers/cms/src/routes/auth.ts:519), [profile identity removal](/Users/colin/Documents/code/workers/cms/src/routes/admin/profile.ts:190).

**Fix:** define an event catalogue for identity, authorization, plugins, export/publication, and administrative changes. Record request correlation, actor and authentication principal separately, target, outcome, and policy version while excluding credentials and unnecessary PII. Use a transactional outbox for critical changes and reliable delivery to restricted, tamper-resistant storage. Alert on missing events/delivery failures, repeated denials, privilege changes, and plugin capability expansion.

**Acceptance:** representative successful and denied actions produce attributable events; simulated sink failure is retried or alerted; a reviewer can reconstruct a role-change, plugin-rotation, and sensitive-export incident.

## Controls worth retaining

- HS256 verification restricts algorithm, token type, issuer, audience, and expiration. Token IDs use Web Crypto; production rejects short/missing JWT secrets.
- OAuth uses state and PKCE; Apple ID tokens have signature/issuer/audience/nonce checks. New users receive viewer role, provider role claims do not directly grant admin, and matching email alone does not silently link accounts.
- HTTPS session cookies use HttpOnly and `__Host-`; ordinary unsafe HTTP methods have fail-closed origin checks. Remove the remaining legacy unprefixed-cookie fallback after migration.
- Refresh identifiers are hashed; rotation uses a conditional update with a bounded concurrency grace period. User/role administration has anti-escalation and last-admin guards.
- Reviewed queries bind values; dynamic search sort options are allowlisted; structured-object handling rejects prototype-sensitive keys. This is positive evidence, not proof against every injection sink.
- Plugins have pairwise credentials, pinned identities, explicit delegated scope/file-prefix approvals, redirect blocking, and SRI checks. Standard media uploads reject active formats and validate MIME/signatures.
- Feature boundary checks, generated-file checks, and substantial local tests provide a useful foundation for security regression coverage.

## Phased hardening plan

Timeboxes below are proposed priorities, not delivery commitments. Name an accountable engineering owner and security reviewer for each workstream.

| Phase | Owner | Work | Exit criteria |
|---|---|---|---|
| Immediate: 0–2 days | CMS maintainer + operations | Inventory whether private plugin files are exposed; restrict both public media paths where necessary; allow only reviewed plugins; reject wildcard blueprint declarations; add exact-origin WebSocket gate. If production evidence suggests credential exposure, revoke/rotate affected credentials and preserve incident evidence. | R1/R2/R3 containment verified with negative tests; public functionality smoke-tested; rollback prepared. |
| Sprint 1: approximately 1 week | CMS/auth maintainers | Implement host-owned page-type capabilities and plugin trust approvals; session revocation/version checks; socket expiry and revocation; private storage separation and cache migration. Add explicit security-schema readiness checks. | R1–R5 acceptance tests pass, including mutation, multi-isolate/cache, and migration cases. |
| Sprint 2: approximately 1–2 weeks | Platform + plugin maintainers | Isolate plugin UI, enforce request/upstream/socket budgets, persist sensitive publication policy, and close audit gaps. Pin hook subscriptions/data scope and review actor attribution. | R5–R8 acceptance tests pass; controlled abuse tests stay within resource budgets; sensitive projection tests cover every target. |
| Within 30 days | Security/operations + business owner | Verify production IAM/MFA, deployment pipeline, secrets lifecycle, recovery, monitoring, and data retention; commission an independent staging penetration test. | Evidence-backed operational controls and tested recovery; no unresolved High findings unless explicitly accepted by the accountable owner. |

Additional implementation constraints:

1. Security migrations must fail closed. `claimIdentity()` currently returns success when its security table is absent; replace that compatibility fallback with an explicit unavailable state for plugin operations until migrations are ready. Test upgrades as well as fresh installs.
2. Define revocation freshness. Plugin credentials/enabled rows are cached for 30 seconds and role-permission maps for 60 seconds per isolate. Clearing one isolate's cache does not invalidate other isolates. Test real cross-isolate behavior against the chosen revocation target.
3. Keep per-plugin credentials independently rotatable. Restrict DB/export/operator access because the host can read plugin secrets from registry rows. Consider application encryption with a separately managed key where the threat model includes database-only compromise. Do not confuse platform encryption at rest with application-level credential isolation.
4. Require phishing-resistant MFA for administrators through verified IdP/Access policy and use reauthentication for linking identities and critical privilege/credential changes. Verify verified-email and organization/tenant claims if registration policy relies on them. Domain strings alone are not a complete organizational identity policy.
5. Add CI security regression gates, dependency and secret scanning, lockfile review, an SBOM, protected branches, and least-privilege deployment tokens. Complete an approved advisory check before release; no claim of dependency cleanliness is made here.

## CISSP operational assurance still required

The code primarily supplies evidence for security architecture, IAM, assessment/testing, and secure software development. A defensible sign-off also needs these operational records:

| Domain | Evidence to obtain |
|---|---|
| Security and risk management | Named asset/risk owners, threat model, supplier/plugin acceptance policy, incident criteria, documented residual-risk decisions. |
| Asset security | Classification and retention for content/submissions/media/audits/backups; access inventory for each D1/R2 binding and each external plugin; deletion/export procedures. |
| Security architecture and engineering | Host-approved capabilities, isolated plugin execution origins, fail-closed schema/policy behavior, key management and rotation design. |
| Communication and network security | Deployed canonical-origin/HTTPS behavior, route exposure including workers.dev/previews, Access/WAF policy, safe machine-to-machine exceptions and egress policy. |
| Identity and access management | Administrator MFA, IdP tenant/organization controls, joiner/mover/leaver procedures, service-account permissions, revocation timing and periodic access reviews. |
| Security assessment and testing | Fix regression tests, dependency/secret scans, staged browser tests, authenticated negative tests, independent penetration testing. |
| Security operations | Alerts and response playbooks, restricted audit retention, secret-revocation drill, backup inventory, recovery exercises, agreed RPO/RTO. |
| Software development security | Protected reviews/releases, provenance and dependency controls, security migrations, rollback and plugin capability-change approval. |

Recovery must cover draft and published D1, private and public R2, Durable Object state as appropriate, configuration and plugin approvals, and secure credential re-establishment. Version history in the same application database is not an independent disaster-recovery control. Agree RPO/RTO with the business and prove them with an isolated restore exercise, including attachment consistency and revoked-credential handling.

Use [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) as the application verification checklist, targeting Level 2 coverage appropriate to this CMS and stronger controls for administration and sensitive data. The final release decision should require closed High findings, passing negative tests, a completed dependency assessment, inspected production controls, and a successful recovery/incident exercise.
