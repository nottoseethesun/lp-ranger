---
name: feedback-full-repo-grep
description: "When doing a rename refactor or auditing a repo-wide pattern, grep the WHOLE repo, not just src/ + test/ + docs/. The non-obvious dirs that get missed: util/, package.json, .prettierignore, .env*, src/client/web/HTML, GitHub Actions YAML."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-24T05:23:58.808Z
---

When sweeping for stale path references during a rename refactor
(e.g. moving `app-config/.bot-config.json` to
`app-config/user-configurable/bot-config.json`), grep the WHOLE
repository — not just the obvious code directories.

**Why:** During the 0.8.2 `app-config/` reorg, the first audit
briefing covered `src/`, `scripts/`, `test/`, `docs/`, `README.md`,
`.gitignore`, `.github/workflows/release.yml`. That left
**five categories of files** with stale paths that the user later
caught manually or via a broader follow-up audit:

- **`util/` subtree** — diagnostic scripts with runtime
  `CONFIG_PATH` constants (functional breaks, not just rot).
- **`package.json` npm scripts** — `clean` / `dev-clean` / `clean:log`
  `rm -f`-ing the old paths (silent failures: user runs `npm run
  clean`, files don't actually get cleaned).
- **`.prettierignore`** — ignore-list entries.
- **`.env.example`** — operator-facing documentation.
- **`src/client/web/*.html`** — user-facing help pages.

**How to apply:**

- When briefing an audit fork or doing a sweep yourself, default
  to repo-wide `grep -rn PATTERN .` with explicit excludes
  (`--exclude-dir=node_modules`, `--exclude-dir=.git`,
  `--exclude-dir=tmp`, `--exclude-dir=test/report-artifacts`,
  `--exclude-dir=src/client/web/dist`) rather than enumerating an
  allowlist of "code dirs".
- For audit fork briefings specifically: explicitly call out
  `util/`, `package.json` (npm scripts AND dependencies), root-level
  configs (`.prettierignore`, `.eslintrc*`, `.env*`), `src/client/web/*.html`,
  GitHub Actions YAML. Otherwise the fork will inherit my blind spot
  and miss the same files I would have.
- For rename refactors that touch shell commands (`rm`, `cp`, `mv`,
  `tar --exclude`), grep `package.json`, `.github/workflows/*.yml`,
  `scripts/*.sh`, and `.husky/` separately — these tend to embed
  paths as string literals rather than as `require`/`import`s, so
  they don't show up in code-only sweeps.
