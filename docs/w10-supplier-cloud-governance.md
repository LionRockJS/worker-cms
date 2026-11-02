# W10 — supplier and cloud governance

Record for W10 in [the compliance plan](compliance-implementation-plan-2026-10-30.md): supplier inventory and risk assessments; executed security agreements (and BAAs where PHI is involved); a cloud shared-responsibility matrix; approved configurations; and an exit, export and deletion plan with periodic review ownership. Started 3 November 2026. **The repository side and one local exit drill are done. No agreement, assessment or review has been recorded, so A.5.19, A.5.20 and A.5.23 stay open.**

## What is in the repository

| File | What it is |
|---|---|
| [compliance/supplier-register.json](../compliance/supplier-register.json) | 9 supplier relationships: Cloudflare; five sign-in providers; GitHub as source host and CI; the npm registry; registered plugin Workers. Each records services used, data shared, a PHI note, agreement and assessment status, an exit route and an owner. Two agreements are marked `not-required` with a reason (the in-house Eventuai provider and the public npm registry). The other seven are `not-evidenced` |
| [tools/check-inventory.mjs](../tools/check-inventory.mjs) | Now also fails if an inventoried supplier has no register entry, if an entry points at no supplier, or if an agreement or assessment is recorded without a reference or date |
| [tools/check-export.mjs](../tools/check-export.mjs) | Exit drill: loads a `wrangler d1 export` file into stock SQLite and checks integrity, foreign keys and schema, then counts rows. `npm run check:export -- --file <export.sql>` |

## Shared responsibility

| Area | Cloudflare | 0xCMS code | Deploying organisation |
|---|---|---|---|
| Physical and host security | ✓ | | Accepts via agreement and assurance reports |
| Network edge, TLS termination, DDoS | ✓ | Sets security headers and the canonical origin | Configures domains, `CANONICAL_ORIGIN`, disables `workers.dev` |
| Encryption at rest (D1, R2, Durable Objects, Queues) | ✓ | | Confirms coverage for the services in use |
| Isolation between tenants and Workers | ✓ | | |
| Application authentication and authorization | | ✓ (W6, W9) | Chooses providers, approves roles, enforces IdP MFA |
| Classification, publication and disclosure rules | | ✓ (W1–W3) | Sets `data_classes` and the regulated inventory |
| Audit capture, archive sealing and alerts | | ✓ (W4, W5) | Binds the archive bucket, sets bucket lock and retention, runs the receiver |
| Secrets | Stores Worker secrets | Enforces minimum strength | Generates, rotates and limits who can read them (W9) |
| Cloudflare account access, API tokens, audit logs | Provides the controls | | Restricts membership and reviews it (A.8.2, A.8.18) |
| Backups and point-in-time recovery | Provides D1 Time Travel | | Confirms the window, takes independent copies, tests restores (W11) |
| Data location | Provides location and jurisdiction options | | Chooses them; nothing in this repository sets one |
| Plugins | | Approvals, pinned identities, scoped access | Vets each plugin operator as a supplier |

## Cloudflare

- **Configuration that matters** is captured in the [W8 inventory](../compliance/asset-inventory.json): every binding, which ones are required, and which are required in regulated mode. Reconcile a deployment with `node tools/check-inventory.mjs --config <wrangler.toml>`.
- **PHI:** a deployment holding PHI needs a BAA that covers every service it uses: Workers, D1, R2, Durable Objects, Queues and Images. That makes the BAA a release prerequisite under the plan. Which services Cloudflare's BAA covers, and on which plan, must be confirmed with Cloudflare; this record deliberately doesn't assume.
- **Data location:** no D1 location hint or R2 jurisdiction is set in source. If data must stay in a region, set it when resources are created; moving it later means a migration.

## Exit plan

| Data | How it leaves | Evidence |
|---|---|---|
| Private and published D1 | `wrangler d1 export <db> --remote --output <file>` gives plain SQLite SQL | **Drill run locally**, see below |
| Media and published snapshots (R2) | Copy with any S3-compatible client, using an R2 API token | Not run |
| Audit archive (R2) | Same; segments are gzipped NDJSON with their hash chain, readable without the CMS | Not run |
| Incident journal (R2) | Same | Not run |
| Durable Objects | Nothing to move: PageSync holds unsaved edits only, FormOnce holds single-use tokens | n/a |
| Queue | Drain before cut-over; job state is in `DB.admin_jobs` | n/a |
| Secrets | Not exported; owners re-create them in the new environment | n/a |
| Plugin data | Host-side records are in `DB.plugin_state`; anything a plugin keeps itself is that plugin's exit | Per plugin |

Deletion at the supplier after exit: delete the D1 databases, R2 buckets, queues and Worker, and record Cloudflare's deletion and backup-expiry terms (W12).

### Local drill, 3 November 2026

The drill used throwaway local databases in a worktree, never a deployed database:
1. Applied every current migration with `wrangler d1 migrations apply --local`.
2. Seeded synthetic rows.
3. Exported with `wrangler d1 export --local`.
4. Ran `tools/check-export.mjs` on the export.

| Database | Result |
|---|---|
| Private (`cms`) | Loaded into SQLite 3.47.2. Integrity `ok`, 0 foreign-key violations, schema matches a fresh install: 43 tables, 38 triggers and the indexes. Synthetic rows present |
| Published (`cms-published`) | Loaded, integrity `ok`, schema matches a fresh install |

**Negative check:** removing one index line from the export made the drill fail with `index idx_audit_events_actor is missing in the export`.

This shows the export format is portable and complete for schema. It doesn't show a production export: size, export time and row reconciliation against the live database still need a staged run.

## What W10 still needs from people

1. **Procurement or legal records each agreement:** a DPA or terms with Cloudflare and with the sign-in providers in use, and a BAA wherever PHI is held. Put the reference in the register entry. An unresolved required agreement stays open; it isn't "covered".
2. **The security lead records a risk assessment per supplier,** with a date, an owner and a review cadence.
3. **For each deployment's plugins,** list the operators from `DB.plugins` and treat each as a supplier.
4. **Choose a data location** where it matters, before creating resources.
5. **Run a staged exit:**
   - export a copy of production;
   - run `check-export`;
   - reconcile row counts with the source;
   - copy one R2 bucket;
   - record how long each step takes.
