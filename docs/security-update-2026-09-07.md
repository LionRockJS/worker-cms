# Security update — 7 September 2026

This update implements the confirmed access-control fixes from the [assessment](/Users/colin/Documents/code/workers/cms/docs/security-assessment-2026-09-06.md), adds protections around plugin UI and resource use, and retains the historical assessment unchanged. It is a local source update; production has not been deployed or inspected.

## Implemented

| Area | Behavior after this update |
|---|---|
| Media confidentiality | Both public routes require a `media_files` registration and a present R2 object. Plugin API writes carry a private marker, which overrides even a matching public registration. Authorization runs before thumbnail cache lookup; thumbnail cache keys use a new policy version. |
| Plugin page access | Every blueprint type needs a concrete host write approval. Invalid/wildcard/prototype-sensitive blueprint names are rejected. Remote declarations cannot redefine built-in blueprints. Custom editors/read views require both approved scopes and trusted UI; auto-publication and projection contributions are limited to approved blueprint types. Explicit delegated wildcard approval remains supported. |
| Plugin revocation | Enabled state, pairwise credentials, identity pins, and approvals are read from host storage rather than a cross-request authorization cache. Missing identity schema cannot silently grant identity. |
| Sessions | Access tokens reference a stable `sessions.id`, checked with the current user on every request. Demotion changes effective permissions immediately; deletion and logout invalidate old tokens. Refresh rotation keeps the session ID stable, including its concurrency grace path. Refresh sessions have a 30-day absolute lifetime and seven-day rolling expiry. |
| Roles | Permission maps are cached only within a single HTTP request. Changes no longer leave other isolates with an old permission map for a minute. |
| WebSockets | Exact Origin is required. Sessions are checked on upgrade, before incoming messages, and before broadcast delivery. Idle sockets are checked every 60 seconds. The channel limits connections, message rates, message size, field count, and stored text/field data. |
| Plugin UI | New/existing plugins default to sandboxed UI unless the host administrator enables **Approve trusted plugin UI**. That setting is stored in host-owned registry config. Changing the base URL clears it. Sandbox CSP also applies to direct frame URLs; native CMS snippet fallback excludes untrusted plugins. Upstream plugin document CSP cannot replace host policy and Set-Cookie is stripped from document/view responses. |
| Resource handling | Actual request bytes are counted before parsers can consume an unlimited stream. Default body limit is 5 MiB; uploads 32 MiB total and ten files; plugin files 16 MiB; state requests 72 KiB; auth requests 64 KiB; enrollment claims 4 KiB. Plugin asset hashing is bounded at 8 MiB. Plugin network fetches have a 15-second deadline. |
| Publication projection | An explicit empty keep list retains only explicitly supported structural metadata. Arbitrary underscore-prefixed fields no longer bypass the keep list. Existing top-level keep/drop semantics otherwise remain. |

The new [regression suite](/Users/colin/Documents/code/workers/cms/test/security-hardening.test.ts) covers the original six reproductions plus successful approvals, revocation, private cache handling, logout replay, sandboxing, and stream limits. Existing route fixtures now create real sessions and explicitly approve simulated plugins. Those fixture helpers are test-only; the security suite uses the production paths directly without automatic grants.

## Rollout requirements

1. **Inventory public versus private objects before deployment.** Uploads created through the CMS already have `media_files` rows and remain public by design. Bucket objects written outside that upload flow now return 404 unless explicitly registered as public. Do not bulk-register plugin files to restore old URLs. Private plugin files remain available through authenticated `/__cms/files` reads. This patch enforces logical separation in the existing bucket; it does not provision a separate private bucket or migrate objects.
2. **Invalidate previously exposed public media caches.** The new Worker checks prevent fresh unauthorized reads, but cannot recall bytes already downloaded or cached for a year. Identify affected private keys, purge CDN entries where applicable, and move sensitive files to new private keys when old URLs may persist. Inventory externally exposed R2 domains as well; this code cannot protect a bucket made public outside the Worker.
3. **Approve installed plugins deliberately.** In Plugins → Page types, approve each declared concrete type that the plugin must manage. Existing delegated grants remain in place, but previously implicit blueprint ownership does not. Review conflicts when two plugins request the same type; this patch grants scopes, not a unique ownership registry. The host Page types screen lists requested types even before approval.
4. **Review UI trust separately.** A trusted plugin may run code with the current CMS user's authority. Enable the new checkbox only for reviewed plugins that require native CMS editors or trusted UI. Sandboxed plugins cannot perform ordinary form mutations without a suitable capability bridge; this patch does not supply a new bridge. Untrusted plugin UI should be verified in a staging browser before use.
5. **Check size/deadline compatibility.** Large imports and plugin files exceeding the new ceilings must be split or redesigned. Long synchronous plugin requests must use the existing jobs/batch workflow. These limits are deliberate changes, not silent fallbacks.
6. **Verify sessions.** Old access tokens without a session ID are rejected; a valid existing refresh cookie can obtain a new session-bound access token. Users without a valid refresh cookie must sign in again. Existing open editor sockets may need reconnecting. No database migration is introduced by this patch; it uses the existing session and approval tables. Confirm prior security migrations are present.
7. **Stage and smoke-test before deployment.** Check login/refresh/logout, role changes, two-editor live sync, public media, private file access, each installed plugin, and one publish/unpublish flow. Keep a reviewed rollback bundle, but avoid restoring an insecure public-file or plugin-scope policy as a routine rollback. Revoke affected sessions if incident evidence warrants it.

## Remaining hardening work

This update is not a claim that the entire assessment or production sign-off is complete.

- **Publication policy persistence:** projection rules still depend on runtime plugin contributions. A missing rule still copies the complete lect. Sensitive types need host-owned, persisted policies with fail-closed behavior when a plugin/policy is absent, nested-field validation, and testing across every publish target.
- **Plugin architecture:** trusted UI still runs on the CMS origin. A dedicated plugin origin and a narrowly scoped capability bridge remain future work. Schema ownership conflicts and hook/publish-target data grants need a fuller host-owned capability model.
- **Audit reliability:** the existing mutation audit trail remains best-effort. Durable authentication/authorization event coverage, transactional outbox delivery, tamper-resistant storage, and alerting remain outstanding.
- **Production operations:** cache purge/object inventory, deployment, actual IdP/Access MFA policy, account IAM, secret rotation policy, dependency advisories, CI controls, independent browser penetration testing, and restoration exercises are not performed by this local patch.
- **Dependency advisory check:** the earlier npm query was blocked by automatic approval review because it would disclose dependency metadata externally. This update does not silently retry that disclosure or claim dependencies are vulnerability-free.

Retain the assessment's remaining acceptance criteria as follow-up work. In particular, do not approve sensitive production workloads solely because the automated suite passes.

## Validation

- Build, TypeScript checking, feature profiles, dependency boundaries, generated-file checks, and `git diff --check` passed.
- Full suite: **848 tests passed across 44 files**, including **15 new security regression tests**, using `npm exec --no -- vitest run --maxWorkers=2` (exit 0).
- No production deployment, cache purge, credential rotation, or external dependency disclosure was performed.
- The full local workerd run emitted internal-error diagnostics despite exit 0 and all assertions passing. A focused serial run of security and WebSocket tests passed all 26 tests without those diagnostics; their origin in the broader run remains undiagnosed. Retain staging smoke tests as a release gate.
