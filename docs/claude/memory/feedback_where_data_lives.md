---
name: feedback_where_data_lives
description: "tmp/ is for disposable files only; scan caches live in app-data/scan-cache/, the bot's records in app-data/position-records.json, and bot-config.json holds settings and the managed list only"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-24T04:55:01.237Z
---

Each kind of data has one home, chosen by what losing it costs:

- **Settings the operator chose, and which positions are managed:**
  `app-config/user-configurable/bot-config.json`. Nothing else.
- **What the bot worked out or logged about a position** (HODL
  baseline, compound history and coins, gas per NFT, lifetime deposit,
  residuals, last compound time): `app-data/position-records.json`
  (src/lib/position-records.js, `RECORD_POSITION_KEYS`).
- **What was read from the blockchain or a price service and can be read
  again:** `app-data/scan-cache/` (src/lib/scan-cache-dir.js). Rebuilding
  costs about an hour per position, so it is not disposable.
- **`tmp/`:** only what is truly disposable: the PID file, scratch
  output, a migration's safety copy.

**Why:** on 2026-10-19 the user asked "Why is key data in `tmp/`? Sounds
like all that should go in app-data", then "And why are compounds,
deposits, and gas . . . in a config file?!" Both were placement by
convenience, not design: the caches went to `tmp/` because they could
be rebuilt, and each record joined bot-config.json because it was
already the file keyed per position. The user approved moving both the
same day.

**How to apply:** a new cache names its file with `scanCachePath`; a new
per-position record joins `RECORD_POSITION_KEYS`, never a settings file;
nothing worth keeping goes in `tmp/`. A release that moves a file adds a
step to util/migration/. Related: [[feedback_minimize_caching]],
[[feedback_test_suite_checks_only_what_ships]].
