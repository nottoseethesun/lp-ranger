# Best Practices

## Code Quality

- **No band-aid fixes** — fix the root cause, not the symptom. If a display shows wrong data, fix the data source, not the display layer. When fixing a bug, always search for the same pattern elsewhere in the codebase before considering it done — a single symptom fix should trigger an audit for the same class of bug.
- **Consolidate duplication on contact** — when adding a cross-cutting concern (locking, caching, rate limiting) that applies to an operation done in multiple places, consolidate the duplicated codepaths into one shared function FIRST, then add the concern once. Do not add parallel implementations that don't coordinate. Grep for ALL call sites of the underlying operation before implementing.
- **Functional pattern for new code** — no classes, no mutable object state scattered across instances. Functions receive data, return results. When a data source changes, all dependent code runs with the fresh data from the source of truth. Existing code is not refactored to this pattern.
- **Read all comments before touching code** — file-header JSDoc, function comments, and inline comments document design decisions and data sources (e.g. GeckoTerminal for historical prices, HODL baseline from IncreaseLiquidity events). Understand them before making any changes.
- **Show dashes (---) for missing data, not $0.00** — when a value hasn't been computed yet (e.g. IL before HODL baseline resolves), display --- instead of a false zero.

## Formatting & Line Limits

- **NEVER compact code to fix line count** — compacting undoes Prettier formatting and destroys readability. When a file exceeds the 500-line `max-lines` lint rule, the ONLY acceptable solution is to split the file into a new module. Never merge lines, collapse structures, remove whitespace, or otherwise condense code to fit within the limit.
- **No backwards compatibility** — never add migration code, version discriminators, fallback paths, or legacy support unless explicitly ordered. When changing data formats or config schemas, just change them. If old data is incompatible, let it fail cleanly (return empty/default).

## Test Isolation

- **Tests must NEVER overwrite production files** — any test that touches files in `tmp/` or the project root (`.bot-config.json`, `pnl-epochs-cache.json`, `historical-price-cache.json`, etc.) must snapshot the file in a `before` hook and restore it in an `after` hook. Deleting a production cache file in a test `afterEach` destroys the user's cached data and forces expensive multi-minute reconstruction on next restart.
- **Audit ALL test files after adding new caches or config files** — when a new disk-backed cache or config file is added, search all test files (`grep -rn "filename" test/`) to verify no test deletes or overwrites it without snapshot/restore. A single unprotected test file can silently destroy hours of cached data on every `npm run check` (including pre-commit hooks).
- **In-memory singletons must also be restored** — if a test imports a module that has a module-level singleton (e.g. `_diskConfig` in `server.js`), the `after` hook must restore the in-memory object to match the restored file. Otherwise, subsequent `saveConfig` calls re-write stale test data over the restored production file.
- **Use temp directories for test-specific files** — tests that create their own config/cache files should use `os.tmpdir()` or `fs.mkdtempSync()`, not the project's `tmp/` directory. Pass the `dir` parameter to functions that support it (e.g. `saveConfig(cfg, dir)`, `loadConfig(dir)`).

## Debugging & Investigation

- **Trace the COMPLETE data flow before writing fixes** — do not make incremental guesses. Read every function in the chain from trigger to effect. Identify the exact line where the bug manifests. A fix that addresses the wrong layer creates a new bug.
- **Use definitive boolean/status fields** — never use heuristic guesses for detection. When tracking state (e.g. "has lifetime data loaded?"), use an explicit flag set at the moment the event occurs, not an inference from secondary signals.
- **Log hashes with a space after `=`** — write `hash= %s` not `hash=%s` so the hash is a separate word that can be double-click-copied in the terminal. Applies to all TX hashes, cancel hashes, and any hex value a developer might need to copy.

## UI & Display

- **No skeuomorphic icons** — avoid emoji icons that mimic real-world objects (folders, keys, magnifying glasses). Use minimal inline SVG or Unicode geometric symbols instead. Icons should be abstract, clean, and consistent with the dashboard's dark terminal aesthetic.
- All date/time displays show both UTC and local time with timezone code.
- All custom CSS classes prefixed with `9mm-pos-mgr-`.
- No inline `style="..."` in HTML (except dynamic JS-set `width` values).

## Dependencies & Tooling

- **Never use `npx`** — always use `npm` (e.g. `npm run lint`, not `npx eslint`).
- **Prefer well-known npm packages** for anything mildly specialized (e.g. Uniswap v3 math, NFT reading, token decoding) rather than hand-rolling custom implementations.
- **Always provide Swagger or equivalent API documentation** for HTTP endpoints. The OpenAPI 3.0 spec lives in `docs/openapi.json`. When adding, removing, or changing an API endpoint, update the spec to match. Run `npm run swagger` to verify the docs render correctly.

## Git & CI

- **CI before merge** — always push the branch to GitHub first and wait for CI (GitHub Actions) to pass before merging to main. Never merge to main with failing or untested CI.
- **Stay on the feature branch** — never checkout main or merge until the user explicitly says to. After CI passes, inform the user and wait. The user must manually test before giving the merge order.
