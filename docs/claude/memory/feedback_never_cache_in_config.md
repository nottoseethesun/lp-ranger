---
name: feedback_never_cache_in_config
description: "ABSOLUTE RULE: never put cache data, or anything the bot works out or records, in a configuration file. app-config/ holds only what the operator chooses."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-19T18:53:39.006Z
---

# NEVER PUT CACHE DATA IN A CONFIGURATION FILE

**A configuration file holds only what the operator chooses.** Nothing
read from the blockchain or a price service, nothing worked out from
that, and nothing the bot records about what it did ever goes in one.
This covers every file under `app-config/`: bot-config.json, the shipped
defaults, and the operator's copies of them.

Where each kind of data goes instead:

| What | Where |
| --- | --- |
| Anything read from the chain or a price service, kept to save reading it again | `app-data/scan-cache/`, its path from `scanCachePath` (src/scan-cache-dir.js) |
| What the bot worked out or recorded about a position | `app-data/position-records.json`, a key in `RECORD_POSITION_KEYS` (src/position-records.js) |
| The operator's settings and which positions are managed | `app-config/user-configurable/bot-config.json` |
| Nothing worth keeping | `tmp/` |

**Why:** the user, 2026-10-19, on finding compounds, deposits and gas in
bot-config.json: "And why are compounds, deposits, and gas . . . in a
config file?!!!?!?!?!?" and then "make sure you have a massive Rule to
never put cache data in configuration files!!!!!!!". Ten kinds of
record had piled up in bot-config.json, one at a time, each because the
file was already keyed per position. A settings reset then destroyed the
figures, and the settings check and the settings route had to know about
the bot's data. The same day the scan caches came out of `tmp/`, which
an operator reads as safe to delete.

**How to apply:**
- Before saving anything new, ask: did the operator choose this value?
  If not, it is not configuration. A new cache names its file with
  `scanCachePath`; a new per-position record joins
  `RECORD_POSITION_KEYS`.
- Convenience is never the reason. "The file is already keyed per
  position" is exactly how the records got into bot-config.json.
- test/data-homes.test.js fails the build when a module under `src/`
  writes a cache outside the scan-cache folder, or a key is both a
  setting and a record.
- A release that moves data adds a step to util/migration/.

Related: [[feedback_where_data_lives]], [[feedback_minimize_caching]].
