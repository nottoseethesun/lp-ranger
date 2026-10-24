# Dashboard Cycle Cleanup

> **Status:** Nice-to-have / structural cleanup — not a bug. Nothing
> breaks at runtime: esbuild bundles the cycles away. Funds are never at
> risk.

The dashboard's modules import each other in circles. On 2026-10-17
`npm run show-dependency-cycles` (madge `--circular` over every `.js`
file) reported **27 circular dependencies, all in
`src/client/web/dashboard-*.js`**, and none in the server-side code. Bundling
hides them, so they cost nothing today; they make the modules harder to
reason about, and nothing stops a new one landing.

## Why fix them

Once `src/client/web/` is clean, `npm run show-dependency-cycles` can become a
step in `scripts/check.js` (and so in CI) that fails on any cycle. Until
then it is an opt-in diagnostic.

## Shape of the work

The 27 paths share most of their edges, so they reduce to a handful of
loops: a few two-module ones, and long chains through two hub modules,
`dashboard-data` and `dashboard-wallet`. Standard tactics:

- Extract a shared state/types module both sides import from (no
  back-edge).
- Invert one direction — turn an import into a callback or parameter
  passed in by the caller.
- Lazy `import()` at one call site (escape hatch, not preferred).

No automated tool recommends fixes; `madge` only diagnoses. Each
cluster needs human judgment about which module is the conceptual
owner of the shared state.

## Suggested order

Module names below drop the `dashboard-` prefix. Re-run the command
first: the list moves as the dashboard changes.

1. **Two-module loops** — `manage-ui ↔ wallet`, `data-status ↔ alerts`,
   `throttle ↔ data-status`, `data ↔ reload-flow`.
2. **The wallet hub** — `wallet → moralis-key → data → wallet`. Most of
   the longer paths pass through it, so it takes the most thought.
3. **The data-events chain** — `data → data-events → positions`, which
   reaches back through `positions-browser`, `manage-check` and
   `manage-ui`.
4. **The data-poll chain** — `data → data-poll → all-positions-stats →
   events-manage → …`, branching to `reopen-flow`, `rebalance-confirm`,
   `compound`, `settings-dialogs`, `token-decimals`, `unmanaged`,
   `unmanaged-apply` and `il-debug`. The largest; left until last, since
   the earlier steps may already break part of it.
5. **`data → bot-settings-sync → per-token-slippage`.**

## Verification

Dashboard tests cover modules one at a time, not the wiring between
them that a cycle break changes. Check each break in the browser before
moving to the next.

## After cleanup

Run `npm run show-dependency-cycles` as a step in `scripts/check.js`,
failing on any cycle, then remove this entry.
