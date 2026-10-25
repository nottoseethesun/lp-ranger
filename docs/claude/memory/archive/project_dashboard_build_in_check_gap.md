---
name: Dashboard build not run by `npm run check`
description: CLOSED 2026-05-02 — n/no-missing-import + n/no-missing-require now catch broken dashboard import paths in lint
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T05:24:12.605Z
---
**Status: CLOSED 2026-05-02 via PR #118 (commit a5b4760).**

The gap was: `npm run check` ran ESLint + node:test + audits but never
invoked `npm run build` (esbuild). ESLint had no path-resolution rule
wired in, and tests only imported `src/lib/` + `test/` — never the browser
bundle. So a broken `import` in `src/client/web/dashboard-*.js` (e.g. after a
file rename) passed both local check AND CI green, then blew up the
moment esbuild ran.

**Closing fix (PR #118):** wired `eslint-plugin-n`'s built-in
`n/no-missing-import` (dashboard ESM block) and `n/no-missing-require`
(`src/lib/`/`scripts/`/`util/` CommonJS block) in `eslint.config.js`. No
new dependencies. Guarded against future config-disable regressions by
`test/eslint-config-import-resolution.test.js`. Same PR also added
`build-info.js` generation to `precheck`/`prelint` — the new rule
itself surfaced that gap in fresh checkouts.

**Concrete miss this closed:** PR #116 (2026-05-02) renamed
`dashboard-lifetime-panel.js` → `dashboard-manage-badge.js` but a
caller's import wasn't updated. Both pre-merge CI runs passed green.
Caught on the next live restart. Same class of bug now fails lint
immediately.

**Roadmap entry deleted:**
`docs/roadmap/nice-to-haves/project_check_includes_dashboard_build.md`
was removed when the gap closed.
