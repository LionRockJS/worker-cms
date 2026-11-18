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

### D8. Classification gates publication, and fails closed

Added 2026-10-30, after the compliance review found that publication returns the
whole `lect` when no projection rule exists
(`src/core/publish/projection.ts:53`): minimization is declared by plugins, so a
disabled plugin silently restored full disclosure, and a `phi` classification
did not gate the path at all.

A page classified `phi` is now **never published**. The gate is host-owned
(`src/core/publish/regulated.ts`), runs before any snapshot is built, and
refuses on either container the page belongs to:

- its page type;
- a taxonomy any of its tags belongs to — the *association* is the regulated
  fact, and a page tagged from a classified taxonomy discloses it even when the
  page's own type is ordinary. This is the first consumer of the `taxonomy`
  container kind, keyed by `tags.taxonomy_slug`.

Unlike read logging, this path **fails closed**: a classification outage refuses
publication rather than permitting it. The asymmetry is deliberate. Read logging
that fails closed takes every surface down with the classification table; a
publication that fails open is an irreversible disclosure. Refusing costs an
operator a retry.

Nothing gates *un*publication — withdrawing a page that reached live before it
was classified has to stay possible.

`pii` is not gated. It is logged on read, not withheld from publication;
conflating the two would make the classification screen unusable for ordinary
contact data.

### D9. Regulated media is withheld, not merely logged

Added 2026-10-30, from the same review. Classifying a media prefix made its
deliveries *audited* and nothing more: an ordinarily uploaded object under a
`phi` prefix stayed fetchable by anyone holding the URL
(`src/features/media/routes/public.ts:32`), under `max-age=31536000`. Recording
a disclosure is not preventing one.

Two layers, because neither alone covers the cases:

- `src/features/media/regulated.ts` classifies a key by prefix, which covers
  objects already in the bucket when their prefix is classified;
- the `cmsPrivate` object marker is now written at **upload** time for a
  regulated destination, so it protects the object independently of the table.
  An upload that cannot be classified is refused rather than guessed, because
  mis-marking is durable where a refusal costs a retry.

The public routes refuse **before** the existence check, so a withheld key
cannot be told apart from a missing one — confirming that something exists under
a classified prefix is itself a disclosure — and before the edge-cache read, so
classifying a prefix stops deliveries this Worker has already cached.

Like D8 this fails closed, and more loudly: an unreadable classification answers
**503**, not 404, on every public media request. 404 would read as "no such
file" when the truth is "we cannot tell", which is the silent fail-open the
control exists to prevent. The cost is that public media stops on a database
that never ran the `data_classes` migration — deliberately, because an
installation that cannot say which objects are regulated should not be handing
objects to anonymous callers, and the fix is the migration it already owes.

Authorized access keeps working: `GET /admin/media/*` serves any registered
object under the new `media:regulated` capability, with `no-store` and no
validator, and announces the read so the access log records it against the
classified prefix *with an actor* — which is the point of serving it there
instead. No built-in role holds `media:regulated`, so a deployment grants it
deliberately; uploading media and reading regulated media are different duties.

`pii` is not withheld, for the same reason it is not gated on publication.

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
| Rejected token refresh | `src/routes/auth.ts:760` | `auth.refresh` |
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
terms — a search string is frequently the identifier itself. It is recorded
against the page types that were *searched*, not the ones that happened to
match, so a search returning nothing still leaves a row: asking a container a
question is what a probe looks like.

**The media routes are public.** `/media/*` and `/media-preview/*` are
unauthenticated and edge-cached, so a row from them carries the key and the
source IP but no actor. The read is announced before the cache lookup, so a
cached hit is still accounted for — but classifying a media prefix makes
deliveries traceable, it does not make serving ePHI from a public, cacheable
URL acceptable. Regulated objects need an authenticated route, which this
design does not add.

Only *failed* token refreshes are recorded. A successful 15-minute rotation is
not a new sign-on, and one row per active user per quarter-hour would bury the
rejections that matter — a replayed or revoked refresh token. `editorGuard`
denials are skipped for the same reason: a viewer bouncing off every editor
route is expected noise, while a refused `requirePermission` check is a real
signal.

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
- Reading the classification policy needs `audit:read`; changing it needs
  `menu:manage`, the existing system-settings capability. They are separate
  because classifying a container is what switches read logging — and, for
  `phi`, fail-closed serving — on for it, which is a different act from
  reviewing the trail. Both changes are recorded (`data_class.set`,
  `data_class.clear`), or the policy could be moved around a read unnoticed.
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

**Phase 1 — auth events and a viewer** — done 2026-10-30.
Auth hooks, `audit:read`, the `audit` feature with a filterable list
(`/admin/audit`, event class / outcome / action prefix). The sign-in wrapper
reads the failure reason off the redirect rather than instrumenting each of the
twenty exits, so a branch added later is recorded without touching it.
*Verified* in `test/audit-log.test.ts`: a refused sign-in with its reason, a
sign-out against the session it ended, a refused capability check with the
permission and path, the screen 403ing without `audit:read` (and recording that
refusal), the read recording its own filters, filtering, rejected filter values,
and that the table has no column an email could be written into. Login success
is covered in `test/routes.test.ts`.

**Phase 2 — classification and read logging** — done 2026-10-30.
`data_classes`, the classification screen at `/admin/audit/classes`, the
`accessLog` middleware mounted globally in `src/index.ts`, and `recordRead` /
`recordPageReads` in `src/core/http/access-log.ts`. Handlers announce what they
returned; the middleware resolves classification once per request and writes
the classified reads in one batch, so a handler cannot forget to check and a
list costs one row.
*Verified* in `test/access-log.test.ts`: an unclassified container records
nothing at all; a classified page type records exactly one row with its
container; a sibling unclassified type stays silent; a 120-page listing capped
at 100 records one row with `target_count` 100 and 100 capped ids; a search
records a fingerprint and no term; a `phi` read whose audit write fails returns
503 and serves nothing, while a `pii` read in the same situation still serves;
and the classification screen gates, records and validates its changes.

**Phase 3 — seal, archive, retention** — done 2026-10-30.
`audit_seals`, and the sweep in `src/features/audit/sweep.ts` run from the
feature's `scheduled` service on the existing 5-minute cron. Each tick archives
one bounded segment (1000 events) as gzipped NDJSON to `AUDIT_BUCKET`, seals it,
then prunes only rows at or below the highest sealed seq whose class is past its
hot window. `verifyAuditArchive()` recomputes every seal from the archived
bytes.

Three orderings the sweep exists to keep: nothing is pruned that was not
archived (no bucket means no sweep at all, not a sweep that frees space);
the object is written before the seal, so a crash between them re-archives the
same range to the same key rather than sealing a range with no object; and
seals chain, so a segment cannot be replaced in isolation.

`audit_seals` lives in the **feature's** schema fragment, not the core schema,
because only the sweep touches it — which means it ships as the runner-applied
`migrations/0006_enable_audit.sql` instead of a third hand-applied file. That is
the delivery fix for the problem Phase 2 hit in production (see below).

*Verified* in `test/audit-sweep.test.ts`: a segment is archived, sealed and
left queryable; the next tick resumes from the seal rather than re-archiving,
and the seq ranges join end to end; every seal recomputes from its bytes; a
replaced object fails `contentOk` while its chain stays intact; a deleted object
is reported missing; a rewritten seal breaks the chain for itself and everything
after it; rows past their class window are pruned while hotter classes stay; and
with no bucket nothing is archived *and* nothing is pruned.

**Phase 4a — detection and review** — done 2026-10-30.
`src/features/audit/signals.ts` and the screen at `/admin/audit/review`: three
signals plus archive health in one place. This is the half of Phase 4 that needs
no deployment decisions, and it closes the gap that mattered most — a trail
nobody examines satisfies no regime (ISO 27001 A 8.16, SOC 2 CC7.2, NIST AU-6,
HIPAA §164.308(a)(1)(ii)(D) all require review, not just recording).

The signals, with their default thresholds:

| signal | fires on | default |
|---|---|---|
| `bulk_reads` | one actor, one classified container, records read in 24h | 500 |
| `refused_access` | denied auth and permission checks per actor+address in 24h | 5 |
| `contributor_alone` | classified reads by a plugin with no acting user, 7d | any |

Thresholds are defaults chosen to be quiet on an ordinary install, not policy;
they are exported constants, not configuration, until someone needs them to be.

Archive health shows sealed segments, their seq coverage, the unarchived backlog
and its oldest event (which is what reveals a stalled sweep), and the
verification result. `verifyAuditArchive()` now checks the **newest** window of
seals rather than walking forward from the first, seeding the chain from the
seal immediately before the window — on a long archive a forward walk would
never reach the segment an operator is actually asking about.

*Verified* in `test/audit-review.test.ts`: each signal fires on its shape and
stays silent otherwise — below threshold, outside the window, unclassified
containers however large, and a contributor read that does name its user;
`bulk_reads` sums across requests rather than needing one large read; a refused
sign-in with no resolved account is still reported rather than dropped for lack
of a name; backlog counts only what the seals do not cover; a windowed
verification still validates the chain into the window and really is the newest
seals; and the screen is gated on `audit:read` and records its own opening.

**Phase 4b — shipping** — not built. Replicating the R2 archive to S3 or Azure
Blob, and any real-time SIEM feed, needs decisions this design cannot make for a
deployment: which sink, whose credentials, and which region each tenant's events
may leave for. §5 has the shape; the delivery channel for an alert is the same
open question.

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

**What went wrong in production, and the rule it produced.** Phase 0 and Phase 2
each added a *core* table, which `migrations/` cannot carry (it holds the
baseline and `*_enable_*` files only), so both shipped as hand-applied files
under `migrations/manual/`. Three of the four tenant databases never got them:
`/admin/audit` returned 500 on the deployment that was missing `audit_events`,
and — worse, because it was silent — `logAudit()` had been failing on every
mutation there since Phase 0, so those installs had no audit trail at all while
appearing to work.

The rule that follows: **a new table goes in a feature fragment whenever only
that feature touches it**, so `--enable` carries it to every database through
the migration runner. Core-schema tables are the exception, not the default, and
each one is an operational task across every deployment. `audit_seals` follows
this; `audit_events` and `data_classes` could not, because core writes to them
and a feature-owned table written by core would break droppability.

## 10. Out of scope

These are real gaps this design does not close. Each needs its own decision.

- **The public site Worker.** Published pages share one table and can carry PII;
  a visitor read there is not logged by this design and is a separate Worker.
  Since D8, a `phi`-classified page cannot reach that table at all, so what is
  unlogged there is PII and unclassified content.
- **Plugin-internal databases.** The events plugin's own guest tables are read
  without passing through `/__cms`. Only its CMS-side reads are covered.
- **Direct infrastructure access.** D1 or R2 reached through the Cloudflare
  dashboard, Wrangler or the API bypasses the Worker entirely. That is
  Cloudflare account-level audit logging plus access control, not this.
- **Shipping to an external sink.** The archive lands in R2; replicating it to
  S3 or Azure Blob, and any real-time SIEM feed, is not built (Phase 4b).
- **Alert delivery.** Signals are detected and shown, but nothing pushes them —
  no email, webhook or SIEM. An operator has to open the screen.
- **Scheduled review.** Nothing records *that* a review happened beyond the
  `audit.review` event, so there is no evidence trail of periodic examination,
  which is what an ISO or SOC 2 auditor asks to see.
- **After-hours access.** Deliberately not a signal: it needs an hours-of-business
  policy per deployment, and guessing one produces either noise or false comfort.
- **Caches already holding a withheld object.** D9 stops this Worker from
  serving a regulated object, but a `max-age=31536000` response handed out
  before the prefix was classified may sit in the Cloudflare edge cache, a
  downstream proxy or a browser. Those have to be purged, and copies already
  downloaded cannot be recalled. Assessing prior exposure is an operational
  step, not a code change.
- **Embedding regulated media in page content.** The editor's upload response
  returns the canonical `/media/<key>` path, which a withheld object no longer
  serves. Regulated media is reachable through `/admin/media/*` and the Files
  browser; it is not supported inside published page content, which is
  consistent with D8 refusing to publish the page in the first place.
- **Separate public and private buckets.** One bucket serves both, and the
  separation is by prefix classification and object marker rather than by
  binding. A dedicated private bucket would make the boundary structural.
- **Object Lock.** The sweep writes to a plain bucket. Hash chaining makes
  tampering *detectable*; only Object Lock in compliance mode makes it
  impossible, and that is configured on the bucket, not in this code.
- **BAA coverage.** Confirm Cloudflare will sign a BAA covering Workers, D1, R2
  and KV on the current plan, and that every sink is covered too. If the
  platform is not in scope, none of the above produces a compliant system.
- **Documented policy and evidence of review.** ISO 27001 A 8.15/8.16 and SOC 2
  CC7.2 are satisfied by a written logging policy and records showing the log is
  actually reviewed. The mechanism alone does not pass an audit.
