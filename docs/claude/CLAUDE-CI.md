# CI and Merge Protocol

Companion to [CLAUDE.md](../../CLAUDE.md). Defines the exact steps for
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
| **6** | PR + merge on GitHub | `gh pr create` then `gh pr checks <number> --watch` then `gh pr merge --merge` — never squash, never delete branch |
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

`npm run check` (`scripts/check.js`) is the single local gate. It runs:

| Check | Detail |
| ----- | ------ |
| **ESLint** | JS lint (`src/`, `test/`, `server.js`, `bot.js`, dashboard files, eslint-rules) — 0 warnings |
| **stylelint** | CSS lint (`public/*.css`) |
| **markdownlint** | Markdown lint (`README.md`, `CLAUDE.md`, `docs/*.md`) |
| **lint-svg** | `public/icons/*.svg` — strict XML, no `id=` attributes (`scripts/lint-svg.js`) |
| **openapi-sync** | `docs/openapi.json` still matches the code — every registered route documented, every documented route still served, every `POST /api/config` key in its schema, every operation summarised, every tag declared |
| **Tests** | `node --test test/*.test.js` — all must pass |
| **Coverage** | 80% line coverage minimum |
| **Security: deps** | `npm run audit:deps` — no high-severity CVEs |
| **Security: lint** | `npm run audit:security` — eslint-plugin-security |
| **Security: secrets** | `npm run audit:secrets` — secretlint scan |

All of these must pass for `npm run check` to exit 0.

`check.js` does not shell out to `npm run lint` — it invokes each tool
itself, because the report table needs machine-readable output the plain
lint script does not produce. That means the two tool lists are
maintained separately and can drift: `lint-svg` was in `npm run lint`
only, so CI never ran it. Both lists now match. **When you add a lint
tool, add it in both places.**

The **openapi-sync** gate also runs inside `npm run lint`, so the husky
pre-commit hook rejects an API change that leaves the spec behind rather
than letting it reach the remote. It reads the real route registrations
and the real `POSITION_KEYS` / `GLOBAL_KEYS` allowlists, so adding a
route or a config key without documenting it fails locally at step 2.
Source: [`scripts/check-openapi-sync.js`](../../scripts/check-openapi-sync.js);
the update workflow is in `docs/engineering.md` § "API Documentation".

---

## Rules

- **Never push main directly.** The merge to `main` always happens on
  GitHub through a PR.
- **Never commit to main.** Always fix on the feature branch first.
- **Run Prettier before commit.** Run `npm run format` (or
  `npm run lint:fix`) on changed files before committing, then re-run
  `npm run check`.  Prettier can expand compact lines past the 500-line
  `max-lines` limit, so formatting first keeps the line-count check
  accurate.  The pre-commit hook runs `npm run lint`, which now *checks*
  formatting rather than rewriting it — an unformatted file fails the
  commit instead of being silently reformatted underneath a check that
  already passed.
- **Never skip local checks.** Run `npm run check` before every push.
- **Never merge a red branch.** Wait for remote CI to pass before
  creating the PR merge.  Use `gh pr checks <number> --watch` to confirm
  all checks are green before running `gh pr merge`.
- **Never delete a branch.** Do not use `--delete-branch` with
  `gh pr merge`.  Branches are cheap and serve as history.

---

## Release-Cutting Reminder (Claude behavior)

Whenever the user mentions that they are about to cut a release (or
uses similar phrasing such as "I'll cut a release", "cutting release
X.Y.Z", "ready to release"), Claude MUST reply with a short manual
reminder that reads:

> **Reminder: prepend `docs/release-notes-header.md` to the release
> body.** The file holds the standard first-time-install / update
> instructions blockquote that every release ships with. Copy its
> current contents into the top of the GitHub release notes before
> publishing.

The reminder fires even if Claude is not the one cutting the release
(per [[feedback-never-cut-release]] the user always cuts every release
themselves). The purpose is a checklist prompt, not an action Claude
performs.
