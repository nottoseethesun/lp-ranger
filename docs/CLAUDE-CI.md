# CI and Merge Protocol

Companion to [CLAUDE.md](../CLAUDE.md). Defines the exact steps for
getting code from a feature branch into `main`. The remote must
**always stay clean** — no failures should ever appear on GitHub.

---

## The Six Steps

| Step | What | Command / Action |
| ---- | ---- | ---------------- |
| **1** | Fix on feature branch | Never commit directly to `main` |
| **2** | Local check on feature branch | `npm run check` (lint + tests + coverage + security) |
| **3** | Local merge + check | Merge `main` into branch, run `npm run check` to verify integration |
| **4** | Push branch to GitHub | `git push -u origin <branch>` — remote CI runs automatically |
| **5** | PR + merge on GitHub | `gh pr create` then `gh pr merge` — branch protection enforces status checks |
| **6** | Pull main locally | `git pull origin main` |

### Why this order?

- **Step 2** catches issues before they touch any shared state.
- **Step 3** catches merge conflicts and integration failures locally,
  so the remote CI in step 4 should never fail.
- **Step 5** merges via PR on GitHub (not a direct push) so that
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
| **markdownlint** | Markdown lint (`README.md`, `CLAUDE.md`, `docs/CLAUDE-SECURITY.md`) |
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
- **Never skip local checks.** Run `npm run check` before every push.
- **Never merge a red branch.** Wait for remote CI to pass before
  creating the PR merge.
