---
name: project_security_audit_two_tier
description: "Two security-audit workflows; the daily \"Latest Release\" one audits the release tag not main, so it clears only after a release is cut"
metadata: 
  node_type: memory
  type: project
  originSessionId: 53c63b8a-d973-4be1-8005-50ac113c57eb
  modified: 2026-10-04T17:03:01.519Z
---

The repo has **two** dependency-audit workflows, and they audit different things:

- `.github/workflows/security-audit.yml` — runs on push/PR to main, audits **main HEAD** via `npm run audit:deps`.
- `.github/workflows/security-audit-production.yml` "**Security Audit (Latest Release)**" — daily `schedule` (11:55 UTC) + `workflow_dispatch`; resolves the **latest published release tag** via `gh api .../releases/latest`, checks THAT tag out, and audits its lockfile — **not main**.

**Why this matters:** Newly-published npm advisories make the scheduled "Latest Release" audit go red even though no code changed. Fixing main clears the on-push audit but **NOT** the scheduled one — the release tag's lockfile is still vulnerable. The scheduled alert clears only when a **new release** is cut carrying the fixed lockfile. Per [[feedback_never_cut_release]] the user cuts every release; don't cut it yourself.

**Two things make a red run hard to read. Know both before diagnosing one.**

**The branch badge lies.** A scheduled run's badge on the Actions page always shows the default branch, because that is where the workflow *file* was read from — never what was checked out. So a run auditing 0.9.8 displays `main`, sitting directly above a genuinely-main-auditing green run that also displays `main`. Two rows, same badge, different trees. Read the tag off the job's first step instead: `Latest published release: X`.

**The result is not a function of the code.** It is the code against the advisory database on the day it runs, and that database moves on its own. The same immutable 0.9.8 tag audited **green on 2026-10-02 and red on 10-03**, because `braces` began matching its tree in between. A tree that has not changed can start failing, and yesterday's pass proves nothing about today.

**The workflow spells out its own audit command** rather than calling the release's `npm run audit:deps`, and that duplication is deliberate: a release must not define the test it is judged by. 0.9.8's script predates `--omit=dev`, so the 10-03 and 10-04 runs reported fifteen high advisories — five reaching the shipped tree, ten dev-only — and the ten camouflaged the five. The flags in the workflow and in `package.json` are two rules that currently agree, not one rule stated twice; do not collapse them. `--package-lock-only` is there so the gate cannot go red because an old tag's `npm ci` no longer resolves, and so no install script from the dependencies under suspicion runs.

**How to apply** when the "Latest Release" audit fails:

1. Check whether the advisory reaches the **shipped** tree, not just the report. Audit the tag's own lockfile without installing: copy its `package.json` + `package-lock.json` to a scratch dir, then `npm audit --package-lock-only --omit=dev`.
2. Fix the deps on main (see [[feedback_regenerate_lockfile]] — regen lockfile; scoped override only if a parent exact-pins the vuln, as markdownlint-cli2 does for js-yaml).
3. Tell the user a release is required to clear the daily alert; wait for them to cut it.
4. After the release, verify without waiting for the daily schedule: `gh workflow run security-audit-production.yml --ref main`, then `gh run watch <id> --exit-status`.

Example: 2026-07-25 `brace-expansion` + `js-yaml` high advisories tripped it → fixed on main (commit 3157488) → user cut 0.8.13 → manual dispatch of the Latest-Release audit went green. The `elliptic`/`@ethersproject` chain stays as accepted low-severity (below the `--audit-level=high` gate, documented in CLAUDE-SECURITY.md).

Open as of 2026-10-04: 0.9.8 ships the `braces` chain (`braces` → `chokidar` → `hardhat-watcher` → `@uniswap/swap-router-contracts` → `@uniswap/v3-sdk`), five high advisories in its shipped tree. Main is clean — `e51b0a7` added `--omit=dev` plus the scoped `chokidar` override on 10-03. The daily audit stays red until 0.9.9 is published.
