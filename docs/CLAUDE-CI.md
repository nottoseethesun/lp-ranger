# CI and Merge Protocol

Companion to [CLAUDE.md](../CLAUDE.md). Defines the exact steps for
getting code from a feature branch into `main`. The remote must
**always stay clean** — no failures should ever appear on GitHub.

---

## The Eight Steps

| Step | What | Command / Action |
| ---- | ---- | ---------------- |
| **1** | Fix on feature branch | Never commit directly to `main` |
| **2** | Local check on feature branch | `npm run check` (lint + tests + coverage + security) |
| **3** | Local merge-to-main check | `git checkout main && git merge <branch>` then `npm run check` — verifies the merged result passes locally before touching the remote |
| **4** | Undo local merge | `git reset --hard origin/main` — main stays clean locally |
| **5** | Push branch to GitHub | `git push -u origin <branch>` — remote CI runs automatically |
| **6** | PR + merge on GitHub | `gh pr create` then `gh pr merge --merge --delete-branch` — never squash; preserve full commit history |
| **7** | Pull main locally | `git pull origin main` |
| **8** | Verify main CI green | `gh run list -b main -L 2` — confirm the merge commit's CI passes on main before starting new work |

### Why this order?

- **Step 2** catches issues before they touch any shared state.
- **Steps 3–4** catch merge conflicts and integration failures locally,
  then undo the local merge so main stays at `origin/main`. The remote
  CI in step 5 should never fail because step 3 already verified it.
- **Step 6** merges via PR on GitHub (not a direct push) so that
  branch protection rules — 6 required status checks — gate the merge.
- The principle: the remote is a shared resource. All breakage stays
  local.

---

## What `npm run check` Covers

`npm run check` (`scripts/check.sh`) is the single local gate. It runs:

| Check | Detail |
| ----- | ------ |
| **ESLint** | JS lint (`src/`, `test/`, `server.js`, `bot.js`, dashboard files, eslint-rules) — 0 warnings |
| **stylelint** | CSS lint (`public/*.css`) |
| **markdownlint** | Markdown lint (`README.md`, `CLAUDE.md`, `docs/*.md`) |
| **Tests** | `node --test test/*.test.js` — all must pass |
| **Coverage** | 80% line coverage minimum |
| **Security: deps** | `npm run audit:deps` — no high-severity CVEs |
| **Security: lint** | `npm run audit:security` — eslint-plugin-security |
| **Security: secrets** | `npm run audit:secrets` — secretlint scan |

All eight checks must pass for `npm run check` to exit 0.

---

## Rules

- **Never push main directly.** The merge to `main` always happens on
  GitHub through a PR.
- **Never commit to main.** Always fix on the feature branch first.
- **Run Prettier before commit.** Run `npm run lint:fix` on changed files
  before committing, then re-run `npm run check`.  Prettier
  can expand compact lines past the 500-line `max-lines` limit.  The
  pre-commit hook runs Prettier automatically, but by then `npm run check`
  has already passed on the pre-Prettier version.  Running Prettier first
  ensures the line count check is accurate.
- **Never skip local checks.** Run `npm run check` before every push.
- **Never merge a red branch.** Wait for remote CI to pass before
  creating the PR merge.
