# W9 — identity, access and cryptography assurance

Record for W9 in [the compliance plan](compliance-implementation-plan-2026-10-30.md): review the access matrix, joiner/mover/leaver process, privileged accounts, service identities and key/secret lifecycle; verify IdP MFA, alternate-origin restrictions, TLS/storage encryption and key access; add tooling only where the assessment finds a gap. Started 3 November 2026 at `cb77dcd`. **This is the source assessment and its tests. The access matrix, rotation runbooks and IdP evidence still need approval from their owners.**

Controls: A.5.15, A.5.16, A.5.17, A.5.18, A.8.2, A.8.3, A.8.5, A.8.24, plus parts of A.5.3, A.8.4, A.8.18–A.8.22.

## Access model as implemented

Authorization is capability-based. A route requires a permission, never just a role. `admin` is granted every permission in code ([guards.ts](../src/core/auth/guards.ts), `requirePermission`), including permissions plugins declare. Built-in defaults come from [roles.ts](../src/core/auth/roles.ts). An administrator can override any non-admin built-in role and create custom roles (`roles`, `role_permissions`).

| Permission | admin | editor | moderator | viewer |
|---|:-:|:-:|:-:|:-:|
| `content:read` | ✓ | ✓ | ✓ | |
| `content:write` | ✓ | ✓ | | |
| `content:publish` | ✓ | ✓ | ✓ | |
| `content:delete` | ✓ | ✓ | ✓ | |
| `content:import` | ✓ | ✓ | | |
| `trash:restore` | ✓ | ✓ | ✓ | |
| `trash:purge` | ✓ | | | |
| `tag:write` | ✓ | ✓ | | |
| `taxonomy:write` | ✓ | ✓ | | |
| `media:upload` | ✓ | ✓ | | |
| `media:regulated` | ✓ | | | |
| `plugin:access`, `plugin:manage` | ✓ | | | |
| `menu:manage`, `pagetype:write`, `blocktype:write` | ✓ | | | |
| `users:manage`, `roles:manage` | ✓ | | | |
| `credits:share`, `audit:read`, `pii:reveal` | ✓ | | | |

A viewer, or any role without permissions, reaches only the landing page and their own profile (`isViewerSafeAdminRoute`). **This table is the code default, not an approved matrix.** A deployment's effective matrix includes its overrides and custom roles; approving it is the access owner's step.

## Joiner, mover, leaver

| Stage | Behaviour | Evidence |
|---|---|---|
| **Joiner** | Every OAuth sign-up creates a `viewer`, whatever the provider claims. `ALLOWED_EMAIL_DOMAINS` restricts who can sign up; unset means anyone with a supported provider account becomes a viewer. Account, identity and audit event commit together | [registration.ts](../src/core/auth/registration.ts); `test/registration-mutation-audit.test.ts` |
| **Mover** | Role changes need `users:manage`. A manager can only assign or edit roles whose permissions are a subset of their own, and never `admin` unless they are an administrator. The last administrator cannot be demoted. The change applies on the next request, because authorization reads the current account rather than the token's role claim | [users.ts:56](../src/features/users-roles/routes/users.ts:56); `test/access-authorization.test.ts`; **new:** `test/identity-assurance.test.ts` (existing access token loses `users:manage` immediately) |
| **Leaver** | Account deletion removes the user, their sessions and their provider identities in one audited transaction. Self-deletion and removing the last administrator are refused. Every outstanding access and refresh token stops working | `test/access-authorization.test.ts`, `test/session-lifecycle-evidence.test.ts`; **new:** `test/identity-assurance.test.ts` |
| **Inactivity** | Sessions end after `SESSION_IDLE_TTL` without user activity, with a 30-day absolute cap and at most 5 sessions per user | [W6 record](w6-session-inactivity.md) |

## Privileged access

- **`admin` is implicitly all-powerful** and cannot be edited as a role. It has no step-up or second factor in the CMS (A.8.5 finding below).
- **The first administrator is created by direct SQL** (README step 7: `wrangler d1 execute … UPDATE users SET role = 'admin'`). That bypasses the audited role-change path, so no event records who granted it or when.
- **Escalation through delegated user management is blocked**, as is removing the last administrator. Both are refused with recorded denials.
- **Direct database access** (`wrangler d1 execute`, the Cloudflare dashboard) bypasses every application control. Who holds Cloudflare account access is the privileged-access question that matters most, and it is outside the repository (A.8.2, A.8.18).

## Service identities

| Identity | How it authenticates | Rotation |
|---|---|---|
| Plugin Workers | A per-plugin shared secret in `DB.plugins` (`x-plugin-secret`), or `PLUGIN_SECRET` as a deployment-wide fallback. The regulated profile requires pinned plugin identities | Per plugin: `POST /admin/plugins-manage/:id/rotate-secret`, audited and tested (`test/plugin-registration-evidence.test.ts`). The fallback has no procedure |
| CMS acting for a user toward a plugin | Forwards the signed-in user's summary (`x-cms-user`) alongside the plugin secret. The header itself is not separately signed; trust rests on the plugin secret | Follows the plugin secret |
| Audit monitor | Service binding (`AUDIT_MONITOR`), no shared secret | Platform-managed |
| Cron and queue work | Runs as the Worker. Instrumented paths record a `system:*` actor (publish, withdrawal, background reads). Mapping each one to an accountable owner is open under W4b R3 | n/a |

## Cryptography in use

| Use | Mechanism | Where |
|---|---|---|
| Access, refresh and OAuth-state tokens | HS256 JWT with `JWT_SECRET`. Verification requires `alg: HS256`, `typ: JWT`, issuer, audience, expiry and a known `type` | [jwt.ts](../src/core/auth/jwt.ts) |
| Refresh-token storage | SHA-256 of a random token ID, never the token itself; rotated on every refresh with a 30-second grace | [sessions.ts](../src/core/auth/sessions.ts) |
| Single-use admin form tokens | HMAC with `JWT_SECRET` over a random nonce | [form-once.ts](../src/core/auth/form-once.ts) |
| OAuth | Authorization code with PKCE (S256) and a signed state cookie | [pkce.ts](../src/core/auth/pkce.ts) |
| Cookies | `HttpOnly`, `SameSite=Lax`, `Secure` with the `__Host-` prefix on HTTPS | [cookies.ts](../src/core/auth/cookies.ts) |
| Secret strength | `JWT_SECRET` under 32 characters stops the Worker serving | [index.ts:44](../src/index.ts:44) |
| Audit archive integrity | SHA-256 segment hashes and a rolling chain | [W5 record](w5-archive-protection.md) |
| Transport and storage encryption | Cloudflare TLS at the edge; D1, R2 and KV encryption at rest | Provider; not verifiable from source |

One key, `JWT_SECRET`, serves four purposes. The `type`, `aud` and token-format checks keep them from standing in for each other; the new tests confirm a refresh token is refused as an access token. A compromise of that one secret affects all four, which the rotation procedure below handles.

## Rotation procedures

None of these are automated. Each needs an owner and a record of when it was last done.

| Secret | Procedure | Effect |
|---|---|---|
| `JWT_SECRET` | `openssl rand -base64 48`, then `wrangler secret put JWT_SECRET` | Every access, refresh and OAuth-state token and every open admin form stops working at once; everyone signs in again. Old session rows are purged as idle. **Tested** in `test/identity-assurance.test.ts`. There is no overlap period by design: a rotation after suspected compromise should end every session |
| Per-plugin secret | Admin → Plugins → rotate secret, then update the plugin Worker | Audited. The plugin is unreachable until both sides match |
| `PLUGIN_SECRET` fallback | `wrangler secret put PLUGIN_SECRET`, then update every plugin relying on it | All fallback plugins at once; prefer per-plugin secrets |
| OAuth client secrets | Rotate at the provider, then `wrangler secret put <PROVIDER>_CLIENT_SECRET` | Sign-in through that provider fails between the two steps |
| `APPLE_CLIENT_SECRET` | `npm run apple:client-secret`, then `wrangler secret put` | Apple caps it at six months, so this is mandatory |
| Apple signing key (`.p8`) | Revoke and reissue in the Apple developer account, then regenerate the client secret | Where the file lives needs an owner (W8 finding 5) |

## Findings

| # | Finding | Controls | Recommendation |
|---|---|---|---|
| 1 | **No second factor anywhere the CMS can see.** The CMS delegates sign-in to the provider. The in-house Eventuai provider (`oauth/`) uses password plus reCAPTCHA, with no MFA in its source. Google, GitHub, Microsoft and Apple enforce MFA only if the account or tenant requires it | A.8.5 | Decide the policy: require MFA at each enabled provider (and evidence it), add MFA to the Eventuai provider, or restrict `ENABLED_PROVIDERS` to ones whose MFA you control |
| 2 | **No access-review data.** Nothing records a user's last sign-in. Sign-ins exist only as `auth.login` audit events, kept hot for 90 days and then archived. A periodic review can list users and roles, but cannot easily spot dormant accounts | A.5.18 | Engineering follow-up: a read-only access-review export (users, roles, provider, created, last sign-in, active sessions). Needs a decision on whether to store last sign-in on the account |
| 3 | **First-admin grant is unaudited.** It is made by direct SQL | A.8.2, A.5.18 | Record each such grant in the change record. Or add a one-time bootstrap path that writes an audit event |
| 4 | **Open registration by default.** Without `ALLOWED_EMAIL_DOMAINS`, anyone with a supported provider account gets a viewer account. Viewers see little, but every account is an identity to review | A.5.16 | Set the allowlist for every deployment, or record why open registration is intended |
| 5 | **`PLUGIN_SECRET` is a shared fallback.** One secret can authenticate several plugins | A.5.17 | Give every plugin its own secret and leave the fallback unset |
| 6 | **Alternate origins are opt-in.** `CANONICAL_ORIGIN` is enforced only when set; the regulated profile requires it. A `workers.dev` route stays reachable unless it is disabled | A.8.20, A.8.3 | Set `CANONICAL_ORIGIN` everywhere, and verify `workers_dev = false` or an equivalent block in each deployment |

## What W9 still needs from people

1. **The access owner approves** each deployment's effective role matrix (defaults plus overrides and custom roles).
2. **The identity owner evidences MFA** at every enabled provider, or records the decision on finding 1.
3. **Exercise the lifecycle in a deployment:** provision a test account, change its role, remove it, and keep the audit events.
4. **Run one access review:** list accounts and roles, remove what is inappropriate, keep the record.
5. **Rotate `JWT_SECRET` once in staging** following the procedure above, and record it.
6. **Platform owners list** who holds Cloudflare and GitHub admin access, and confirm the platform's TLS and at-rest encryption for the services in use.
