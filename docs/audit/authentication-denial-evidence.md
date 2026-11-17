# Durable host authentication-denial evidence

Local W4b continuation, 2 November 2026. The earlier OAuth/profile/session work was committed on `main` as `a3c4ad8` before this increment. This record describes host denial decisions; it does not establish deployment acceptance or complete every authorization boundary.

## Covered decisions

| Boundary | Evidence |
|---|---|
| OAuth callback failure redirects, GET and Apple form POST | `auth.login`, denied, with a host-owned reason code. Arbitrary provider errors become `provider_error`; their text is excluded from both evidence and redirect URLs. |
| Unauthenticated explicit identity-link start | `auth.start`, denied, `link_session_expired`. |
| Explicit refresh refusal | `auth.refresh`, denied, for missing/malformed/expired/revoked credentials and the service's bounded failure codes. |
| Protected-route authentication admission | One `auth.access` denial for missing or invalid credentials, before returning the existing login redirect or JSON 401. Rejected JWT claims are not authenticated actors. |
| Editor admission and shared one/any-capability guards | `permission.denied`, with the database-backed authenticated actor/session and bounded permission metadata. The registered route pattern is recorded, not request path parameters or query terms. |
| Delegated user/role object policy | Bounded reasons for stronger roles/grants, locked/built-in roles, self-deletion, last-administrator protection and management capability loss. See the [transaction-bound authorization record](access-management-authorization.md). |
| Authentication endpoint rate limiter | One denial for the corresponding start/callback/refresh action, with `rate_limited`, before returning 429. Non-authentication rate-limit callers keep their existing behavior. |

The response status/body/redirect remains the existing refusal when evidence commits to either store. Neither the protected handler nor credential-issuing code runs as a consequence of persistence failure. Failure of both evidence stores returns generic 503/no-store, preserving refusal and any prior local cookie clearing; an incomplete coarse outage incident/alert is attempted when monitoring is configured.

Permission denial can follow an independently successful, durably audited silent session rotation. Recording a later capability refusal does not undo that session transaction or claim that its existing cookies/rights were revoked. The capability-protected handler remains unreachable.

## Persistence and recovery

`recordAuthDenial()` is awaited. It creates a stable event ID/time and attempts the exact primary audit insert/verification in a D1 batch. An ignored, removed or rewritten primary event fails verification and rolls back that batch. If primary persistence fails or its acknowledgment is uncertain, the same complete envelope is persisted to the existing core outbox and verified before returning the refusal.

Denials have no business mutation or target. Their outbox insert therefore omits the previous-business-change assertion, while retaining exact envelope/receipt checks. Revocation producers keep that assertion. No new operator bypass, environment flag or schema is added.

Fallback persistence does not immediately retry a known-failing primary stream. The existing core scheduled sweeper delivers pending denials using the original ID/time, actor and request context, with bounded backoff, retained exhausted rows and backlog/outage visibility. A lost primary commit acknowledgment can produce both a primary event and a pending copy; exact idempotent delivery removes the pending copy without duplicating or replacing the event. A lost fallback acknowledgment remains unavailable to the caller even if the receipt actually committed. Reconcile retained state; do not infer that both stores were empty from the response.

The reader accepts only the explicit denial action/detail contract. Unknown reasons/fields, forged actor assertions, sensitive path values or conflicting primary IDs remain pending for review. Existing [outbox upgrade and recovery procedures](audit-mutation-outbox.md) still apply. Old code that only understands revocation receipts is not a suitable delivery worker for new denial envelopes; preserve the evidence and use a compatible reader rather than deleting pending rows.

## Privacy and attribution

Reason values come from `denial-contract.ts`, with a bounded `unknown` fallback. Permission names/sets and registered route patterns are validated and bounded; unsupported values become a fixed placeholder/coarse pattern. The recorder never copies OAuth code/state, provider error descriptions, attempted email addresses, cookie/Authorization contents, JWTs, token hashes, query strings or private path parameters into detail.

Anonymous/failed-credential attempts have no asserted user, role or session. Only an already authenticated permission refusal uses the context actor, with unsafe legacy role strings omitted and explicitly marked. No target record is invented for a refusal. Standard request metadata is retained with bounds: request ID 128 characters, source IP 64 and user agent 256. This keeps fallback envelopes within the existing storage size contract.

Authentication metadata inherits the highest effective user/session/role/grant/OAuth-identity classification. Unavailable policy retains conservatively PHI-classified evidence with a marker; regulated denial evidence is conservatively PHI-classified as well. Classification failure cannot authorize a request. Authentication event/retention classes remain in use; production retention and increased denial volume need owner review.

## Limits and operating acceptance

This covers the named host OAuth/admin guards. Named user/role object-policy checks are covered by the subsequent authorization increment. Other object checks, plugin/service authentication and contributor/edge authorization boundaries still need coverage review and instrumentation where required. Secret/origin/readiness failures and provider/DB transport errors are not falsely relabeled as authenticated credential denials by this recorder.

Primary audit and outbox share D1. A database-wide failure can prevent detailed denial capture; the 503 and independent coarse monitoring path do not prove complete forensic evidence. Production schedule/alert delivery, capacity, retention, recovery and provider/organization controls remain acceptance work. Failed requests add durable records, including expected anonymous/editor/rate-limit refusals; no sampling/drop policy is silently introduced. Existing endpoint throttling is retained, and deployed abuse/backlog budgets must be exercised.

Other regulated mutations, broader policy-version/authorization revalidation, general operation IDs and external/plugin/R2 recovery remain open W4b work. Regulated business writes and PHI publication stay contained. No deployment, production migration, push or compliance sign-off was performed here.

## Local validation

The 44 new regressions cover bounded reasons and metadata, anonymous/current actor attribution, private URL suppression, endpoint throttling, primary failures (including unavailable table/ignored/rewritten rows), complete outbox fallback, simultaneous persistence failure, uncertain commits, malformed-envelope retention and monitoring privacy. The final serial suite passed 1,597 tests across 73 files. Build, TypeScript, feature-profile, boundary, generated consistency and whitespace checks pass. These are local results; deployed operating acceptance remains open.

## Subsequent classification-version continuation

The [policy-version continuation](classification-policy-version.md) makes new denial evidence conservatively PHI-classified even when a lower valid policy was observed. This prevents an upward policy race from leaving a lower-classified refusal, while keeping denials available during policy repair. Unavailable-policy markers and existing exact primary/outbox contracts remain. Deployment retention/capacity acceptance must account for this conservative classification.
