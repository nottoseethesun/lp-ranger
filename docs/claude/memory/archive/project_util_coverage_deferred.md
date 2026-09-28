---
name: project_util_coverage_deferred
description: DONE (2026-08-05) — every util/ module now clears the 80% coverage floor; records the render-split recipe that got them there
metadata:
  node_type: memory
  type: project
  originSessionId: 8264efa3-921c-4733-b040-c9845e2b3a5e
  modified: 2026-08-05T00:43:40.360Z
---

**Resolved 2026-08-05.** Every file under `util/` now clears the 80%
line-coverage floor. Before → after:

- `util/cache/clean-pool-cache.js` 28.6% → 99.2%
- `reconcile-hodl` 60.0% → 84.3% (render.js 100%)
- `wallet-token-flow` 65.7% → 88.1% (render.js 100%)
- `rescan-pool-history.js` 74.3% → 98.6%
- `show-rebalance-chain.js` 77.5% → 86.5%
- `verify-compound-usd/index.js` 77.2% → 83.6%

**The recipe, for the next tool that needs it.** Each `main()` built a
live `JsonRpcProvider`, so none of it could be driven without the
network. Two moves fixed that, and neither required touching the
tools' behaviour:

1. **Split presentation from I/O.** Extract the report half into
   `render.js` — functions that take already-computed data and only
   `console.log`. Console-first tools have their whole product in that
   text, so capturing stdout tests the thing that matters.
2. **Inject paths and collaborators, with defaults equal to today's
   constants.** `loadConfigOrExit(configPath = CONFIG_PATH)`,
   `_applyMutations(..., paths)`, `main(argv, opts)`. The CLI is
   byte-identical; tests point at a scratch directory. This is the
   convention `src/cache-store.js` already used (`fsModule` injection).

Test via console capture with `util/diagnostic/test/_capture.js`
(`captureConsole`, `captureExit`, `fakeProvider`). Extract, never
compact — see [[feedback_never_compact_code]].

**Two things the original note got wrong**, worth remembering as
measurement traps:

- "`clean-pool-cache.js` has 9 lines over 80 columns" — those were
  user-facing string literals, which Prettier never breaks, and the
  count came from `awk length` (bytes). Measured in *characters*, which
  is what Prettier's printWidth uses, `util/` has **zero** over-long
  lines. Box-drawing rulers (`─`) read as over-long in bytes and are
  fine.
- A tool that grows a second file must become a directory with
  `index.js`, not a sibling `foo-render.js` — see
  [[feedback_util_subdir_per_utility]]. `reconcile-hodl/` and
  `wallet-token-flow/` were converted; they now run as
  `node util/diagnostic/<tool>` with no `.js`.
