---
name: feedback_util_subdir_per_utility
description: "A util/ tool of two or more files is a directory with index.js; it writes only app-data/util/<tool>/; it uses the core settings only (chains, endpoints, keys); its docs are in docs/util/<folder>/"
metadata:
  type: feedback
---

# util/ tools

Merged from: feedback_util_tools_keep_to_their_own_folders, feedback_util_tools_use_core_settings_only, feedback_util_tool_docs_in_docs_util — those slugs no longer exist
separately; search this one.

## util subdir per utility

In `util/`, one file per utility OR one directory per utility. The moment a
tool needs a second file (500-line cap, or isolating pure logic for tests), it
moves into its own subdirectory named for the utility, with `index.js` as the
entry point so it still runs as `node util/<category>/<utility>`. Never scatter
a tool's parts as sibling files sharing a name prefix
(`verify-compound-usd.js` + `verify-compound-usd-analysis.js` was rejected).

**Why:** Stated by the user 2026-08-04. Keeps each category directory a list of
tools rather than a list of fragments.

**How to apply:** Reference example is `util/diagnostic/verify-compound-usd/`:
`index.js` (CLI, chain I/O, rendering) + `analysis.js` (pure math and
formatting, no I/O). Tests do NOT move with the tool: every `util/` test
lives in `util/test/`, one directory for the whole tree, and
`npm run test:util` globs `util/test/*.test.js`. Watch the relative
require depth when moving files in: `../../src/lib/x` becomes `../../../src/lib/x`, and
`n/no-missing-require` catches it (see [[feedback_use_linter_to_locate_issues]]).
Per [[feedback_no_reexports]], the entry must not re-export the sibling
module's helpers — tests import each from its owner. Convention is documented
in `docs/engineering.md` § Utilities.

## util tools keep to their own folders

A tool under `util/` keeps what it writes in `app-data/util/<tool>/`, and
its caches in `app-data/util/<tool>/scan-cache/`. It never writes the
app's own files, `app-data/scan-cache/` included, even through an app
library it loads; point the library's cache paths at the tool's folder
before the library loads.

**Why:** the user, 2026-10-20, for the bookkeeping report's price cache:
"Keep all such caches in `app-data/util/bookkeeping`; this would go in
`app-data/util/bookkeeping/scan-cache`." They also asked that the work
change nothing outside `util/bookkeeping` and its data folder. A running
LP Ranger writes its own caches in place, so a second process writing
the same file can leave it cut short.

**How to apply:** when a tool needs an app library that caches, find the
library's path overrides (`PRICE_CACHE_PATH`, `GECKO_POOL_CACHE_PATH`)
and set them to the tool's folder first. Under `node --test`, use the test
process's own folder instead. Then list every `src/lib/` module the tool
loads (`require.cache`) and check each for writes made as it loads, not
only its caches: `src/bot/price-fetcher-gate.js` called `loadConfig()`,
which copies `bot-config.json` and `position-records.json` over their
backups (found 2026-10-20; since 2026-10-21 it reads nothing as it
loads, and a tool that needs its settings calls
`readPriceCacheSettings(true)`).

**The one exception, a secret the app also uses**, such as the Moralis
api key: it has one home, the app's own store (`src/lib/api-key-store.js`),
and the tool reads it there and saves it there, never a copy in its own
folder. The user, 2026-10-21: "the bookkeeping app needs to be able to
read a saved Moralis key that the user has saved previously (e.g., using
the app or the utility - they must work from the same single source of
truth)", then "yes, fix to have a single source of truth". My first
design kept a second, separately encrypted copy in
`app-data/util/bookkeeping/`. Related: [[feedback_where_data_lives]],
[[feedback_never_cache_in_config]].

## util tools use core settings only

A tool under `util/` reads only LP Ranger's core settings: the chains,
their endpoints and contracts, and the keys it needs. It never reads or
honors the app's preferences, the switches that shape how the app itself
behaves, such as the dashboard's Moralis on/off switch.

**Why:** the user, 2026-10-21, when I suggested the bookkeeping report
honor the Moralis on/off setting: "no, the utility doesn't use app
preferences, only core settings."

**How to apply:** when a tool reads configuration through the app's
resolvers, take what is needed to reach the chain and the services
(`chains.json`, `.env`, the endpoint list, the api-key store) and leave
the preferences. The endpoint list is core even though it puts the
endpoints saved in the dashboard (`rpcUrls` in bot-config.json) first:
the user, 2026-10-21, on the report's default endpoint coming from it,
"yes, that's a core setting". Unsure which a setting is? Ask the user.
Related: [[util-tools-keep-to-their-own-folders]].

## util tool docs in docs/util

A tool under `util/` with documentation of its own keeps it in a folder
under `docs/util/`, as the bookkeeping tools do in
`docs/util/bookkeeping-for-coins-in-transactions/`:

- `user-manual.md`, patterned on LP Ranger's User Manual
  (`src/client/web/help-and-user-manual.html`), leaving out what does not apply,
  such as Checking for Updates;
- `commands.md`, patterned on `docs/npm-project-commands.md`;
- `engineering.md`, patterned on `docs/engineering.md`.

`docs/engineering.md`'s entry for the tool only points to the folder,
and LP Ranger's User Manual names the tool's user manual by its path.

**Why:** the user, 2026-10-21, asked for the folder and its three
documents ("Do not rigidly follow the examples: Merely use them as
guidelines and suggestions"), then: "`docs/bookkeeping-for-coins-in-transactions/`
needs to be moved to, `docs/util/bookkeeping-for-coins-in-transactions/`".

**How to apply:** give each fact one of the three
([[doc-set-one-home-per-fact]]). Add the folder to `MARKDOWN_TARGETS`
in `scripts/lint-targets.js`, and check every cross-file link and anchor,
which markdownlint does not. A doc both moved and rewritten is committed
in two steps, the move alone first, so `git log --follow` keeps its
history: a rewrite under 50% alike is not seen as a rename.
