# ESM Migration

> **Status:** Nice-to-have / developer-experience refinement — not a
> bug. The app works correctly today. Funds are never at risk. This
> is a forward-looking modernization, not a fix.

Move the server side, tests and scripts from CommonJS (`require` /
`module.exports`) to ESM (`import` / `export`). The dashboard modules in
`public/` are ESM already; esbuild bundles them.

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
- Replace the test stub-injection patterns: `Module.prototype.require`
  (about thirty test files, among them
  `test/position-history-scan-bound.test.js`) and `global.ethers`
  (`test/position-detector.test.js`), with injected parameters or a
  dedicated mock loader. ESM modules cannot be patched the same way.
- Audit `node:test` mocking: `mock.module()`, still experimental in
  Node 22, is the ESM counterpart.
- Bump ESLint config (`sourceType: "module"`).
- Run any remaining `global-require` cleanup FIRST so there are no
  lazy `require()` ambushes during the migration.
