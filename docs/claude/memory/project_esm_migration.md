---
name: ESM migration (replace CommonJS require with import)
description: Nice-to-have / future. Project is 100% CJS today; migrating to ESM is a deliberate big-bang change.
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T05:03:57.510Z
---
Move the codebase from CommonJS (`require` / `module.exports`) to ESM (`import` / `export`).

**Why:** ESM is the modern Node default; ESM-only ecosystem packages keep landing; static `import` enables better tree-shaking, top-level await, and cleaner test mocking patterns. The user explicitly said "we want `import`, never `require`" but agreed the migration is too big to take on right now.

**How to apply:** Treat as a dedicated branch — DO NOT mix with feature work. Rough plan:
- Add `"type": "module"` to package.json (or rename source files to `.mjs`); decide policy.
- Convert every `require()` → `import` and every `module.exports` → `export` across `src/`, `test/`, `scripts/`, `eslint-rules/`.
- Add `.js` extensions to all relative imports (ESM requires them).
- Replace `__dirname`/`__filename`/`require.resolve` with `import.meta.url` equivalents.
- Replace the `Module.prototype.require` test stub-injection pattern (used in e.g. `test/position-history-scan-bound.test.js`, `test/position-detector.test.js` via `global.ethers`) with proper DI parameters or a dedicated mock loader. ESM modules can't be patched the same way.
- Audit `node:test` mocking — `test.mock.module` (Node 22+) is the canonical ESM equivalent.
- Bump ESLint config (`sourceType: "module"`).
- Run the existing `global-require` work (cleanups-high-plains-drifter branch) FIRST so there are no lazy `require()` ambushes during the migration.

**Confirmed via:** Discussed 2026-04-26 during the cleanups-high-plains-drifter branch work — user picked Strategy B (top-of-file CJS) over a full ESM migration, but flagged ESM as the eventual direction.
