---
name: feedback-one-literal-per-shipped-default
description: "For every shipped config value, exactly ONE literal assignment in the app, and it must live in the shipped JSON file. Zero literals for values the app does not ship a default for (e.g., PRIVATE_KEY)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-17T05:05:36.249Z
---

For every config value the app ships with a default, there must be at
most **ONE** literal assignment of that value in the entire codebase,
and that one literal **must live in the shipped JSON file** under
`app-config/app-defaults-for-user-configurable/`.

Some values have **zero** literals — values the app does not ship a
default for (e.g., `PRIVATE_KEY`, `WALLET_PASSWORD`).  Those are NEVER
hardcoded anywhere.

**No** `_FALLBACK` literals.  **No** `_CONFIG_INPUT_DEFAULTS` literals.
**No** env-var fallback literals in `parsePositiveInt(process.env.X,
<literal>)`.  **No** "keep this in sync with the JSON" comments.
Consumers source defaults via `loadShippedDefaults()` /
`loadMergedDefaults()` at module init.  The shipped JSON is the sole
chokepoint; everything else reads from it.

**Why:** Months of accreted duplication caused two real drifts that
the user discovered during an audit on 2026-06-21:

- `SLIPPAGE_PCT` was `0.75` in `src/config.js` but `0.5` in the
  shipped JSON (operators setting the env var saw 0.75; operators not
  setting it saw 0.5).
- `MAX_REBALANCES_PER_DAY` was `5` in `src/config.js` but `20` in the
  shipped JSON (same kind of split).

Each consumer was historically written self-contained with a
`_FALLBACK` literal as a "last-resort safety net"; no project-wide
rule said "the JSON is the SOLE source"; nobody noticed the drift
because the duplicates were never compared.  See
[[project-layered-config-refactor]] for the cleanup commit that
collapsed all ~42 duplicates to single-source.

**How to apply:**

- When **adding a new config value with a default**: put the literal
  ONLY in the appropriate shipped JSON under
  `app-config/app-defaults-for-user-configurable/`.  In code, read it
  via `loadShippedDefaults("<filename>.json")` at module init.
- When **reviewing a diff**: any new `_FALLBACK` / `DEFAULT_*` object
  literal in a consumer module, or any new `parsePositiveInt(process.env.X,
  <numeric-literal>)` is a red flag — push back.
- When **encountering a duplicate that already exists**: collapse it
  to the JSON immediately; do not leave it as "safety net" or "fallback."
- **Lint rule is intentionally NOT implemented** for this — the user
  explicitly declined the proposed AST/identifier-pattern rule
  (2026-06-21) because the invariant is semantic-not-syntactic and
  the lint rule would be brittle.  This is a serious engineering
  guideline enforced by convention + code review + the existence of
  the `loadShippedDefaults` / `loadMergedDefaults` chokepoint in
  `src/load-merged-defaults.js`.

Per-install operator overrides live at
`app-config/user-configurable/<same-name>.json` (gitignored,
tarball-upgrade-safe) and deep-merge on top of the shipped JSON at
runtime.  See [[project-layered-config-refactor]].

## No defaults in executable code (user, 2026-10-16)

The user's words: "any values must come from the static config: No
defaults in the executable code (js, html/dom); waiting for the first
poll is not a problem."

Said while approving the removal of the dashboard's copy of the swap
route label and the badge's pre-render text in `index.html`. It widens
this rule from shipped defaults to any value the app shows or acts on:

- No fallback value in JS for something static config or the server
  provides: no `x || "pulsechain"`, no `|| AGGREGATOR_LABEL`, no `|| ""`
  standing in for a missing config key. A missing key stops startup and
  names the setting (`_chainContract`, `_routeName`, `_aggregatorUrl` in
  `src/config.js`).
- No values in HTML. An element the first poll fills stays empty until
  then, and that wait is fine.
- Display names are static config too: the swap route names live in
  `chains.json` (`aggregator.name`, `contracts.swapRouter.name`).
- A value the dashboard needs before the server can answer is bundled
  from the shipped JSON at build time: `chainQueryTimeoutMs` in
  `ui-defaults.json`, imported by `public/dashboard-chain.js`, as
  `dialogMaxHeightPx` is baked into `ui-tokens.css`.

**How to apply:** a literal fallback in JS, or a value in HTML, is a
finding in your own work. Pre-existing ones are swept too, as soon as
they are found — the user, 2026-10-17: "we always sweep out hardcoded
values when we find them, out into json file(s) in `config/`; find the
right locations and do it." So a hard-coded tunable (a timeout, a
count, a limit, a fallback figure) found in code goes into the right
shipped JSON under `app-config/app-defaults-for-user-configurable/` and
is read from there; report it, do not ask first. A fallback that can
never fire is not moved but deleted ([[feedback_dead_code_removed]]).
The ones found on 2026-10-16 were approved and done the same evening:
six `"PulseChain"` chain-name fallbacks (now blank until the first poll),
the dashboard's 3000 ms status and Reload polls and the server's copy
(now `dashboardPollIntervalMs` in ui-defaults.json, which the server
reads from the shipped file so it agrees with the bundle), and the CSRF
refresh's five minutes (now csrf.json's `refreshIntervalMs`, bundled for
the time before the first token). The user ruled the Reload dialog's
`logs/error.log` text fine, since that path never changes.
