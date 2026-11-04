# W14 — secure development and release assurance

Record for W14 in [the compliance plan](compliance-implementation-plan-2026-10-30.md). The plan asks for these to be documented:
- security requirements and threat modelling;
- code review and test acceptance;
- vulnerability handling;
- environment separation and branch/CI protection;
- deployment authorization and rollback.

It also asks to inspect external CI first, add missing gates and integrate the W1–W6 regressions. One change is to be walked from requirement to rollback.

Started 4 November 2026 at `d0241fb`. **The repository gates are in place and one change is walked through below. Branch protection, review and deployment authorization live in GitHub and Cloudflare and were not inspectable from here, so A.8.25, A.8.29 and A.8.32 stay open.**

Controls: A.8.25, A.8.26, A.8.28, A.8.29, A.8.31, A.8.32, plus parts of A.5.21, A.8.4, A.8.8.

## What was inspected

| Area | Found | Gap |
|---|---|---|
| CI ([ci.yml](../.github/workflows/ci.yml)) | Type check and `npm test` on every pull request and push to main. `npm test` runs the build plus the profile, boundary, generated-code and inventory checks. There's also an upgrade-path drill from `f9719a3` (W7) | The dependency audit ran with `continue-on-error`, so it never blocked |
| Static analysis ([codeql.yml](../.github/workflows/codeql.yml)) | CodeQL `security-and-quality` on pull requests, pushes and weekly | Triage owner not named |
| Dependencies ([dependabot.yml](../.github/dependabot.yml)) | Weekly npm and Actions updates | Its comment says Actions are SHA-pinned; **they were pinned by tag**, so a moved tag ran unreviewed code with CI's token |
| Review ownership ([CODEOWNERS](../.github/CODEOWNERS)) | Paths listed | Every rule is commented out until a real owner is named (W8) |
| Deploy (`npm run deploy`) | `npm run build && wrangler deploy` | It deployed whatever was on disk: no tests, no check that the code was committed or pushed, and no record of which commit went live (the W7 finding "deployed revisions unrecorded") |
| External: branch protection, required checks, CI history, open alerts | **Not inspected.** `gh` is not installed here, and the settings need repository admin | See below |
| History | Recent work merged into `main` locally by its author and pushed. No pull request, no second reviewer, and commits are unsigned | Review isn't enforced by the repository |
| Environments | One local and one production config per site (`wrangler.toml` template, `wrangler.production.toml`) | **No staging environment is defined** (W8 finding). The W7, W11 and W12 staged drills have nowhere to run |

## What changed

### Security requirements register

[compliance/security-requirements.json](../compliance/security-requirements.json) lists 16 requirements gathered from W1–W13. Each one names the Annex A controls it serves and the tests that prove it, 39 tests in all. Examples:
- token confusion refused;
- phi never published or served publicly;
- the audit chain cannot fork;
- a held page is never purged.

[tools/check-requirements.mjs](../tools/check-requirements.mjs) runs inside `npm test`. It fails when:
- a named test no longer exists, so renaming or deleting a security test changes the register in the same review;
- a requirement cites a control not in the control register;
- a duplicate id appears.

### Action pinning

Every `uses:` is now a full commit SHA with its version as a comment. Each pin is the commit its tag pointed at on 4 November, so behaviour is unchanged:

| Action | Version |
|---|---|
| `actions/checkout` | v4.4.0 |
| `actions/setup-node` | v4.4.0 |
| `github/codeql-action` | v3.39.2 |

The same checker fails on any action used by tag. Dependabot moves the pins.

### Blocking dependency audit

`npm audit --audit-level=high` reported **0 vulnerabilities**, so there was no backlog to triage. The CI job now blocks. A finding that can't be fixed at once becomes a recorded exception (below), not a disabled job.

### Gated deploy

`npm run deploy` now runs [tools/deploy.mjs](../tools/deploy.mjs). It refuses when:
- the working tree has uncommitted changes;
- the branch has no upstream;
- HEAD isn't on its upstream, i.e. it hasn't been pushed for CI to see.

It then runs `type-check` and `npm test`. It deploys with `wrangler deploy --tag <commit> --message "<commit> <subject>"`, so `wrangler versions list` shows which commit each version is.

Wrangler options pass through, for example `npm run deploy -- -c wrangler.production.toml`. There's no skip flag. A bypass means running `npx wrangler deploy` by hand, recorded as an exception.

Checked here: with uncommitted changes and no upstream, the gate refused with both reasons and deployed nothing. The success path wasn't run, because it uploads.

## Development procedure (draft for the engineering lead)

1. **Requirements and threat review.** A change that touches authentication, authorization, classification, publication, audit, plugins or schema (the CODEOWNERS paths) states its security requirement in the pull request. Either add or update an `SR-` entry with its test, or say which existing entry covers it. Trust-boundary changes (new public route, new outbound destination, new plugin capability) get a short threat note in the pull request: what an attacker controls, and what refuses them.
2. **Code review.** Every change reaches `main` through a pull request approved by someone other than the author. A CODEOWNERS path needs its owner, and an approval is dismissed when new commits are pushed.
3. **Test acceptance.** CI's `verify`, `upgrade-path` and `audit` jobs and CodeQL all pass on the final commit. A security fix adds a regression test, plus its register entry where it's a requirement.
4. **Vulnerability handling.**
   - Proposed fix windows: Dependabot and CodeQL findings fixed within 7 days for critical, 30 for high and 90 for medium.
   - An exception needs a dated, owned entry in the restricted evidence system with:
     - advisory or alert id;
     - affected path, and why it isn't reachable or how it's mitigated;
     - owner;
     - expiry no later than 90 days.
   - The weekly CodeQL run and Dependabot are the triage inputs. The triage owner records each disposition.
5. **Environments.** Development is local (`wrangler dev --local`, synthetic data). Production runs per site. **A staging Worker with its own D1, R2 and secrets is needed** before the staged drills can run. It must never share production credentials or data.
6. **Deployment authorization.**
   - Production deploys only through `npm run deploy` from a reviewed, pushed commit.
   - The Cloudflare API tokens able to deploy are limited to named release approvers (W9).
   - Each deploy is recorded with commit, version id, approver and time.
7. **Rollback.**
   - Code: `npx wrangler versions list` to find the previous version by its commit tag, then `npx wrangler rollback <version-id> -m "<reason>"`.
   - Schema: migrations are forward-only. Before releasing a migration, run `npm run check:upgrade -- --from <deployed commit>`, which reports what the older code can't handle after it. A hazard means the rollback plan must include a data step, or the migration must be split.
   - After a rollback, re-run the W13 exercise's health checks.

## One change, end to end

The representative change is **W13**: signal alerts and review receipts.

| Step | Evidence | State |
|---|---|---|
| Requirement | W13 row of the compliance plan. Became SR-16 in the register, tied to two tests in [incident-exercise.test.ts](../test/incident-exercise.test.ts) | Done |
| Implementation | Commit `b18e9fb` on `claude/w13-incident-readiness` | Done |
| Tests | Full suite, 97 files and 3,482 tests, on the branch before merge | Pass |
| Review | Merged into `main` as `d0241fb` by the author's session. **No pull request and no second reviewer** | **Gap**: review not enforced |
| CI | `d0241fb` wasn't on `origin/main` when this was written, so CI hadn't run it | **Pending** until pushed |
| Deploy | Not deployed. Under the new gate it would be refused until pushed, then tagged `d0241fb…` | Not run |
| Rollback | No schema change, so code rollback alone is enough. The drill against the previous revision found 0 hazards (`check-upgrade-path --from 50aa0b4`). The same drill for W12's migration also found 0 hazards (`--from 883df7c`): its tables are additive, so older code ignores them | Schema side rehearsed. The Cloudflare rollback itself wasn't run |

What the walk shows: requirements, tests and rollback safety are now traceable in the repository. Review, CI on the exact commit, deployment approval and the platform rollback aren't, until the settings below exist.

## What W14 still needs from people

1. **The repository administrator turns on branch protection for `main`:**
   - pull request required, with 1 approval from someone other than the author, and stale approvals dismissed;
   - code-owner review required once CODEOWNERS rules are uncommented with real owners;
   - required checks: `verify`, `upgrade-path`, `audit`, CodeQL `analyze`;
   - no force-push or deletion, and no admin bypass, or bypass recorded as an exception.

   Then confirm all this, and that CodeQL and Dependabot alerts are being triaged, from the GitHub settings. That couldn't be checked from here.
2. **The security owner names the triage owner,** and approves the fix windows and exception format.
3. **The platform owner creates a staging environment** and limits deploy-capable Cloudflare tokens to release approvers.
4. **The engineering lead approves the procedure above.** Then walk the next real change through a pull request, CI, a staged deploy and a staging rollback, recording each step.
5. **Move CI's upgrade floor** (`--from f9719a3`) once deployed revisions are known. The deploy tags make them readable from now on.

The ISO/IEC 27034 matrix being drafted alongside this work covers the wider application-security framework: target trust levels, control selection and release verification. This record doesn't replace it. Its release-gate and dependency-policy rows are where these gates would feed.
