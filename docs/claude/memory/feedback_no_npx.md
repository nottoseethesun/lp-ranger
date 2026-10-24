---
name: feedback_no_npx
description: "NEVER use npx — hard rule, violated repeatedly. Check package.json scripts FIRST; a script almost always already exists."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8264efa3-921c-4733-b040-c9845e2b3a5e
  modified: 2026-10-24T05:29:00.571Z
---

NEVER use `npx` under any circumstances. Corrected many times, still recurring
as of 2026-08-04 (used `npx --no-install prettier` when `npm run format:check`
already existed and already covered the exact files).

**Why:** Hard user rule. Every violation is a repeat of a correction the user
has already made, which is why it lands as exasperation rather than a note.

**How to apply:** Before reaching for ANY tool binary, grep `package.json`
scripts for it — the script is almost always already there. Known ones:

- Prettier → `npm run format` / `npm run format:check` (covers `src/*.js`,
  `src/lib/`, `src/client/web/dashboard-*.js`, `scripts/`, `util/`, `test/`,
  `eslint-rules/`)
- ESLint + stylelint + markdownlint → `npm run lint` / `npm run lint:fix`
- Tests → `npm run check` (see [[feedback_never_node_test_directly]]),
  `npm run test:util` for `util/diagnostic/`

If no script exists and one is warranted, ADD it to `package.json` (see
[[feedback_npm_script_100_char_threshold]] — over 100 chars goes in
`scripts/<name>.js`). Otherwise call `./node_modules/.bin/<tool>` directly.
There is never a reason to use `npx` in this project.
