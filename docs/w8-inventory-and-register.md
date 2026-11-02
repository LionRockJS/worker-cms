# W8 — owned inventory and control register

Record for W8 in [the compliance plan](compliance-implementation-plan-2026-10-30.md): reconcile databases, media, copies, plugins, identities, suppliers and environments with the actual deployment; record ownership, classification, purpose and lifecycle; and keep a closure register for the 59 controls in scope. Started 3 November 2026. **The repository side is in place. Nothing is owned yet, and no deployment has been reconciled.**

## What is in the repository

| File | What it is |
|---|---|
| [compliance/asset-inventory.json](../compliance/asset-inventory.json) | 99 logical assets, each with purpose, data held and lifecycle: 15 bindings, 7 secrets, 1 credential file, 21 variables, 46 D1 tables, 5 suppliers and 4 environments. The `owner` field is empty everywhere |
| [compliance/control-register.json](../compliance/control-register.json) | The 59 controls: the original 27, plus 13 repo-led and 19 hybrid. Each has its work packages, closure evidence and three separate states (see below). Owner, reviewer and next review are empty everywhere |
| [tools/check-inventory.mjs](../tools/check-inventory.mjs) | Runs inside `npm test`. Fails if a binding, variable or secret in `Env`, a binding in `wrangler.example.toml`, or a table in either baseline has no inventory entry, or if an entry no longer exists in source. Also validates the register |

The inventory is deliberately **logical**: what the code depends on and holds, not one deployment's resource names or account IDs. Per-deployment detail belongs in the restricted evidence system, consistent with the [P0 acceptance record](p0-manual-acceptance-2026-10-31.md).

**Data held** uses a fixed vocabulary:

| Value | Meaning |
|---|---|
| `public` | Intended for publication |
| `internal` | Configuration or operational state, no personal data |
| `personal` | Personal data |
| `content` | User content, classified per deployment through `data_classes` |
| `credential` | Secrets, keys or token hashes |
| `evidence` | Audit and integrity records |
| `financial` | Balances, charges and billing |

### The register's three states

| State | Values | Who can set it |
|---|---|---|
| `source` | implemented, partial, supporting, gap, not-evidenced, not-assessed | Engineering, from source reviews. Set from the [3 November coverage update](iso-27001-coverage-review-2026-11-03.md) |
| `external` | not-evidenced, partial, verified | Only from recorded deployment or organisational evidence. Every control is `not-evidenced` today |
| `effective` | true / false | A reviewer. The check refuses `true` without a named owner, a named reviewer and verified external evidence |

Current source states across the 59: 12 implemented, 11 partial, 9 supporting, 1 gap, 2 not-evidenced and 24 not assessed.

### The update process

- **Adding a binding, secret, variable or table** fails `npm test`, and therefore CI, until the inventory has an entry for it.
- **Retiring one** fails until its entry is removed.
- **Owners, reviewers and review dates** are edited in the JSON and reviewed like any other change. `CODEOWNERS` now lists `compliance/`, but like every rule in that file it is commented out until a real GitHub login or team replaces `OWNER`. Until then, and until branch protection requires code-owner review, nothing enforces that review.

Verified locally: removing the `admin_jobs` entry made the check fail with `DB.admin_jobs has no inventory entry`.

## Reconciling a deployment

For each production site, run:

```bash
node tools/check-inventory.mjs --config wrangler.production.toml
```

It lists each inventoried binding as declared or not declared in that config, and marks the ones that are required always or in regulated mode. Secrets are marked as "verify with `wrangler secret list`", since they never appear in the config. It prints names only, never values, and writes nothing.

Store the output in the evidence system along with:
- the `wrangler secret list` names;
- the live `DB.plugins` rows;
- the deployed revision.

Then have the data and platform owners approve it. That approved, per-deployment record is the reconciliation W8 asks for. Run against the tracked `wrangler.toml` template, it reports `AUDIT_BUCKET`, `REGULATED_MODE`, `REGULATED_INVENTORY` and `SESSION_IDLE_TTL` as missing for regulated mode, as expected.

## Findings from building the inventory

Each needs an owner's decision. None is fixed here.

| # | Finding | Controls | Belongs to |
|---|---|---|---|
| 1 | **Submissions stay in the published database indefinitely.** Public Workers (forms, RSVP) insert submissions into `PUBLISHED_DB.pages`. The cron ingest copies them into drafts but never mutates or deletes the published row ([submission-ingest.ts](../src/core/db/submission-ingest.ts)). Personal data therefore persists in the database public sites read, with no retention rule | A.8.10, A.5.34, A.8.12 | W12 |
| 2 | **Legacy `audit_log` table.** Nothing in source reads, writes or prunes it, but it can still hold old admin records with actor details | A.5.33, A.8.10 | W12 |
| 3 | **`admin_jobs` grows without bound.** Nothing deletes finished jobs | A.8.6, A.8.10 | W11/W12 |
| 4 | **Trash never expires, and credit ledgers have no retention rule.** Trash empties only when an editor restores or purges. The ledgers are append-only | A.8.10 | W12 |
| 5 | **The Apple sign-in signing key** (`AuthKey_<key-id>.p8`) sits in a working copy's root. It's gitignored, but where it lives and how it's rotated have no owner | A.5.17, A.8.24 | W9 |
| 6 | **No rotation procedure in source** for `JWT_SECRET`, `PLUGIN_SECRET` or the OAuth client secrets | A.5.17, A.8.24 | W9 |
| 7 | **No staging environment is defined,** although W7's rehearsal needs one with separate resources and credentials | A.8.31 | W7, W14 |
| 8 | **Deployed revisions aren't recorded anywhere** the repository can reach | A.5.9, A.8.32 | W0 |

## What W8 still needs from people

1. **The security lead assigns an owner** to each asset and each control, and a reviewer to each control. Use roles or names, not personal contact details.
2. **Platform owners reconcile each deployment** as above, and approve the result.
3. **Sample the update process operationally:** one new, one changed and one retired asset, each traced from change to inventory entry to approval. The CI check proves the mechanism, not that people follow it.
4. **Supplier entries** need risk assessments and agreements (W10). The inventory names the suppliers; it doesn't assess them.
5. **Extend the register** when applicability work brings in the other 34 Annex A controls.
