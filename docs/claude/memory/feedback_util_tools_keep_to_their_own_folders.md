---
name: util-tools-keep-to-their-own-folders
description: "A util/ tool writes only its own data folder, app-data/util/<tool>/, its caches in app-data/util/<tool>/scan-cache/; never the app's files or caches, except a secret the app also uses, which lives only in the app's store"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-24T04:54:38.416Z
---

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
only its caches: `src/lib/price-fetcher-gate.js` called `loadConfig()`,
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
