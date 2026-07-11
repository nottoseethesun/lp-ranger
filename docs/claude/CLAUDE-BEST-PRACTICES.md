# Best Practices

## Core Essentials

Highest-priority rules. Violations here are deal-breakers — review every PR for them first.

- **NEVER modify standard JS globals.** Do not reassign or wrap `console.log` / `console.warn` / `console.error` / `console.debug` / `console.info`, `Array.prototype.*`, `Date`, `Math`, `fetch`, `window.*`, or any other built-in. This includes "install" / "patch" helpers that wrap a global at startup. Why: (1) **clashes with other libraries** — any third-party module that also wraps the same global either double-wraps or shadows the other's wrapping, and in tests mocking libraries that replace `console.*` will collide; (2) **security** — patched globals make it impossible for a reviewer to trust that `console.log(secret)` only writes to stdout. When you need cross-cutting behaviour (timestamps, structured fields, redaction, color), build a thin **opt-in wrapper module** (e.g. `src/log.js` exporting `log.info`/`warn`/`error`); callers `require()` it explicitly. Rule is absolute — there are no grandfathered exceptions in the codebase (the original `installColorLogger()` exception was retired by folding its tag-color table into `src/log.js`).

## Code Quality

- **No band-aid fixes** — fix the root cause, not the symptom. If a display shows wrong data, fix the data source, not the display layer. When fixing a bug, always search for the same pattern elsewhere in the codebase before considering it done — a single symptom fix should trigger an audit for the same class of bug.
- **Consolidate duplication on contact** — when adding a cross-cutting concern (locking, caching, rate limiting) that applies to an operation done in multiple places, consolidate the duplicated codepaths into one shared function FIRST, then add the concern once. Do not add parallel implementations that don't coordinate. Grep for ALL call sites of the underlying operation before implementing.
- **Functional pattern for new code** — no classes, no mutable object state scattered across instances. Functions receive data, return results. When a data source changes, all dependent code runs with the fresh data from the source of truth. Existing code is not refactored to this pattern.
- **Read all comments before touching code** — file-header JSDoc, function comments, and inline comments document design decisions and data sources (e.g. GeckoTerminal for historical prices, HODL baseline from IncreaseLiquidity events). Understand them before making any changes.
- **Show dashes (---) for missing data, not $0.00** — when a value hasn't been computed yet (e.g. IL before HODL baseline resolves), display --- instead of a false zero.

## Type Checks

**For type checks, never rely on JavaScript's built-in type conversions.** Write the check explicitly.

Do NOT use these "sloppy" idioms as a stand-in for a real type check:

- `if (x)` — treats `0`, `""`, `false`, `null`, `undefined`, `NaN`, `0n` all as absent. Fine for "is this string non-empty?"; wrong for "is this value present?"
- `if (x != null)` — blocked by the project's `eqeqeq: ["error", "always"]` lint rule.
- `if (x !== undefined)` **alone** — silently lets `null` through. Then `String(null) === "null"` (the string) corrupts downstream comparisons like `isPositionClosed`.
- `x || defaultValue` — treats every falsy value as absent, hiding legitimate `0` / `0n` / `""` / `false`. Only use `||` when you actually want falsy-fallback semantics; for "null/undefined only", use `??`.
- `Number(x)` / `String(x)` on a value of ambiguous type without first checking what `x` is. `String(null)` is `"null"`, `Number("")` is `0` — neither is what a caller usually means.

DO use explicit checks:

```js
// "value present" (neither undefined nor null):
if (x !== undefined && x !== null) { ... }

// "value is a string":
if (typeof x === "string") { ... }

// "value is a canonical zero" (matches `isPositionClosed` semantics):
if (x !== undefined && x !== null && String(x) === "0") { ... }

// "coalesce ONLY null/undefined to a default" (`??` is an explicit
// null/undefined check — different from `||`):
const v = x ?? defaultValue;
```

Ten-plus explicit `!== undefined && !== null` guards already exist across the codebase (`dashboard-history.js:203`, `position-detector.js:272-273`, `dashboard-data.js:193`, etc.) — this section codifies that as the standard.

## Formatting & Line Limits

- **NEVER compact code to fix line count** — compacting undoes Prettier formatting and destroys readability. When a file exceeds the 500-line `max-lines` lint rule, the ONLY acceptable solution is to split the file into a new module. Never merge lines, collapse structures, remove whitespace, or otherwise condense code to fit within the limit.
- **No backwards compatibility** — never add migration code, version discriminators, fallback paths, or legacy support unless explicitly ordered. When changing data formats or config schemas, just change them. If old data is incompatible, let it fail cleanly (return empty/default).

## Test Isolation

- **Tests must NEVER overwrite production files** — any test that touches files in `tmp/`, `app-config/user-configurable/` (`bot-config.json`, `wallet.json`, `api-keys.json`), or `app-data/` (`rebalance_log.json`), or specific tmp caches (`pnl-epochs-cache.json`, `historical-price-cache.json`, etc.) must snapshot the file in a `before` hook and restore it in an `after` hook. Deleting a production cache file in a test `afterEach` destroys the user's cached data and forces expensive multi-minute reconstruction on next restart.
- **Audit ALL test files after adding new caches or config files** — when a new disk-backed cache or config file is added, search all test files (`grep -rn "filename" test/`) to verify no test deletes or overwrites it without snapshot/restore. A single unprotected test file can silently destroy hours of cached data on every `npm run check` (including pre-commit hooks).
- **In-memory singletons must also be restored** — if a test imports a module that has a module-level singleton (e.g. `_diskConfig` in `server.js`), the `after` hook must restore the in-memory object to match the restored file. Otherwise, subsequent `saveConfig` calls re-write stale test data over the restored production file.
- **Use temp directories for test-specific files** — tests that create their own config/cache files should use `os.tmpdir()` or `fs.mkdtempSync()`, not the project's `tmp/` directory. Pass the `dir` parameter to functions that support it (e.g. `saveConfig(cfg, dir)`, `loadConfig(dir)`).
- **NEVER run `npm run check` inside a sub-agent** — `check.js` backs up production files (`app-config/user-configurable/bot-config.json`, epoch caches, etc.) and restores them via a try/finally block around the test run. Sub-agents may be killed mid-process (timeout, SIGKILL), bypassing the restore step and destroying production data. Always run `npm run check` directly in the main session where the process lifecycle is controlled.

## Coverage

- **Maintain coverage at least 1% above the minimum** — Node 22 and Node 24 report slightly different coverage numbers due to instrumentation differences. If local coverage is at 80.01% (minimum 80%), it may report 79.97% on CI. Always ensure coverage is at least 81% locally to avoid CI flakes from rounding variance.

## RPC & Network

- **Never duplicate RPC calls** — when multiple features need the same on-chain data (e.g. IncreaseLiquidity events for both compound detection and HODL baseline), fetch once and pass the results to all consumers. RPC calls are slow, rate-limited, and costly at scale. Design data-fetching as a separate layer from classification/business logic so the same raw data can be reused. This is a high priority in all designs.

## Debugging & Investigation

- **Trace the COMPLETE data flow before writing fixes** — do not make incremental guesses. Read every function in the chain from trigger to effect. Identify the exact line where the bug manifests. A fix that addresses the wrong layer creates a new bug.
- **Use definitive boolean/status fields** — never use heuristic guesses for detection. When tracking state (e.g. "has lifetime data loaded?"), use an explicit flag set at the moment the event occurs, not an inference from secondary signals.
- **Log hashes with a space after `=`** — write `hash= %s` not `hash=%s` so the hash is a separate word that can be double-click-copied in the terminal. Applies to all TX hashes, cancel hashes, and any hex value a developer might need to copy.

## UI & Display

- **No skeuomorphic icons** — avoid emoji icons that mimic real-world objects (folders, keys, magnifying glasses). Use minimal inline SVG or Unicode geometric symbols instead. Icons should be abstract, clean, and consistent with the dashboard's dark terminal aesthetic.
- All date/time displays show both UTC and local time with timezone code.
- All custom CSS classes prefixed with `9mm-pos-mgr-`.
- No inline `style="..."` in HTML (except dynamic JS-set `width` values).
- **Static markup, targeted data updates** — put icons, buttons, and structural markup in the HTML. JS should only update data values by targeting specific text containers (e.g. a `<span id="statT0Name">`), never rewrite innerHTML of a parent that contains static elements. This prevents poll cycles from destroying icons/buttons and avoids re-creating DOM nodes that don't change.

## HTTP Caching

- **HTML files: never cache** — serve with `Cache-Control: no-cache, no-store, must-revalidate`, `Pragma: no-cache`, `Expires: 0`. This ensures the browser always fetches fresh HTML, which contains the cache-bust query string for JS/CSS bundles. Note: `no-cache` alone does NOT mean "don't cache" — it means "cache but revalidate." `no-store` is required to actually prevent caching.
- **Versioned assets (JS, CSS, fonts): long-lived immutable caching** — serve with `Cache-Control: public, max-age=31536000, immutable`. Freshness is handled by the cache-bust query string (`bundle.js?v=<timestamp>`) in the HTML, which changes on every build.

## Dependencies & Tooling

- **Never use `npx`** — always use `npm` (e.g. `npm run lint`, not `npx eslint`).
- **Prefer well-known npm packages** for anything mildly specialized (e.g. Uniswap v3 math, NFT reading, token decoding) rather than hand-rolling custom implementations.
- **Always provide API documentation** for HTTP endpoints. The OpenAPI 3.0 spec lives in `docs/openapi.json`. When adding, removing, or changing an API endpoint, update the spec to match. Run `npm run api-doc` to verify the docs render correctly (Scalar, on port 5556).

## Git & CI

- **CI before merge** — always push the branch to GitHub first and wait for CI (GitHub Actions) to pass before merging to main. Never merge to main with failing or untested CI.
- **Stay on the feature branch** — never checkout main or merge until the user explicitly says to. After CI passes, inform the user and wait. The user must manually test before giving the merge order.
