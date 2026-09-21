# Dashboard Cycle Cleanup

> **Status:** Nice-to-have / developer-experience refinement — not a
> bug. The app works correctly today. Funds are never at risk. The
> circular imports are resolved at build time by esbuild's bundler;
> nothing breaks at runtime. This is a structural cleanup that
> unlocks wiring `madge --circular` into `npm run check`.

`npm run show-dependency-cycles` (madge `--circular` across every
`.js` file in the project) currently reports **31 circular
dependencies, all in `public/dashboard-*.js`** — the ESM dashboard
modules bundled by esbuild. Zero cycles in the CommonJS server-side
code. The cycles are real but masked by bundling.

## Why fix them

Once `public/` is clean, `madge --circular …` can be wired as a step
in `scripts/check.js` (and CI) to block any new cycle from landing.
Until then, the gate is voluntary — `npm run show-dependency-cycles`
exists only as an opt-in diagnostic.

## Shape of the work

The 31 cycle paths reduce to roughly **10 atomic clusters** once
shared edges are collapsed. Difficulty ranges from trivial 2-module
loops to a 7-module chain through the throttle/compound/mission-badge
graph. Standard tactics:

- Extract a shared state/types module both sides import from (no
  back-edge).
- Invert one direction — turn an import into a callback or parameter
  passed in by the caller.
- Lazy `import()` at one call site (escape hatch, not preferred).

No automated tool recommends fixes; `madge` only diagnoses. Each
cluster needs human judgment about which module is the conceptual
owner of the shared state.

## Suggested order

1. **Trivial 2-module cycles** — `dashboard-wallet ↔ wallet-import`,
   `dashboard-data ↔ closed-pos`, `dashboard-data-status ↔ alerts`.
2. **Data-kpi cluster** — `dashboard-data-kpi ↔ data-baseline`,
   `data-kpi ↔ data-baseline ↔ data-deposit`, `data-kpi ↔ data-range`.
3. **Load-bearing hubs** — `dashboard-positions ↔ data` and
   `dashboard-positions ↔ data-kpi`. Most other cycles route through
   these; expect them to take the most thought.
4. **Events chain** — `dashboard-data ↔ events ↔ events-manage ↔
   {history, unmanaged, wallet, …}`.
5. **Throttle/compound chain** — the largest cluster, deferred until
   last so upstream cleanup may already partially resolve it.

## Verification

No automated tests cover the dashboard JS files (per project
convention). Verify each cluster break manually in the browser
before moving to the next — regression risk is real.

## After cleanup

Add the gate to `scripts/check.js`:

```sh
madge --circular --extensions js src/ bot.js server.js scripts/ \
  eslint-rules/ test/ public/
```

Remove this nice-to-have entry once landed.
