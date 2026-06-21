# Shipped defaults — DO NOT EDIT

The JSON files in this directory are the **shipped defaults** for every
configurable value in LP Ranger.  They are tracked in git and are
**overwritten on every tarball upgrade** of the app.

**Do not edit these files in place.**  Your changes will be lost the
next time you upgrade by untarring a new release over your install.

## Where to put your customizations

To override any key in any file here:

1. **Copy** the shipped file from this directory to the sibling
   [`../user-configurable/`](../user-configurable/) directory using
   the same filename, e.g.

   ```sh
   cp app-config/app-defaults-for-user-configurable/logging.json \
      app-config/user-configurable/logging.json
   ```

2. **Edit** the copy in `user-configurable/` (NOT the original here).

3. **Restart** the app (or wait for the next re-read — most files
   re-read live so an operator change takes effect without a restart).

At runtime, the app reads the shipped default first and then **deep-
merges** your matching `user-configurable/<filename>.json` on top.
Your values win on every key you set; every key you omit keeps the
shipped default.  That means you can shrink your copy down to JUST
the keys you actually want to override — when a future release ships
a new shipped default for a key you didn't override, you
automatically pick it up.

The sibling `user-configurable/` directory is gitignored, so anything
inside it survives a tarball upgrade.  The files in *this* directory
do not — that's why direct edits here would be silently lost.

### Example

To raise the bot's poll interval from the shipped default of 300 s
to 600 s without touching anything else:

```sh
cp app-config/app-defaults-for-user-configurable/bot-config-defaults.json \
   app-config/user-configurable/bot-config-defaults.json
```

Then trim the copy down to just:

```json
{
  "checkIntervalSec": 600
}
```

Every other key in `bot-config-defaults.json` continues to use the
shipped value, including any future shipped-default updates.

## Merge semantics

- **Plain-object keys** deep-merge (your nested keys overlay on top of
  the shipped nested keys).
- **Arrays REPLACE** rather than merge by index — if you set an
  array, your full array wins.
- **`null`** explicitly clears a value (rare; use when you want to
  signal "no value").

## Format errors

The shipped JSON files in *this* directory are required and must be
valid — a missing or malformed file is treated as a broken install and
the app refuses to start.

The user override file is **optional** — its absence is the normal
case.  If a user override file is malformed, the app logs a warning
and falls back to the shipped defaults for that file.  Your typo will
never brick your install.

## File inventory

| File | What it controls |
| --- | --- |
| `app-runtime.json` | App-level runtime defaults: server port/host, TX timing, aggregator URL/API key, scan timeout, compound min-fee + default-threshold, log file path. |
| `bot-config-defaults.json` | Default values for every Bot Settings input (OOR threshold, slippage, intervals, daily cap, gas, etc.) plus validation bounds (`gasFeePctMin`/`Max`) and server-internal nested groups (`lowGasThresholds`, `residualCleanup`). |
| `chains.json` | Per-blockchain RPC endpoints, contract addresses, gas multipliers, aggregator tunables (incl. `estimatedSwapGasUnits`), chart-provider URL templates. |
| `csrf.json` | CSRF token TTL + dashboard refresh cadence. |
| `dust-threshold.json` | Inflation-resistant "is this dust?" threshold (units of a reference asset) + USD floor + the price-source token list used to derive USD-per-unit. |
| `evm-rpc-response-codes.json` | Error-classifier substring lists (transient / terminal-nonce-unused / terminal-nonce-consumed). |
| `logging.json` | Always-on log-to-file toggle + default path. |
| `nft-providers.json` | Short display labels for NFT position-manager contracts (e.g. "9mm v3"). |
| `ui-defaults.json` | Dashboard first-visit defaults: sounds, privacy mode, blur toggles, USD-amount threshold. |
