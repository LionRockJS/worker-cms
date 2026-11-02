# W6 — session inactivity

Engineering record for W6 in [the compliance plan](compliance-implementation-plan-2026-10-30.md#w6--bound-inactivity-without-breaking-revocation). It builds on the idle window added in `5db2885` (see [the ISO review §2](iso-27001-coverage-review-2026-11-01.md#a85-as-implemented)) and closes the gap that window left: an open admin tab kept its session alive indefinitely. **Nothing here was deployed or applied to a live database.** Each "verified" item is verified in source and in the test runtime only.

## The gap this closes

The idle window was measured from the last token refresh. Every admin page runs a keepalive that refreshes every 10 minutes and whenever the tab becomes visible, and the editor polls presence every 8 and 30 seconds. So an open, untouched tab refreshed forever, and only the 7-day refresh and 30-day absolute limits ended it. Access-token checks also skipped the idle window, so the tokens the keepalive kept issuing were accepted regardless.

## What counts as activity

`sessions.last_activity_at` is the last moment a person acted. Only a refresh made on their behalf moves it, and only to when they acted. `rotated_at` still records every rotation but no longer bears on idleness.

| Request | Activity? |
|---|---|
| A request with no activity header: navigation, form submission, editor and admin API calls | Yes, now |
| Keepalive tick after a pointer press, key press, wheel or touch since its last report | Yes, at the time of the last interaction (`X-CMS-Idle-For: <seconds>`) |
| Keepalive tick with no interaction since its last report | No (`X-CMS-Background: 1`) |
| Tab becoming visible | No, unless followed by an interaction |
| Editor presence heartbeat and poll | No (`X-CMS-Background: 1`) |
| WebSocket traffic | Not itself; typing in the editor is a key press the keepalive reports |
| Internal refresh with no request | No |
| Malformed `X-CMS-Idle-For` | No, so a bad value can only end a session sooner |

The headers are an honest-client policy, not a security boundary. Anyone holding the cookie can make a request that counts. They exist so the CMS's own scripts don't keep an abandoned session alive. A recorded time never moves backwards (`MAX` with the stored value).

Each `auth.session.rotate` and `auth.session.grace` event now records `activity: user | background` alongside `source`.

## Where the deadline is enforced

| Path | Check | Timing |
|---|---|---|
| Every authenticated HTTP request | `validateAccessSession` applies the idle predicate | At the request. Never late |
| Refresh (explicit and silent) | `findRefreshSession`, and the same predicate inside the rotation `UPDATE` | At the request. Never late. A lapsed session cannot be revived by a concurrent refresh, because the predicate and the write are one statement |
| Editor WebSocket | `validSession` before every inbound message and outbound delivery, plus the Durable Object's 60-second sweep | No data crosses after the deadline. An idle connection with no traffic closes within about 60 seconds |
| Cleanup | `purgeExpiredSessions` removes the row, with per-session evidence | Opportunistic, after refreshes |

## Timing tolerance

Enforcement errs early, never late:

- **Admin pages:** the keepalive reports interaction promptly once its last report is more than 5 minutes old, so the server's view of activity lags the person by at most about 5 minutes. A session can end up to about 5 minutes before the person's true idle deadline.
- **Clients without the keepalive** (scripts, API use): activity inside an access token's 15-minute life is invisible until the next refresh, so a session can end up to 15 minutes early. This is the floor `parseSessionIdleTtl` already enforces.
- **Clock:** every deadline is compared using D1's clock (`datetime('now')`). The browser sends a relative age in seconds, never a timestamp, so client clock skew has no effect.

## Verified in source (tests)

[test/session-idle.test.ts](../test/session-idle.test.ts) and [test/security-hardening.test.ts](../test/security-hardening.test.ts):

| Plan acceptance criterion | Covered by |
|---|---|
| Idle expiry is distinct from token and absolute expiry | Sessions with a valid refresh token and absolute lifetime are refused on idle alone, and a recent rotation does not rescue them |
| Background refresh cannot keep an idle session alive | A background refresh rotates the token and leaves `last_activity_at` unchanged. A malformed report counts as nothing |
| Activity is recorded when it happened | `X-CMS-Idle-For: 600` records ten minutes ago. An older report never moves the deadline backwards |
| Access tokens stop at the idle deadline | A valid access token is refused once its session is idle, and accepted again when activity is recent |
| Socket access stops within the documented interval | An open socket is closed with 1008 on the next Durable Object sweep, with no client message |
| Evidence distinguishes background from user refreshes | The rotation event carries `activity: background` |

Removing the idle predicate from `validateAccessSession` makes the access-token test and the socket test fail.

Not covered by a test:

- **Concurrent refreshes against a lapsing session** are covered only by construction: the idle predicate is evaluated inside the rotation `UPDATE`.
- **The browser keepalive logic** has no browser test. The timing above follows from the script, not from a measured run.

`npm run type-check` and `npm test` pass.

## Rollout

- **Apply [the manual migration](../migrations/manual/2026-11-02_session_last_activity.sql) to every existing private database before deploying.** `ADD COLUMN` cannot be written idempotently, so this ships under `migrations/manual/` and runs once. Without the column, the session queries fail closed and nobody can sign in or stay signed in.
- **The migration carries each session's current deadline over unchanged:** it backfills `last_activity_at` from the old idle base, `COALESCE(rotated_at, created_at)`. It neither extends nor ends a session at rollout. From then on, an open tab no longer counts, so a tab left open longer than `SESSION_IDLE_TTL` signs its user out.
- **Fresh installs** get the column from the regenerated baseline.

**Behaviour change for users:** an expired session's keepalive redirects to sign-in. Unsaved form input on that page is lost, as with any idle timeout. Choose `SESSION_IDLE_TTL` with that in mind.

## Still open outside this change

- **The idle value itself** is the security owner's decision. It defaults to 8 hours, a regulated deployment must set it, and the floor is 15 minutes. The plan's "addressable specification" decision and any external alternatives are recorded separately from this code result.
- **IdP session lifetime, MFA and step-up** remain external (A.8.5). This change does not touch them.
- **Deployment evidence** for W7: the migration applied, the configured value, and a staged check that an untouched tab signs out at the deadline.
