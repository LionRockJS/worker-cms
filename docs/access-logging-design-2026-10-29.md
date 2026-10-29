# Access logging design — PHI and PII

Status: draft for review. Not implemented.
Date: 2026-10-29.
Scope: the feature-sliced host at `workers/cms`. See "Out of scope" for what this
does not cover.

## 1. Problem

`audit_log` (`src/core/schema.sql:148`) is a **change log**, not an access log.
`logAudit()` (`src/core/db/audit.ts`) is called from 61 sites, every one a
mutation. There are no read events, no authentication events, no request
context, no reader, no retention policy and no integrity control. Four
consequences:

- HIPAA §164.312(b) requires recording *and examining* activity in systems that
  contain ePHI. Nothing records a read and nothing examines anything.
- GDPR Art. 33 gives 72 hours to scope a breach by **data subject**. The log is
  actor-indexed only, so that question cannot be answered from it.
- `user_email` is denormalized into every row, so an Art. 17 erasure leaves the
  address in rows we are obliged to retain.
- Writes are fire-and-forget through `waitUntil` and a failure only
  `console.error`s, so the log is lossy by construction.

## 2. Design decisions

### D1. Classification is core; the review UI is a feature

The recorder stays in `src/core/`, because an install must not be able to drop
its audit control and still claim compliance. It is nonetheless inert by
default: with no classified containers, the read path records nothing and costs
one map lookup. Policy lives in data, not in the build profile.

The **viewer, alerting, retention sweep and shipper** go in a new optional
feature `audit`. A deployment holding no regulated data does not need them.

### D2. Classify containers, never rows

A new core table `data_classes` maps a container to a class:

| container_kind | container_key example | class |
|---|---|---|
| `page_type` | `patient_note` | `phi` |
| `page_type` | `contact` | `pii` |
| `taxonomy` | `diagnosis` | `phi` |
| `media_prefix` | `upload/records/` | `phi` |
| `plugin` | `events` | `pii` |
| `table` | `users` | `pii` |

It must be core, not part of `runtime-content-types`: that feature is optional
(`cms.features.json`), and compiled base page types from
`src/core/db/content-config.ts` exist without it. Classification has to work in
either profile.

Row-level sensitivity tests are rejected on purpose — they fail the moment a
container that was clean starts carrying regulated data.

### D3. Audit failure is access failure, per class

NIST AU-5, and the reason a `waitUntil` log cannot be the whole story:

- `phi` events are flushed **before the response is sent**. If the write fails,
  the request fails. We accept the added latency on a small number of routes.
- `pii` and unclassified events stay asynchronous in `waitUntil`.

The policy is a column on the class, not a constant, so it is reviewable.

### D4. One event stream, one writer

All 61 existing call sites go through `logAudit()`. Rewriting that one function
moves the entire mutation side onto the new envelope with no call-site churn.
Two direct inserts bypass it today and must be routed through it:
`src/core/pages/bulk-action.ts:298` and `src/features/plugins/api/hooks.ts:24`.

New table `audit_events`. The existing `audit_log` is **left in place** as
history rather than migrated — a live-DB backfill buys nothing, and the sweep
expires it on its own schedule.

### D5. Buffer per request, write once

`src/core/http/request-context.ts` already carries an AsyncLocalStorage
request context. Add an event buffer to it, opened in `authMiddleware`
(`src/core/auth/guards.ts:48`) and flushed once per request through
`DB.batch()`. This is what keeps a 200-row list view to one row instead of 200,
and it respects the D1 write and subrequest budget that bulk CMS work already
fights.

### D6. Seal by segment, not by row

A per-row `prev_hash` chain requires serialized writes and races under
concurrent Workers. Instead a cron job closes a time window, writes the segment
as NDJSON to R2, and records a rolling hash in `audit_seals`. Tamper evidence
comes from the seal; actual immutability comes from R2 Object Lock on the
archive.

### D7. Subjects get their own table

A JSON array cannot be indexed usefully in SQLite, and the 72-hour question is
"everything touching subject X". Hence `audit_event_subjects`, indexed on
`(subject_kind, subject_ref)`.

Subject references are opaque: page `uuid`, user id, contact id. Never a name,
email or slug — a slug can itself be the identifier (`/patients/jane-doe`).

## 3. Event envelope

```
audit_events
  seq              INTEGER PRIMARY KEY AUTOINCREMENT  -- intra-ms ordering
  event_id         TEXT NOT NULL UNIQUE               -- uuid, stable across sinks
  occurred_at      TEXT NOT NULL                      -- ISO-8601 UTC, ms, set in code
  event_class      TEXT NOT NULL                      -- auth|read|mutation|export|admin
  data_class       TEXT NOT NULL DEFAULT 'none'       -- none|pii|phi
  retention_class  TEXT NOT NULL
  action           TEXT NOT NULL                      -- 'page.read', 'auth.login', ...
  outcome          TEXT NOT NULL                      -- success|denied|error
  actor_user_id    TEXT                               -- internal id ONLY; null = anonymous
  actor_roles      TEXT                               -- snapshot, forensic, not PII
  acting_via       TEXT                               -- plugin/contributor id, else null
  session_sid      TEXT                               -- JWTPayload.sid
  request_id       TEXT
  source_ip        TEXT
  user_agent       TEXT
  target_type      TEXT                               -- page|media|tag|user|query|...
  target_id        TEXT                               -- the single target; scalar so it is indexable
  target_ids       TEXT                               -- JSON array when there are many, capped
  target_count     INTEGER                            -- authoritative for list reads
  container_key    TEXT                               -- the classified container hit
  query_fingerprint TEXT                              -- hash of search criteria
  detail           TEXT                               -- small JSON; never content bodies

audit_event_subjects
  event_id, subject_kind, subject_ref   -- indexed on (subject_kind, subject_ref)

audit_seals
  segment_start, segment_end, event_count, rolling_hash, r2_key, sealed_at
```

Notes:

- `occurred_at` is set in code, not `CURRENT_TIMESTAMP`; the current column is
  whole-second resolution, which is too coarse for forensic ordering, for the
  seal, and for PCI DSS 10.6 / ISO A 8.17.
- No `user_email`. The viewer joins `users` at read time; after an erasure the
  join yields nothing, which is the intended behaviour.
- A single-target event sets `target_id`, which is indexed: "everything that
  touched page 101" is where an investigation starts. A list read leaves it null
  and fills `target_ids`, capped (suggest 100), with `target_count` carrying the
  truth.
- Shaped as a FHIR `AuditEvent` subset so it maps cleanly for healthcare
  integrations; OCSF is the alternative if the consumer is a security data lake.

## 4. Hook points

Reads are instrumented by **middleware plus an opt-in detail call**, not by
editing each handler. Middleware resolves the route's container and class and
opens the event; a handler calls `recordRead(c, ids)` to attach targets. A
handler that forgets still produces an event with an unknown target count —
failure mode is a vague record, never a missing one.

| Surface | Location | Action |
|---|---|---|
| Login success/failure | `src/routes/auth.ts:728` (`handleOAuthCallback`) | `auth.login` |
| Logout | `src/routes/auth.ts:740` | `auth.logout` |
| Token refresh | `src/routes/auth.ts:760` | `auth.refresh` |
| Permission denial | `requirePermission`, `src/core/auth/guards.ts:142` | `*.denied` |
| Page read | `src/routes/admin/pages/crud.ts:347` (`/pages/:id/read`) | `page.read` |
| Page editor open | `src/routes/admin/pages/crud.ts:407` (`/pages/:id/edit`) | `page.read` |
| Page lists | `src/routes/admin/pages/dashboard.ts:340,342,390` | `page.list` |
| Advanced search | `src/features/search/routes.ts:29,33` | `page.search` |
| Media download | `src/features/media/routes/public.ts:18,37` | `media.read` |
| Plugin page reads | `src/features/plugins/api/pages.ts:123,311,475,629` | `page.read` |
| Audit viewer itself | new `audit` feature route | `audit.read` |

For plugin API reads, the actor is the **end user** resolved through
`coreExtensions().actingUserId` (`src/core/extensions.ts:280`, fed by the
`x-cms-user` header), with the plugin id in `acting_via`. A plugin read with no
acting user is recorded as the plugin acting alone, which is itself worth
alerting on for a `phi` container.

Search records a `query_fingerprint` (hash) and a result count, never the raw
terms — a search string is frequently the identifier itself.

## 5. Storage and transport

```
request ──► per-request buffer ──► DB.batch() ──► audit_events (D1, hot, 90d)
                                                      │
                                      cron sweep ─────┼──► NDJSON segment ──► R2 (Object Lock, long)
                                                      │                        └─► audit_seals
                                                      └──► prune past retention
```

- D1 is the source of truth and feeds the viewer. The R2 archive is built from
  D1 by the sweep, **not** from logs: Workers Logs and Tail Workers can sample
  under load, which disqualifies them as the authoritative path.
- A Tail Worker consuming a one-line JSON envelope is an optional *additional*
  real-time SIEM feed (OTLP or syslog RFC 5424 over TLS), not the record.
- Put Vector or Fluent Bit between the Worker and any vendor sink so
  CloudWatch / Azure Monitor / SLS stay swappable, and keep sink selection
  per-region: shipping EU or mainland-China subjects' events to a US sink is
  itself a cross-border transfer needing its own basis (GDPR Chapter V, PIPL
  Art. 38 et seq.).

## 6. Retention classes

| retention_class | D1 hot | Archive total | Driver |
|---|---|---|---|
| `phi_access` | 90d | 6y | HIPAA, by convention from §164.316(b)(2) |
| `phi_mutation` | 1y | 6y | same |
| `content_mutation` | 1y | 6y | unclassified content changes: low volume, high forensic value |
| `auth` | 90d | 2y | PCI DSS 10.5.1 (12mo, 3mo hot) |
| `pii_access` | 90d | 1y | GDPR storage limitation |
| `admin_config` | 1y | 6y | low volume, high forensic value |
| `none` | 90d | none | operational only |

Per-class rather than global, because HIPAA pulls retention up and GDPR pulls it
down, and a six-year record of who viewed whose data is itself a large PII
holding.

## 7. Access control

- New permission `audit:read`, added to `PERMISSIONS` and
  `PERMISSION_DESCRIPTIONS` in `src/types.ts:19,43`. `admin` holds every
  permission in code, so it needs no grant.
- The viewer is read-only. No route mutates or deletes `audit_events`; pruning
  belongs to the cron sweep alone.
- Reading the audit log emits `audit.read`.

## 8. Phasing

Each phase ships independently and is verifiable on its own.

**Phase 0 — fix the existing log** (small, no new surfaces)
Drop `user_email` from the envelope, set `occurred_at` in code, point
`logAudit()` at `audit_events`, route the two direct inserts through it. Every
event lands as `data_class = 'none'` with `retention_class` derived from the
entity type (`admin_config` for configuration, `content_mutation` for content),
because no container is classified until phase 2.
*Verify:* mutations still produce one row each; no email in any new row;
`npm run type-check` and `npm test` pass.

**Phase 1 — auth events and a viewer**
Auth hooks, `audit:read`, the `audit` feature with a filterable list.
*Verify:* a login, a failed login, a logout and a denied permission each appear;
the screen 403s without `audit:read`.

**Phase 2 — classification and read logging**
`data_classes`, the settings screen for it, read middleware, `recordRead`.
*Verify:* with nothing classified, a page read writes zero rows; classify one
page type and the same read writes exactly one; a 200-row list writes one row
with `target_count = 200`; a `phi` write failure fails the request.

**Phase 3 — seal, archive, retention**
Cron sweep, R2 segments, `audit_seals`, pruning.
*Verify:* a sealed segment's recomputed hash matches; a tampered row is
detected; rows past retention are gone from D1 and present in R2.

**Phase 4 — shipping and alerting**
Tail Worker or direct OTLP, plus alerts on bulk export, after-hours access and
mass reads.
*Verify:* an induced bulk export raises an alert; the sink receives the same
`event_id` as D1.

## 9. Migration

- `audit_events`, `audit_event_subjects`, `audit_seals` and `data_classes` are
  **core** objects, so they belong in `src/core/schema.sql`. Fresh installs get
  them from the regenerated baseline (`npm run build:migrations`).
- Core changes are not covered by `build:migrations -- --enable <id>`, which is
  for feature fragments, and `migrations/` may hold only the baseline and
  `*_enable_*` files — `test/migration-contract.test.ts` enforces that. A core
  table therefore ships as a hand-applied file under `migrations/manual/`
  (`2026-10-29_audit_events.sql`), written as `CREATE TABLE IF NOT EXISTS`,
  applied with `wrangler d1 execute --file` to every existing database, then
  deleted once they all have it.
- That hand-apply step is the standing cost of keeping the recorder in core
  (D1). It is accepted deliberately: a feature-owned table cannot be written by
  core without breaking droppability, and a recorder that silently skips when
  its table is absent is worse than a migration to remember.
- The `audit` feature's own fragment (shipper cursor, sweep state) starts with
  `-- feature: audit` and reaches existing databases through
  `npm run build:migrations -- --enable audit`.
- `cms.features.json` gains `"audit": true`.
- The published database is untouched; there is no audit table there.
- `npm run check:boundaries`, `check:profiles`, `check:generated` must pass with
  `audit` both on and off.

## 10. Out of scope

These are real gaps this design does not close. Each needs its own decision.

- **The public site Worker.** Published pages share one table and can carry PII;
  a visitor read there is not logged by this design and is a separate Worker.
- **Plugin-internal databases.** The events plugin's own guest tables are read
  without passing through `/__cms`. Only its CMS-side reads are covered.
- **Direct infrastructure access.** D1 or R2 reached through the Cloudflare
  dashboard, Wrangler or the API bypasses the Worker entirely. That is
  Cloudflare account-level audit logging plus access control, not this.
- **BAA coverage.** Confirm Cloudflare will sign a BAA covering Workers, D1, R2
  and KV on the current plan, and that every sink is covered too. If the
  platform is not in scope, none of the above produces a compliant system.
- **Documented policy and evidence of review.** ISO 27001 A 8.15/8.16 and SOC 2
  CC7.2 are satisfied by a written logging policy and records showing the log is
  actually reviewed. The mechanism alone does not pass an audit.
