---
name: feedback-one-literal-per-shipped-default
description: "For every shipped config value, exactly ONE literal assignment in the app, and it must live in the shipped JSON file. Zero literals for values the app does not ship a default for (e.g., PRIVATE_KEY)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-24T05:24:12.681Z
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
`loadMergedDefaults()` when called, never as the module loads
([[only-the-entry-point-runs-at-load]]).  The shipped JSON is the sole
chokepoint; everything else reads from it.

**Why:** Months of accreted duplication caused two real drifts that
the user discovered during an audit on 2026-06-21:

- `SLIPPAGE_PCT` was `0.75` in `src/lib/config.js` but `0.5` in the
  shipped JSON (operators setting the env var saw 0.75; operators not
  setting it saw 0.5).
- `MAX_REBALANCES_PER_DAY` was `5` in `src/lib/config.js` but `20` in the
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
  via `loadShippedDefaults("<filename>.json")` in the function that
  needs it, not as the module loads.
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
  `src/lib/load-merged-defaults.js`.

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
  `src/lib/config.js`).
- No values in HTML. An element the first poll fills stays empty until
  then, and that wait is fine.
- Display names are static config too: the swap route names live in
  `chains.json` (`aggregator.name`, `contracts.swapRouter.name`).
- A value the dashboard needs before the server can answer is bundled
  from the shipped JSON at build time: `chainQueryTimeoutMs` in
  `ui-defaults_non-layout_for-server-down-scenario.json`, imported by
  `src/client/web/dashboard-chain.js`, as `dialogMaxHeightPx` in
  `ui-defaults_layout.json` is baked into `ui-tokens.css`. Every other
  dashboard setting comes from the server.

## Ranges and rule constants too (user, 2026-10-17)

The user's words: "if the rebalance throttle constants and the
validation bounds are actually literal constants (a literal Number
value) and are still in the code, they should be moved to the
appropriate json config." So the rule covers the numbers that check a
value as well as the values themselves. Every range is in
`setting-bounds.json`, at the setting's own path, read through
`src/lib/setting-bounds.js`, and the help copy that quotes a range or a
default reads it from the JSON rather than writing it into the
sentence. The doubling numbers are `throttleDoubling` in
`bot-config-defaults.json`. A number that defines a thing is not a
tunable and stays: the 2 of "doubling", 60 seconds in a minute, the 0
that means "off".

The help copy reaches its figures through `src/lib/help-figures.js`
(user, 2026-10-17: "those values should be picked up from the numbers
in the json config files"): `{{figure:name}}` tokens in
`shared-help-content.json`, `<span data-figure="name">` in the manual's
own prose and in `index.html`, and the `f` table `buildParamHelp`
takes in the dialogs' copy. The figures are the install's own, resolved
on the server (`src/server/resolved-settings.js`, `GET /api/help-figures`):
the user, 2026-10-17, "All help text should just quote whatever is the
final resolved json value, which means, of course, it should include
overrides done by the user", and "include .env too". So help wording
never says "shipped" of a figure it quotes. A figure the help works through as an example is
computed there too. A sentence whose truth depends on the number itself
("100% effectively turns it off") keeps its literal, since a token
would make it false the day the setting moved.

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
(now `dashboardPollIntervalMs`, which since 2026-10-17 the server sends
the dashboard from `ui-defaults_non-layout_for-server-up-scenario.json`,
override applied, and reads itself from the same answer), and the CSRF
refresh's five minutes (now csrf.json's `refreshIntervalMs`, bundled for
the time before the first token). The user ruled the Reload dialog's
`logs/error.log` text fine on 2026-10-16, since that path never changed.
Once `errorLogPath` made it configurable (2026-10-17) the user ruled
again: the dialog and `npm run clean` use the configured value, and only
the User Manual keeps `logs/error.log`, named as the default.
