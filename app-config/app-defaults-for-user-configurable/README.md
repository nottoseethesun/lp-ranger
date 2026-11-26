# Shipped defaults — DO NOT EDIT

The JSON files in this directory are the **shipped defaults** for every
configurable value in LP Ranger.  They are tracked in git and are
**overwritten on every tarball upgrade** of the app.

**Do not edit these files in place.**  Your changes will be lost the
next time you upgrade by untarring a new release over your install.

## Where to put your customizations

To override a key in any file here but three, `setting-bounds.json`,
`api-keys.example.json` and
`ui-defaults_non-layout_for-server-down-scenario.json`, which the app
never takes a copy of:

1. **Copy** the shipped file from this directory to the sibling
   [`../user-configurable/`](../user-configurable/) directory using
   the same filename, e.g.

   ```sh
   cp app-config/app-defaults-for-user-configurable/logging.json \
      app-config/user-configurable/logging.json
   ```

2. **Edit** the copy in `user-configurable/` (NOT the original here).

3. **Restart** the app. It reads each file once and keeps what it read
   until it stops, so a change takes effect at the next start, unless
   the file inventory below says otherwise.

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
- **`null`** is a value no setting in these files takes: the startup
  check refuses it, naming the setting, and the app does not start. To
  go back to a shipped value, delete its key from your copy.

## Format errors

The shipped JSON files in *this* directory are required; a missing or
malformed one is a broken install. An override file is optional, and
every value in one is checked at startup, as
[Checking the Settings](../../docs/configuration.md#checking-the-settings)
describes.

## File inventory

| File | What it controls |
| --- | --- |
| `app-runtime.json` | App-level runtime defaults: server port/host, TX timing, how long the Re-scan Prices dialog waits for its scan, compound min-fee + default-threshold, the rebalance log's path. |
| `bot-config-defaults.json` | Defaults for every Bot Settings input, plus server-internal nested groups (`lowGasThresholds`, `residualCleanup`, `ilGuardRetry`, `throttleDoubling`). |
| `chains.json` | Per-blockchain RPC endpoints, contract addresses, gas multipliers, aggregator url and tunables (incl. `quoteTimeoutMs`, `estimatedSwapGasUnits`), chart-provider URL templates. |
| `csrf.json` | CSRF token TTL + dashboard refresh cadence. |
| `dust-threshold.json` | Inflation-resistant "is this dust?" threshold (units of a reference asset) + USD floor + the price-source token list used to derive USD-per-unit. |
| `evm-rpc-response-codes.json` | Error-classifier substring lists (transient / terminal-nonce-unused / terminal-nonce-consumed). |
| `logging.json` | Always-on log-to-file toggle + default path; the error log's path. |
| `lp-providers.json` | LP-provider metadata keyed by `<poolFactory>_<positionManager>`: display names and supported chains. |
| `price-services.json` | Each price service's api base url; how many pools GeckoTerminal weighs for a token's historical price. |
| `setting-bounds.json` | The range each checked setting must fall in. **Not overridable**, or an override could widen any range. |
| `setting-labels.json` | How the dashboard names each setting, for messages and the Activity Log. |
| `ui-defaults_layout.json` | Dashboard layout settings (the dialog height), built into its CSS; an override applies at the next `npm run build`. |
| `ui-defaults_non-layout_for-server-down-scenario.json` | The two dashboard settings needed while the server is unreachable, built into the page. **Not overridable**: a copy in `user-configurable/` stops the app at startup (`… is not a file LP Ranger reads`). |
| `ui-defaults_non-layout_for-server-up-scenario.json` | Every other dashboard setting, sent by the server, including the first-visit defaults for sounds and privacy. An override takes effect after a restart and a page reload. |
