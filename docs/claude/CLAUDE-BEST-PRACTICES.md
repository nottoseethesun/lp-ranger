# Best Practices

## Core Essentials

Highest-priority rules. Violations here are deal-breakers — review every PR for them first.

- **NEVER mirror code — anywhere, for any reason.** A "mirror" is a copy-paste re-expression of an existing function into a second location — most commonly a test file that re-implements the SUT locally to sidestep an import obstacle, but the rule applies just as much to a runtime module that duplicates logic from another. Mirrors silently drift: a green test says nothing about whether the SUT still works, and a duplicated runtime path guarantees one side falls behind on the next fix. **If a private helper needs a caller (test or otherwise), extract it as an exported pure decision** and drive the export directly; leave I/O and side effects in a thin wrapper. This is absolute — no "mirror is small enough to keep in lockstep by inspection" exceptions. Smell markers: docstrings that say `Mirror of …`, `In-test replica`, `re-implement`, or any local function whose body is byte-for-byte identical to one elsewhere. See [CLAUDE-TESTING.md § No Mirroring](CLAUDE-TESTING.md#no-mirroring) for the test-specific extract-then-test pattern with templates.
- **NEVER modify standard JS globals.** Do not reassign or wrap `console.log` / `console.warn` / `console.error` / `console.debug` / `console.info`, `Array.prototype.*`, `Date`, `Math`, `fetch`, `window.*`, or any other built-in. This includes "install" / "patch" helpers that wrap a global at startup. Why: (1) **clashes with other libraries** — any third-party module that also wraps the same global either double-wraps or shadows the other's wrapping, and in tests mocking libraries that replace `console.*` will collide; (2) **security** — patched globals make it impossible for a reviewer to trust that `console.log(secret)` only writes to stdout. When you need cross-cutting behaviour (timestamps, structured fields, redaction, color), build a thin **opt-in wrapper module** (e.g. `src/log.js` exporting `log.info`/`warn`/`error`); callers `require()` it explicitly. In production code the rule is absolute — there are no grandfathered exceptions (the original `installColorLogger()` exception was retired by folding its tag-color table into `src/log.js`).

  **One exception, test code only, and only where unavoidable.** A test may replace a global when there is genuinely no other way to reach the behaviour under test — controlling the clock to age something out of a time window is the case that keeps arising. Unavoidable means what it says: if the module under test offers an injection seam, use that (`log._setSinkForTests`, `bot-provider._setDelaysForTests`, `price-source-backoff._setDelays`), and if it does not but easily could, add one and use it. When a swap is genuinely the only way, **capture the original before the swap and restore it in a `finally`**, so a failing assertion cannot leak the patched global into the rest of the file. Restore it immediately after the call that needed it, not at the end of the suite.

  **Every such swap carries a comment saying so**, opening with the literal words `TEST-ONLY global swap:` followed by why no seam exists. The fixed opener is what makes the exception auditable — one grep finds every use, and a swap without one reads as an oversight rather than a decision. The comment also states that the original is restored pristine immediately, so a reader of the swap does not have to scroll to the `finally` to learn whether it is:

  ```js
  /*- TEST-ONLY global swap: ageing a sample out of the window needs the
   *  clock, and there is no seam for it. Restored pristine in the
   *  `finally` below, immediately after the call that needed it. */
  const realNow = Date.now;
  Date.now = () => nowMs;
  ```

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

## CLI Tools

- **Never hand-roll argument parsing. Use `commander`.** No `argv.indexOf`, no `startsWith("--")` scanning, no hand-written `USAGE` string. Declare the command once — name, description, each `.option()` with its default — and the help is generated from that declaration, so the two cannot drift. A parser also catches what hand-rolling misses: unknown flags, missing option values.
- **Every CLI answers `--help` and `-h`, and is not finished until it does.** Applies to `util/` tools and `scripts/` alike. Commander does this for free, to stdout, exiting 0, ahead of any validation — which is the right order, since someone reaching for `--help` is unsure of the arguments and must not be refused for omitting one.
- **Help goes to stdout and exits 0; an argument mistake goes to stderr and exits non-zero.** Reversing them breaks `tool --help | less` and any script reading the exit status.
- **Validate option values inside the parser** — a function as `.option()`'s third argument, throwing `InvalidArgumentError`. Commander then names the option in the message and refuses before the tool works. Accepting a bad value instead surfaces it later as a failure that never mentions the flag.
- **Lead the description with what the tool is for**, not how to spell a flag. Put exit codes and trailing notes in `.addHelpText("after", …)`.
- **Build the command inside a function**, not at module scope, so a test can parse several argument lists without options accumulating.
- **A diagnostic that may be run against a live install imports nothing from `src/`** — loading the app's config opens the log file and reads operator settings. Accept a duplicated default over that, and say so in the file header.

## UI & Display

- **No skeuomorphic icons** — avoid emoji icons that mimic real-world objects (folders, keys, magnifying glasses). Use minimal inline SVG or Unicode geometric symbols instead. Icons should be abstract, clean, and consistent with the dashboard's dark terminal aesthetic.
- All date/time displays show both UTC and local time with timezone code.
- All custom CSS classes prefixed with `9mm-pos-mgr-`.
- No inline `style="..."` in HTML (except dynamic JS-set `width` values).
- **Static markup, targeted data updates** — put icons, buttons, and structural markup in the HTML. JS should only update data values by targeting specific text containers (e.g. a `<span id="statT0Name">`), never rewrite innerHTML of a parent that contains static elements. This prevents poll cycles from destroying icons/buttons and avoids re-creating DOM nodes that don't change.

## HTTP Caching

- **HTML files: never cache** — serve with `Cache-Control: no-cache, no-store, must-revalidate`, `Pragma: no-cache`, `Expires: 0`. This ensures the browser always fetches fresh HTML, which contains the cache-bust query string for JS/CSS bundles. Note: `no-cache` alone does NOT mean "don't cache" — it means "cache but revalidate." `no-store` is required to actually prevent caching.
- **Versioned assets (JS, CSS, fonts): long-lived immutable caching** — serve with `Cache-Control: public, max-age=31536000, immutable`. Freshness is handled by the cache-bust query string (`bundle.js?v=<timestamp>`) in the HTML, which changes on every build.

## Documentation

- **Technical docs describe how the system works, not how it came to work that way.** Never recount a past bug in one. No "used to", "previously", "this was broken", "the fix caught two of the four sites", no narrative of who found what when. A reader needs the current mechanism and the constraint it satisfies; the story of the defect is noise they must read past to reach it, and it dates the document the moment anything changes. The sole exception is a document whose stated purpose *is* a root-cause analysis.
- **Replace a removed story with the mechanism, not with nothing.** A bug narrative is usually carrying the reason a rule exists, so deleting it outright loses information. Keep the reason, drop the incident: state the invariant, what breaks if it is violated, and where it is enforced. "A lower bound above an NFT's first event drops those events, and the caller reads the short result as *the event never fired*" is the reason; "we got this wrong four times" is not.
- **No adjective-and-analogy substitutes for explanation.** Do not write that something is "load-bearing", "surprisingly subtle", or "a footgun" and stop there. Name the actual mechanism: what calls what, what value flows where, what fails. If the explanation cannot be written concretely, it is not yet understood well enough to document.
- **History belongs in git and in `docs/claude/memory/`.** Commit messages carry the incident and the diagnosis. Memory files carry decisions and user preferences. Neither is a reason to duplicate that material into a reference doc.

## Dependencies & Tooling

- **Never use `npx`** — always use `npm` (e.g. `npm run lint`, not `npx eslint`).
- **Prefer well-known npm packages** for anything mildly specialized (e.g. Uniswap v3 math, NFT reading, token decoding) rather than hand-rolling custom implementations.
- **Always provide API documentation** for HTTP endpoints. The OpenAPI 3.0 spec lives in `docs/openapi.json`. When adding, removing, or changing an API endpoint, update the spec to match. Run `npm run api-doc` to verify the docs render correctly (Scalar, on port 5556).

## Git & CI

- **CI before merge** — always push the branch to GitHub first and wait for CI (GitHub Actions) to pass before merging to main. Never merge to main with failing or untested CI.
- **Stay on the feature branch** — never checkout main or merge until the user explicitly says to. After CI passes, inform the user and wait. The user must manually test before giving the merge order. This governs **step 3** of [CLAUDE-CI.md](CLAUDE-CI.md#the-eight-steps), the local merge-to-main check: that step exists and is useful, but it leaves the feature branch, so it is offered and never assumed. "Push the branch" is not permission for it.
