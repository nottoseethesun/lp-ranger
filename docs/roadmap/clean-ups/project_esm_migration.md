# ESM Migration

> **Status:** Nice-to-have / developer-experience refinement — not a
> bug. The app works correctly today. Funds are never at risk. This
> is a forward-looking modernization, not a fix.

Move the codebase from CommonJS (`require` / `module.exports`) to
ESM (`import` / `export`).

**Why:** ESM is the modern Node default; ESM-only ecosystem packages
keep landing; static `import` enables better tree-shaking, top-level
await, and cleaner test mocking patterns.

## Rough plan

Treat as a dedicated branch — DO NOT mix with feature work.

- Add `"type": "module"` to package.json (or rename source files to
  `.mjs`); decide policy.
- Convert every `require()` → `import` and every `module.exports` →
  `export` across `src/`, `test/`, `scripts/`, `server.js`,
  `bot.js`, `eslint-rules/`.
- Add `.js` extensions to all relative imports (ESM requires them).
- Replace `__dirname`/`__filename`/`require.resolve` with
  `import.meta.url` equivalents.
- Replace the `Module.prototype.require` test stub-injection pattern
  (used in e.g. `test/position-history-scan-bound.test.js`,
  `test/position-detector.test.js` via `global.ethers`) with proper
  DI parameters or a dedicated mock loader. ESM modules can't be
  patched the same way.
- Audit `node:test` mocking — `test.mock.module` (Node 22+) is the
  canonical ESM equivalent.
- Bump ESLint config (`sourceType: "module"`).
- Run any remaining `global-require` cleanup FIRST so there are no
  lazy `require()` ambushes during the migration.
