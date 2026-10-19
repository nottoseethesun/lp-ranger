# Bring the app-data Files Under JSON Schema

> **Status:** Nice-to-have — not a bug. The app works correctly without
> this, and funds are never at risk: the startup check already holds the
> bot's records to the shapes the bot writes.

## What happens now

The JSON settings files and `bot-config.json` are each checked at
startup against a JSON Schema (Ajv, draft 2020-12, strict), and every
group in them names the keys it takes and refuses any other. The files
in `app-data/` are not:

- **The records file**, `app-data/position-records.json`, is held at
  startup to checks written in code (`src/config-record-checks.js`),
  built from the same kinds of value the schemas use. A field no reader
  knows is left alone, since an older release may have written it.
- **The rebalance log**, `app-data/rebalance_log.json`, is read with no
  check of its entries. A file that is not a list is read as empty.
- **The scan caches**, `app-data/scan-cache/*.json`, are read with no
  check of their shape. One that is not valid JSON is read as empty and
  filled again from the blockchain and the price services.

## Shape of the fix

Give each file a JSON Schema built from the kinds of value in
`src/value-kinds.js`, as the settings files have, and check it with the
same Ajv instance.

- The records file's schema replaces the checks in code, one schema per
  record. Whether a record refuses a field it does not name, as the
  settings files do, is a decision for then: an older release may have
  written such fields, so refusing them would need the migration tool
  (`node ./util/migration`) to drop them first.
- The rebalance log gets a schema for an entry.
- A scan cache that fails its schema could be set aside and rebuilt
  rather than stop startup, since everything in it can be read again.
  A rebuild takes about an hour per position.

Likely touch points: the records check (`src/config-record-checks.js`,
`src/bot-config-checks.js`), the startup check
(`src/settings-check.js`), the rebalance log's readers
(`src/bot-recorder.js`, `src/position-history.js`) and the cache
readers (`src/cache-store.js`, `src/epoch-cache.js`).
