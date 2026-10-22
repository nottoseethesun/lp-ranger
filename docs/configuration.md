# LP Ranger — Configuration Reference

This is the canonical reference for **how LP Ranger is configured**: every
environment variable, the layered defaults system, where each setting lives on
disk, and which settings are deliberately not editable.

**Configure LP Ranger through the JSON files under `app-config/`**, or through
the dashboard's Bot Configuration panel, which writes to them for you.
[JSON Configuration Values](#json-configuration-values) is where to start.
`.env` is for headless or unattended operation, and for experiments.

Configuration reaches the app through three layers — shipped JSON defaults,
per-install operator overrides, and `.env`, in that order of increasing
precedence. [Configuration Precedence](#configuration-precedence) is the rule
that decides which wins, and most surprises come from not knowing it: `.env`
sits on top, so a line left there overrides anything set later in the
dashboard.

For the runtime mechanisms these settings govern, see
[`docs/engineering.md`](engineering.md). For the commands that read this
configuration, see
[`docs/npm-project-commands.md`](npm-project-commands.md). For how the bot and dashboard
cooperate at a higher level, see [`docs/architecture.md`](architecture.md).
For the controls protecting the wallet, see [`docs/security.md`](security.md).

---

## Table of Contents

- [JSON Configuration Values](#json-configuration-values)
  - [Where each setting lives](#where-each-setting-lives)
  - [How to change one](#how-to-change-one)
  - [Checking the Settings](#checking-the-settings)
- [Environment Variables](#environment-variables)
  - [Overview](#overview)
  - [Configuration Precedence](#configuration-precedence)
  - [Server (`.env`)](#server-env)
  - [Request Security](#request-security)
  - [Chain Selection (`.env`)](#chain-selection-env)
  - [Wallet (`.env`, Required for Bot)](#wallet-env-required-for-bot)
  - [Position Discovery (`.env`)](#position-discovery-env)
  - [Bot Behaviour (`.env`)](#bot-behaviour-env)
    - [RPC endpoints](#rpc-endpoints)
  - [Contract Addresses](#contract-addresses)
    - [Why contract addresses are not editable](#why-contract-addresses-are-not-editable)
  - [What a Chain's Entry Describes](#what-a-chains-entry-describes)
  - [File Paths and Diagnostics](#file-paths-and-diagnostics)
  - [Where Other Configuration Lives](#where-other-configuration-lives)
- [RPC Request Pacing and Log Chunking](#rpc-request-pacing-and-log-chunking)
  - [Why chunking exists](#why-chunking-exists)
  - [Why pacing is global](#why-pacing-is-global)
  - [Cost](#cost)
- [Other Operator Tunables](#other-operator-tunables)
  - [Failover and the reads someone waits on](#failover-and-the-reads-someone-waits-on)
  - [History scans](#history-scans)
  - [Swaps and the throttle](#swaps-and-the-throttle)
  - [Waiting for gas](#waiting-for-gas)
  - [Sending and stopping](#sending-and-stopping)
  - [Logs and price services](#logs-and-price-services)
  - [Dashboard settings the server sends](#dashboard-settings-the-server-sends)
  - [Dashboard settings built into the page](#dashboard-settings-built-into-the-page)

---

## JSON Configuration Values

**The JSON files under `app-config/` are where LP Ranger is configured.**
That is the normal path, and for a dashboard install it is the only one you
need. Almost every setting has a home there, and most of them also have a
control in the dashboard's Bot Configuration panel, which writes to those files
for you.

`.env` exists for two narrower purposes:

- **Headless and unattended operation.** Running `npm run bot` on a
  Raspberry Pi there is no Bot Configuration panel to press Save in, so the same
  tunables are settable as environment variables. The wallet credentials
  belong to this case as well: `PRIVATE_KEY` and `WALLET_PASSWORD` are how
  an install unlocks itself with no browser present. A dashboard install
  imports its wallet through the UI instead, and it is held encrypted in
  `wallet.json`.
- **Experiments.** A one-off override to try without editing a file and
  without it persisting.

Outside those two cases, prefer the JSON files. A value set in `.env`
outranks the JSON layers (see
[Configuration Precedence](#configuration-precedence)), so a stale line in
`.env` silently overrides whatever you later set in them.

### Where each setting lives

| What | File | Edited by |
| --- | --- | --- |
| Server and process settings — listen port and host, default chain, TX recovery timing, scan timeout | `app-config/app-defaults-for-user-configurable/app-runtime.json` | you, by hand |
| Per-chain static tunables — RPC endpoints, contract addresses, gas multipliers, aggregator timeouts — and everything the app says about a chain ([What a Chain's Entry Describes](#what-a-chains-entry-describes)) | `app-config/app-defaults-for-user-configurable/chains.json` | you, by hand |
| Shipped defaults for bot behaviour — thresholds, intervals, caps, chunk size, pacing | `app-config/app-defaults-for-user-configurable/bot-config-defaults.json` | you, by hand |
| Each checked setting's range | `app-config/app-defaults-for-user-configurable/setting-bounds.json` | nobody: it cannot be overridden |
| Managed positions and per-position settings — thresholds, slippage, auto-compound | `app-config/user-configurable/bot-config.json` | the dashboard and the bot; not hand-edited |
| Each position's records — HODL baseline, compound history, gas, lifetime deposit, residuals | `app-data/position-records.json` | the bot |
| Encrypted wallet | `app-config/user-configurable/wallet.json` | the dashboard import flow |
| Encrypted third-party API keys (Moralis, Telegram) | `app-config/user-configurable/api-keys.json` | the dashboard Settings dialog |

More shipped-default files cover narrower concerns — CSRF token TTL,
the dust threshold, RPC error-classifier strings, logging, LP-provider
metadata, the price services, the dashboard's settings, and setting
labels. The engineering reference linked below inventories them all,
and [Other Operator Tunables](#other-operator-tunables) lists the
settings in them that have no dashboard control.

The dashboard's settings are in three files. An override takes effect:

- `ui-defaults_layout.json`, the dialog height: at the next
  `npm run build`.
- `ui-defaults_non-layout_for-server-down-scenario.json`, two settings
  needed while the server cannot be reached: it cannot be overridden.
- `ui-defaults_non-layout_for-server-up-scenario.json`, every other
  dashboard setting: after a restart and a page reload.

### How to change one

To override a shipped default without losing it on the next release, copy
the key into the matching file under `app-config/user-configurable/` and
edit it there. `loadMergedDefaults()` deep-merges your file over the shipped
one, and the `user-configurable/` directory is gitignored and survives a
tarball upgrade. Editing the shipped file directly works too, but the next
release overwrites it.

Settings with a dashboard control need no file editing at all — change them
in Bot Configuration and press Save.

See [The `app-config` Directory](engineering.md#the-app-config-directory) in
the engineering reference for the full file inventory and the rules for
where future config files should go.

### Checking the Settings

The server and the bot check every setting before they read any, and
refuse to start while one is wrong, naming each problem. They check:

- the JSON settings files, with your copies in
  `app-config/user-configurable/` over them, each against its JSON
  Schema;
- `.env`, against the list of variables LP Ranger reads;
- `bot-config.json`, against its JSON Schema, which holds each setting
  to the rule the dashboard's Save holds it to; and the records the bot
  keeps beside it in `app-data/position-records.json`.

A problem is a value of the wrong kind or outside its range, a setting
LP Ranger does not read, a setting in a file that does not read it, a
file that is not valid JSON, or a copy of a file the app never reads
from `user-configurable/`. A setting LP Ranger
has retired is not one: the next save drops it from `bot-config.json`.
`npm stop` and `npm run gentle-stop` do not check, and read no setting
but where the server listens and the `shutdown` timings below. So a bad
setting anywhere else never keeps you from stopping a server that is
running.

To check without starting:

```sh
node util/diagnostic/validate-config-values-with-any-user-overrides.js
```

It lists every problem, or says there are none, and exits non-zero when
there are any. The test suite checks only the files that ship, so local
and CI results agree; this is how your own copies, `.env` and
`bot-config.json` are checked.

To see the values it checks:

```sh
node util/diagnostic/print-resolved-settings.js
```

It prints the `.env` variables LP Ranger reads, with the environment
over them, then each JSON settings file by name, your copy over the
shipped one, as raw JSON. It names the private key and the wallet
password as set, and never shows them.

---

## Environment Variables

### Overview

**Use `.env` only for headless or unattended operation, and for
experiments.** Anything with a JSON home or a dashboard control belongs
there instead — see
[JSON Configuration Values](#json-configuration-values) above. That
includes `PORT` and `HOST`, whose defaults live in
`app-config/app-defaults-for-user-configurable/app-runtime.json`.

`PRIVATE_KEY` and `WALLET_PASSWORD` have no JSON home by design, but they
are not an exception to the rule — they *are* the headless case. A
dashboard install imports its wallet through the UI and unlocks it in the
browser, and never needs either one.

The reason to be careful is precedence: a value set here beats both the
shipped default and your own `user-configurable/` override, so a
forgotten line in `.env` quietly outranks a later edit to either. A value
saved in Bot Configuration for a position still wins over `.env` (see
[Configuration Precedence](#configuration-precedence)).

With that said, the rest of this section is the complete list of what `.env`
accepts — every variable on its own row, with the JSON key it overrides
recorded on that row. Copy [`.env.example`](../.env.example) to `.env` and set
only what you need.

A row reading **none** in the JSON counterpart column means there is no JSON
key for that variable, and the reason is on the row. Most variables are read
by [`src/config.js`](../src/config.js) at startup; the overrides under
[File Paths and Diagnostics](#file-paths-and-diagnostics) are read by the
module that owns each file instead.

### Configuration Precedence

Three layers, lowest to highest. [`src/config.js`](../src/config.js)
composes them at startup and every consumer reads the result:

1. **Shipped default** — the single literal, in a tracked JSON file
   under `app-config/app-defaults-for-user-configurable/`.
2. **Operator override** — the matching file under
   `app-config/user-configurable/`, deep-merged over the shipped
   defaults by `loadMergedDefaults()`. Gitignored and
   tarball-upgrade-safe.
3. **Environment variable** — read from `.env`, layered on top of the
   merged result.

The layer that surprises people is the third. `.env.example` documents
only runtime flags, secrets, endpoints and contracts, but `config.js` also
accepts an env override for five Bot Configuration settings, which is how
a **headless install sets them at all** — there is no Bot Configuration
panel to press Save in when running `npm run bot` on a Raspberry Pi. The
**JSON counterpart** column in the tables that follow names the key each
variable overrides.

A **per-position value saved in Bot Configuration still wins over all
three**. The layers above decide only what a position that has never had
a value saved falls back to.

**A value that is both displayed and acted on resolves through the same
expression.** The server resolves all three layers for the dashboard
(`src/resolved-settings.js`): `GET /api/bot-config-defaults` fills the
Bot Configuration inputs and their Default buttons, and the help quotes
the same figures, so what you see is what the bot runs on.

---

### Server (`.env`)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `PORT` | `5555` | `app-runtime.json` → `server.port` | HTTP port the dashboard is served on. The CORS origin guard is locked to `localhost:<PORT>`, so changing this updates the allowed origin with it. |
| `HOST` | `127.0.0.1` | `app-runtime.json` → `server.host` | Bind address. Localhost only by default; `0.0.0.0` exposes the dashboard to the local network. |

### Request Security

Mutating API endpoints (POST, DELETE) are protected by three layers —
network binding, CORS origin guard, and CSRF tokens. GET requests
require none of them. Full details and the lint/test enforcement behind
each layer live in [`docs/security.md`](security.md).

### Chain Selection (`.env`)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `CHAIN_NAME` | `pulsechain` | `app-runtime.json` → `defaults.chain` | Selects which entry the bot loads out of `chains.json`. `pulsechain-testnet` is PulseChain Testnet v4. The per-chain RPC endpoints, contract addresses and gas multipliers live in that file, not here. Leaving this out of `.env` is the normal case, and `defaults.chain` then applies — as it does for a line left blank, which is no override either. A name matching no entry in `chains.json` stops the app at startup with an error naming the chains that are configured. It does not fall back to another chain, because the entry carries the contracts and endpoints every transaction is built against. |

### Wallet (`.env`, Required for Bot)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `PRIVATE_KEY` | *(unset)* | **none, by design** | This setting is for Headless Operation only (running the bot only, and not the web app). Hex signing key, `0x`-prefixed, in plaintext. A dashboard install imports its wallet through the UI and unlocks it in the browser instead. |
| `WALLET_PASSWORD` | *(unset)* | **none, by design** | This setting is for Headless Operation only (running the bot only, and not the web app). It decrypts the wallet and the stored API keys at startup without prompting, which is what lets an unattended bot sign. The trade-off is a plaintext password in `.env` — see [Wallet password persistence](claude/CLAUDE-SECURITY.md#wallet-password-persistence). Read by [`src/bot-private-key.js`](../src/bot-private-key.js) and [`src/server-routes.js`](../src/server-routes.js), not by `config.js`. A dashboard install is asked for the password in the browser instead, and `node server.js --headless` asks in the terminal. |

### Position Discovery (`.env`)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `POSITION_ID` | *(unset)* | **none** — a run mode, not a setting | A single NFT token ID for `npm run bot` to start when `bot-config.json` lists no managed positions. Blank scans the wallet. `server.js` ignores it and starts whatever the config marks `running`. An ID that is not among the wallet's valid positions does not fail — detection falls back to the first position it found. |

### Bot Behaviour (`.env`)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `RPC_URL` | `https://rpc-pulsechain.g4mm4.io` | `chains.json` → `<chain>.rpc.urls[0]` | First JSON-RPC endpoint. |
| `RPC_URL_FALLBACK` | `https://rpc.pulsechain.com` | `chains.json` → `<chain>.rpc.urls[1]` | Second endpoint. |
| `RPC_URL_FALLBACK_2` | `https://rpc.pulsechain.box` | `chains.json` → `<chain>.rpc.urls[2]` | Third endpoint. Free tier, 50 requests per 10 seconds per IP. |
| `REBALANCE_OOR_THRESHOLD_PCT` | `5` | `bot-config-defaults.json` → `rebalanceOutOfRangeThresholdPercent` | How far past the position's price boundary the price must move before the distance condition fires, as a percentage of the position's range width. A fraction is accepted. |
| `REBALANCE_TIMEOUT_MIN` | `180` | `bot-config-defaults.json` → `rebalanceTimeoutMin` | Minutes continuously out of range before a rebalance fires whatever the distance. `0` disables it. |
| `IMPERMANENT_LOSS_GUARD_PCT` | `15` | `bot-config-defaults.json` → `impermanentLossGuardPct` | How much impermanent loss a position may carry before the bot stops rebalancing it: how far below holding the coins its NFT was minted with, at today's prices. Tight by default: rebalancing crystallizes the loss, and fees in a quiet pool may never earn it back. Accepted range 1–100. |
| `CHECK_INTERVAL_SEC` | `300` | `bot-config-defaults.json` → `checkIntervalSec` | Seconds between on-chain poll cycles. Range 10 to 3600 — see [Ranges on the timer settings](#ranges-on-the-timer-settings). |
| `MIN_REBALANCE_INTERVAL_MIN` | `10` | `bot-config-defaults.json` → `minRebalanceIntervalMin` | Shortest wait between two rebalances of one position. |
| `MAX_REBALANCES_PER_DAY` | `5` | `bot-config-defaults.json` → `maxRebalancesPerDay` | Daily cap, counted per pool rather than per wallet. |
| `REBALANCE_RETRY_SWAP_LIMIT` | `8` | `app-runtime.json` → `tx.retrySwapLimit` | Consecutive retries after the price moved under a rebalance before the bot aborts it and waits for the operator. |
| `TX_SPEEDUP_SEC` | `120` | `app-runtime.json` → `tx.speedupSec` | Seconds a transaction may stay pending before a same-nonce replacement goes out at 1.5× gas. Range 1 to 120000 — see [Ranges on the timer settings](#ranges-on-the-timer-settings). |
| `DEADLINE_SEC` | `900` | `app-runtime.json` → `tx.deadlineSec` | On-chain deadline stamped into removeLiquidity, swap and mint calldata. Range 300 to 3600 seconds, five minutes to an hour. |
| `TX_CANCEL_SEC` | `3600` | **derived** — `app-runtime.json` → `tx.deadlineSec` × `tx.cancelToDeadlineMultiple` | Seconds before a stuck transaction is cancelled by a zero-value self-transfer at its nonce. Setting it here fixes it to one number and it stops tracking the deadline; raise `cancelToDeadlineMultiple` instead. Range 1 to 172800 — see [Ranges on the timer settings](#ranges-on-the-timer-settings). |
| `AGGREGATOR_URL` | `https://swap.watergun.pro/api/aggregator/369` | `chains.json` → `<chain>.aggregator.url` | The active chain's swap aggregator, chain path included — the Watergun Aggregator on PulseChain. Each chain names its own; an empty url means the chain has no aggregator, and every swap goes through the V3 router. A chain entry with no url at all stops the app at startup. `<chain>.aggregator.name` is how the "Route:" badge and the Rebalance Events table name the route; it is required whenever there is a url, so pointing this setting at another aggregator needs that name overridden to match. |
| `LOG_FILE` | `./app-data/rebalance_log.json` | `app-runtime.json` → `log.file` | Path to the JSON rebalance log, relative to the project root. |
| `DRY_RUN` | `false` | **none** — a run mode, not a setting | Connects, detects and polls, but sends no transactions. `true` or `false`. |
| `VERBOSE` | `false` | **none** — a run mode, not a setting | Verbose logging. `true` or `false`; `--verbose` and `-v` on the command line do the same thing. |

Five of these are Bot Configuration settings: `REBALANCE_OOR_THRESHOLD_PCT`,
`REBALANCE_TIMEOUT_MIN`, `IMPERMANENT_LOSS_GUARD_PCT`,
`MIN_REBALANCE_INTERVAL_MIN` and `MAX_REBALANCES_PER_DAY`. Each must fall
in its range in `setting-bounds.json`, as a dashboard save must. Unset or
empty, the default stands.

Every variable is read one way: an on/off variable is `true` or
`false`, a number is written in plain digits, an address is EIP-55, and
nothing is coerced. A value that is not, a value outside its range, or a
line in `.env` that sets something LP Ranger does not read, stops the
server and the bot at startup; see [Checking the Settings](#checking-the-settings).

#### RPC endpoints

The shipped list lives in `chains.json` under `rpc.urls`; the three variables
override it positionally, so setting only `RPC_URL` leaves the endpoints behind
it intact. See
[RPC Request Pacing and Log Chunking](#rpc-request-pacing-and-log-chunking).

There is a fourth source, and it outranks all of these: **Bot
Configuration → Network** in the dashboard. The **RPC URL** dropdown lists every endpoint in
the order the bot tries them, each marked `PRIMARY` or `FAILOVER`. The selected
option *is* the primary — picking a different one promotes it to the front of
the failover order immediately. **Add RPC** opens a dialog with Save and Close
buttons for entering a new endpoint, so one is only ever added deliberately.

What you add becomes the new primary, and everything already listed stays
behind it as automatic failover — so pointing LP Ranger at your own node does
not cost you redundancy. Add a second, and it becomes the primary in turn,
pushing the first down one place. Added endpoints are stored in
`bot-config.json` under `rpcUrls`, newest first. Duplicates are dropped keeping
the earliest position, which is what makes promotion work: selecting an
endpoint prepends it, and the duplicate further down is discarded. That holds
for shipped endpoints too, so selecting one of those records it under `rpcUrls`
as your preference.

Unlike the layers above, an addition is applied to the running process the
moment you save it; no restart. The endpoint is not contacted before being
added — an endpoint can be down at the moment you add it and fine a minute
later, and the failover list already handles one that never answers.

### Ranges on the timer settings

Three settings become a countdown the app schedules: `TX_SPEEDUP_SEC`,
`TX_CANCEL_SEC` and `CHECK_INTERVAL_SEC`. Each has a range. A value
outside it, in the JSON file or in `.env`, **stops the app from
starting**, with a message naming the setting and the limit. None of the
three is set from the dashboard; the values you can type there are
checked when you save — see
[What the dashboard accepts](#what-the-dashboard-accepts) below.

| Setting | Default | Range | Which bound sets it |
| ------- | ------- | ----- | ------------------- |
| `TX_SPEEDUP_SEC` | `120` | 1 to `120000` (33 hours) | 1000× the default, being under 48 hours |
| `TX_CANCEL_SEC` | `3600` | 1 to `172800` (48 hours) | 48 hours, since 1000× the default is 41 days |
| `CHECK_INTERVAL_SEC` | `300` | `10` to `3600` (one hour) | its own range — an hour between looks at a position is already past any use |

A fourth timer setting lives only in json: `aggregator.quoteTimeoutMs` in
`chains.json`, 15000 by default, which limits how long a swap waits for
the aggregator's quote. A quote that has not arrived by then counts as
failed, and the swap goes through the V3 router in the position's own
pool. It is checked at startup by the same rule, in milliseconds.

Most of them take the general bound: 1000× the setting's default or 48
hours, **whichever is lesser**. A setting with a small default stays near
it, and nothing gets past two days. A setting with a sensible range of its
own declares that instead, which the poll interval does.

**The same range applies wherever the setting is written** — the JSON file
and `.env` both ask `src/timer-bounds.js`, so a value one accepts the
other cannot refuse.

Lesser rather than greater is what keeps these safe. A countdown is held as
a 32-bit count of milliseconds — about 24.8 days — and the runtime will not
wait longer than that. Ask it to and it does not wait at all: it fires
immediately. Taking the greater would have given `TX_CANCEL_SEC` a ceiling
of 41 days, past that limit. Taking the lesser puts every setting an order
of magnitude inside it.

An over-ceiling value is refused rather than quietly lowered, because a
setting replaced by its default leaves the bot running on a schedule nobody
chose — and the schedule is then the last thing anyone would think to
check. Refusing to start, with a message naming the setting and its
ceiling, is the only form of this an operator can act on.

`TX_CANCEL_SEC`, when it is not set, is `deadlineSec ×
cancelToDeadlineMultiple`. With the shipped multiple of 4, the
deadline's own range keeps it between 20 minutes and four hours; only a
multiple above 48 could carry it past its 48-hour limit.

### Slippage is two settings

One per token, and nothing else. Bot Configuration → Execution has a
**Slippage When Swapping to Token 0** row and a **Slippage When Swapping
to Token 1** row, each naming its token. They may
hold the same figure; they are two rows because the two sides of a pair
often need different ones.

Which one applies to a swap is decided by where the swap is **going**,
not where it starts. Selling token 0 to buy token 1 uses Token 1's
figure; selling token 1 to buy token 0 uses Token 0's. The destination
side is where the value can be taken, so that is where the budget sits.

A token whose row is unset uses the default, `slippagePct` in
`bot-config-defaults.json` (0.75% as shipped) or your override of it.
Both rows show that default until you save your own. No environment
variable sets it.

**The figures in those rows are what the bot uses — for rebalances and
for compounds alike.** A single slippage value an older release saved per
position is no longer read, and is removed from your config file the next
time the app writes it. If you had one, both tokens use the default until
you set the two rows.

### What the dashboard accepts

Every value you can type into the dashboard has a range, and **the
server is what checks it** — not the page. Save sends what you typed; a
value outside the range comes back refused, with a dialog naming the
setting and the range, and the field shows again the value the server
holds for the position on screen. Nothing is saved, and you can edit and
save again.

Every range is defined once, in `setting-bounds.json`: saves are checked
against it, the shipped defaults are held to it, and the help quotes it.
Only the shipped copy is read: a range an override could widen would
bound nothing.

| Setting | Accepts |
| ------- | ------- |
| OOR Timeout | 0 to 1440 min (0 = off) |
| Min Time Between Rebalances | 1 to 10080 min (one week) |
| Max Rebalances per Day | 1 to 12 |
| Impermanent Loss Guard | 1 to 100% |
| OOR Threshold | 1 to 100% |
| Price Range Extension | 0.1 to 200% |
| Position Offset (Token 0 share) | 0 to 100%, whole numbers |
| Slippage When Swapping to Token 0 / Token 1 | 0.1 to 20% |
| Auto-Compound Threshold | at least the minimum fee a compound needs |
| Approval Multiple | 1 to 1,000,000 |
| Max Gas Fee | 0.1 to 15% |
| Total Lifetime Deposit | 0 or more |
| Token Price Override | 0 or more (0 clears it) |
| Token Decimals Override | 0 to 77 |
| RPC Endpoints | 1 to 10 addresses, each beginning `http://` or `https://` |

Two things that look like bad values are not. **An empty field clears
the setting**, so it falls back to the shipped default — that is how you
undo an override from the same box you set it in. And **zero is a real
setting** for some of them: a price override of zero means "no
override", and an OOR Timeout of zero switches the timeout off.

### Contract Addresses

**These are not editable from the dashboard, by design.** See
[why](#why-contract-addresses-are-not-editable) below.

The shipped addresses live in
`app-config/app-defaults-for-user-configurable/chains.json`, per chain:

```json
"contracts": {
  "positionManager": {
    "address": "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
    "mintGasLimit": 600000
  },
  "factory": "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68",
  "swapRouter": {
    "address": "0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA",
    "name": "9mm V3 Router"
  }
}
```

`swapRouter.name` is how the "Route:" badge and the Rebalance Events
table name a swap through the router. The app does not start
without it.

Canonical deployment addresses:
<https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json>

Override them in `app-config/user-configurable/chains.json`, the same way
as any other shipped default. `.env` accepts all three on the usual terms —
headless installs and experiments, outranking both JSON layers.

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `POSITION_MANAGER` | `0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2` | `chains.json` → `<chain>.contracts.positionManager.address` | NonfungiblePositionManager, the contract that holds every V3 position NFT. |
| `FACTORY` | `0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68` | `chains.json` → `<chain>.contracts.factory` | V3 Factory, used to resolve a pool address from its two tokens and fee tier. |
| `SWAP_ROUTER` | `0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA` | `chains.json` → `<chain>.contracts.swapRouter.address` | V3 SwapRouter, the fallback swap path when an aggregator quote cannot be used. |

In normal operation you should never set them. The only reason to is to
point the bot at a different deployment of the 9mm Pro V3 contracts, and
that needs a fresh install rather than an edit — see below.

#### Why contract addresses are not editable

Changing the Position Manager or Factory mid-life does not just change
where transactions go — it invalidates everything already on disk. Both
addresses are part of the scope key for every cache:

- the event cache (`event-cache-{cacheTag}-{contract}-{wallet}-…`)
- the LP position cache (`lp-position-cache-{cacheTag}-{contract}-{wallet}`)
- the epoch cache, keyed by `blockchain.contract.wallet.token0.token1.fee`
- per-position config in `bot-config.json`, keyed by a composite that
  includes the contract address

Change the address and every one of those keys stops matching. The old
entries are not wrong, they are simply unreachable — so the app would
rescan five years of history from scratch while the previous results sat
there orphaned, and any position keyed to the old contract would read as
missing.

**To change them, start from a fresh install of LP Ranger** rather than
editing an existing one: extract a new release into its own directory,
set the addresses there, and let it build its own caches. Do not carry
the old `app-config/user-configurable/` and `app-data/scan-cache/`
contents across with `migrate-app-state.js`, since those are exactly the
files scoped to the addresses you are leaving behind.

A `positionManager` or `factory` value left in an existing
`bot-config.json` from an older release is inert: nothing reads it, and
`POST /api/config` no longer accepts either key.

### What a Chain's Entry Describes

Nothing in LP Ranger's code names a blockchain. What it shows or works
out about one comes from that chain's entry in `chains.json`, and an
entry that leaves any of these out stops the app at startup, naming the
setting:

| Key | PulseChain | What it is for |
| --- | --- | --- |
| `displayName` | `PulseChain` | The chain's name wherever the dashboard and the logs show it. |
| `homepage`, `logo` | `https://pulsechain.com/`, `pulsechain-logo-transparent.png` | The chain link in the dashboard header; `logo` is a file under `public/`. |
| `tokenList.url` | `https://raw.githubusercontent.com/ninemm-pro/app-tokens/main/9mm-tokenlist-extended.json` | Where the dashboard reads token logos: a token list in the [Uniswap format](https://tokenlists.org), each token's logo at its `logoURI`, shown left of the token's name in the Pool line and atop Position Stats. On PulseChain, 9MM's extended list ([ninemm-pro/app-tokens](https://github.com/ninemm-pro/app-tokens)). `""` for a chain with none, where every token shows a transparent placeholder. |
| `blockTimeSec` | `10` | Average seconds per block, which turns a span of time into a block count: the history scan's lookback (`bot-config-defaults.json` → `historyLookbackYears`), and the compounder's reposition window (`app-runtime.json` → `compound.repositionWindowSec`). |
| `nativeCurrencySymbol` | `PLS` | The native token's symbol in messages and logs. |
| `nativeWrappedToken` | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | The wrapped native token, WPLS on PulseChain, or `""` where the chain has none. Gas is priced through it, fresh deposits of the native coin are recognised through it, and the Moralis key check asks its price. |
| `cacheTag` | `pulse` | Names the chain in cache file names and cache keys. Lower-case letters and digits, and distinct from every other chain's: two chains with one tag would share their caches. Changing PulseChain's orphans its existing caches and forces a full re-scan. |
| `priceServices` | `dexScreenerChain: pulsechain`, `geckoTerminalNetwork: pulsechain`, `moralisChain: 0x171` | The chain's id at each price service, or `""` where a service does not cover it, which is then not asked. |

The dust threshold's reference tokens are not on the active chain, so
each carries its own `moralisChain` and `dexScreenerChain` in
`dust-threshold.json`.

#### How a chain's transactions are priced

The same holds for gas: each entry says how its own transactions are
priced and bounded, and an entry that leaves one out stops the app at
startup, naming it.

| Key | PulseChain | What it is for |
| --- | --- | --- |
| `transactionEnvelopeType` | `legacy` | `legacy` or `eip1559`, the envelope every send is stamped with. |
| `gasPriceMultiplier` | `7` | Scales the network's gas price for every send. |
| `gasLimitMultiplier` | `2` | Buffers every gas estimate. |
| `gasLimitFloor` | `300000` | The least gas limit a send is given when the code sending it names no floor of its own: approvals, the compound's collect and increaseLiquidity, and a swap through the V3 router. A failed estimate sends with it. |
| `contracts.positionManager.mintGasLimit` | `600000` | The floor under every mint and every liquidity removal. |
| `speedUpGasBump` | `1.5` | A transaction still pending after `TX_SPEEDUP_SEC` is resent at its nonce priced this many times the higher of the network's price and its own. |
| `cancelGasBump` | `2` | The zero-value cancel sent at `TX_CANCEL_SEC` is priced this many times the higher of the network's price and the stuck transaction's, so it outbids what it replaces. |
| `estimatedRebalanceGasUnits` | `800000` | The gas a whole rebalance is priced at before it starts, to decide whether it waits (`rebalanceGasDeferPct`); also a period's gas when a rebalance reports none. |
| `aggregator.estimatedSwapGasUnits` | `500000` | What the swap gas gate prices a swap at, the router's included, so it is required with or without an aggregator. |
| `aggregator.gasUnitsWhenQuoteOmitsGas` | `300000` | Gas units an aggregator swap is sent with when its quote names none; times `gasLimitMultiplier`, like the quote's own figure. Required whenever there is an aggregator. |

### File Paths and Diagnostics

These are not operator settings. Each one redirects a single file that a
module owns. **Leave every one of them unset in a normal install** — the
defaults are the layout the rest of the app, `npm run clean` and the
upgrade scripts all expect.

The eight path overrides exist for one purpose: so that a test run can never
write over a production file, whatever directory it is invoked from. Each is
read by the module named on its row, not by `config.js`. None has a JSON
counterpart, and none should — a key in a shipped defaults file would present
these as a supported way to lay out an install, which they are not.

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `WALLET_FILE_PATH` | `app-config/user-configurable/wallet.json` | **none** | Encrypted wallet file, read and written by [`src/wallet-manager.js`](../src/wallet-manager.js). |
| `API_KEYS_FILE_PATH` | `app-config/user-configurable/api-keys.json` | **none** | Encrypted third-party API keys, read and written by [`src/api-key-store.js`](../src/api-key-store.js). |
| `PRICE_CACHE_PATH` | `app-data/scan-cache/historical-price-cache.json` | **none** | Historical USD price cache ([`src/price-cache.js`](../src/price-cache.js)). |
| `BLOCK_TIME_CACHE_PATH` | `app-data/scan-cache/block-time-cache.json` | **none** | Block-number-to-timestamp cache ([`src/block-time-cache.js`](../src/block-time-cache.js)). |
| `GECKO_POOL_CACHE_PATH` | `app-data/scan-cache/gecko-pool-cache.json` | **none** | Which way round GeckoTerminal quotes each pool ([`src/gecko-pool-cache.js`](../src/gecko-pool-cache.js)). |
| `LIQUIDITY_PAIR_DETAILS_CACHE_PATH` | `app-data/scan-cache/liquidity-pair-details-cache.json` | **none** | Initial-residual snapshot per pool scope ([`src/liquidity-pair-details.js`](../src/liquidity-pair-details.js)). |
| `POOL_CREATION_BLOCK_CACHE_PATH` | `app-data/scan-cache/pool-creation-blocks-cache.json` | **none** | Resolved pool deployment blocks ([`src/pool-creation-block.js`](../src/pool-creation-block.js)). |
| `TOKEN_SYMBOL_CACHE_PATH` | `app-data/scan-cache/token-symbol-cache.json` | **none** | Token names and symbols read from the chain ([`src/token-symbol-cache.js`](../src/token-symbol-cache.js)). |
| `INSPECTOR_PORT` | `9229` | **none** | Port `npm run debug-attach` reports the V8 inspector on ([`scripts/_debug-attach.js`](../scripts/_debug-attach.js)). |
| `LP_RANGER_PID` | *(unset)* | **none** | The process for `npm run debug-attach` to signal, for when its port and `pgrep` lookups find the wrong one. It changes with every start, so it suits the command line better than `.env`. |
| `MORALIS_API_KEY` | *(unset)* | **none** | Read only by `util/diagnostic/verify-compound-usd`. The key LP Ranger itself prices with is the one entered in Settings, stored encrypted in `api-keys.json`; this variable does not change it. |

### Where Other Configuration Lives

Everything not listed in this section — per-chain tunables, contract
addresses, bot-behaviour defaults, managed positions, the encrypted wallet
and the encrypted API keys — lives in the JSON files under `app-config/`.
See [Where each setting lives](#where-each-setting-lives) for the file-by-file
table, and
[The `app-config` Directory](engineering.md#the-app-config-directory) in the
engineering reference for the full inventory.

---

## RPC Request Pacing and Log Chunking

Three settings govern how LP Ranger talks to an RPC endpoint. All live in
`app-config/app-defaults-for-user-configurable/bot-config-defaults.json` and
all are deliberately **absent from the dashboard**. The first two are a pair:
the chunk size decides how many requests a scan produces, the interval decides
how fast they leave. The third decides what happens when no endpoint answers
at all.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `getLogsChunkSize` | `9000` | Maximum block span per `eth_getLogs` call |
| `globalRPCRequestRateIntervalMS` | `222` | Minimum gap between *any* two requests, in milliseconds, 5 to 2000 |
| `rpcAllEndpointsDownPauseMS` | `3600000` | How long to hold every request once failover has tried every endpoint and none answered |

They are not exposed in the GUI because they should never need changing in
normal operation, and they are not in `GLOBAL_KEYS`, so they never reach
`POST /api/config` or the OpenAPI schema. Override them by editing the file
under `app-config/user-configurable/` and restarting.

### When an endpoint is deemed out of service

What moves failover off an endpoint is a failure *rate*, not a single error.
Every RPC outcome in the process — reads, writes, gas estimates, the
pool-state and wallet-balance walks, successes as well as failures — is
reported to one decider, and an endpoint is left only once it is failing more
than `rpcFailoverRatePercentage` of what it is asked inside the last
`rpcFailoverRateDurationMinutes`. Successes are counted because a rate needs
a denominator.

A single 502 therefore costs nothing. That is what lets the components which
fail often and legitimately report what they see, rather than staying silent
to avoid retiring an endpoint on the whole process's behalf.

An HTTP 429 is the exception that is waited out rather than moved off: it
says this process is sending too fast, and moving would carry the same rate
to the next endpoint. `rpcRetryOn429DelaysMs` is the schedule for one refused
request, and `rpcMax429PenaltyMs` caps the standing per-endpoint penalty that
every request to that endpoint honours.

### When every endpoint is down

Failover walks the endpoint list in order. Stepping off the last one starts
the wait: every JSON-RPC request is held for `rpcAllEndpointsDownPauseMS`
(one hour by default), and a line in Road Sign Yellow says so, in capitals,
stating the wait in hours. The bot stays on the endpoint it was on for the
duration — there is nothing to move to — and when the wait is up the list
starts over at its first endpoint, so later failovers walk it in the order
they walked it at startup.

The hold is absolute. A rebalance or compound waits it out like every other
request; a rebalance held between its liquidity removal and its mint leaves
that position drained until the wait ends. Dashboard figures stop advancing
for the duration, which is what the yellow line exists to explain.

Set it to `0` to disable the wait entirely — the bot then keeps cycling
through the endpoints continuously. The ceiling is two days, which is far
past any outage worth waiting out. Unlike the two settings above, this one is
read each time the list is exhausted, so a change to it takes effect without
a restart.

### Why chunking exists

RPC endpoints cap how wide a single log query may be. `rpc-pulsechain.g4mm4.io`
rejects anything over 10,000 blocks with JSON-RPC `-32602`, "eth_getLogs is
limited to a 10000 block range". A five-year history scan asks for ~15.8M
blocks, so without splitting, the query simply fails.

`src/get-logs-chunked.js` is the only place that arithmetic lives. Callers hand
it a range and a query function; it walks the range in capped windows.

The default of 9,000 is 90% of the published 10,000-block limit, verified
accepted on all three configured endpoints. `g4mm4` enforces 10,000 exactly —
12,000 is rejected — while `rpc.pulsechain.com` and `rpc.pulsechain.box` accept
wider, so 10,000 is the binding figure. The remaining 1,000 blocks of headroom
cover an endpoint that enforces slightly under its published limit. Its
range in `setting-bounds.json` stops at 10,000.

**Failures propagate.** A chunk that fails fails the scan, unless a call site
explicitly opts into `bestEffort`. Swallowing a query error and returning an
empty array would report "this wallet has no deposits" when the truth is "we
could not read", and callers act on those two answers in opposite directions —
an empty scan result is taken as settled fact, not as a gap to retry. When an
endpoint rejects a range, the error names the span, the cap and this setting,
because ethers reports a JSON-RPC `-32602` as a generic `UNKNOWN_ERROR` with
the real code nested, which is not actionable as raised.

### Why pacing is global

Rate limits are published per IP, not per endpoint object or per scan. This
process may hold three providers and run a history scan while the bot polls, all
from one address. `src/rpc-request-manager.js` is therefore a single FIFO queue
for the whole process: every request enqueues and is released one at a time on a
fixed schedule.

It is **agnostic to request content** — it never inspects the method, the params
or the caller. That is the design, not an omission: a uniform release schedule is
the only thing that actually guarantees a rate, and every exception (a fast path
for reads, a priority lane for transactions) is a hole the rate escapes through.
If something needs to go sooner, the answer is a shorter interval.

It is wired in by `buildProvider` (`src/bot-provider.js`), which wraps ethers'
`send()` — the single funnel all JSON-RPC traffic passes through, reads and
writes alike. Anything added later is paced automatically, with nothing to
remember at the call site. A delay between chunks could not do this job: a
chunk fires two to four queries in parallel.

### Cost

Serializing removes parallelism, so scan time is roughly *requests x interval*.
A full scan over the shipped five-year lookback (`historyLookbackYears`) is
~1,750 chunks / ~3,500 requests, about 13 minutes at the defaults. Raising
`getLogsChunkSize` (up to the 10,000 cap) is the single lever if that is too
slow; lowering it is the fix if an endpoint rejects a query.

That figure is the worst case, and in practice almost nothing scans that
wide. What actually determines a cold start is **where each scan starts**,
and every scan in the app starts from a bound it already knows:

| Scan | Starts at |
| --- | --- |
| Pool rebalance events | the later of the history lookback's floor, the pool's creation block, and the last cached block |
| Per-NFT event history | that NFT's own mint block, and runs to the current block |
| Pool creation lookup | the newest block, working backwards, stopping at the first match |

The per-NFT floor is the one that moves the needle on a long rebalance
chain. Every scan runs to the current block, including a retired NFT's:
a dust mint left by a failed rebalance looks exactly like a real one in
the Transfer log, so the app never assumes an NFT has stopped emitting —
one that appears replaced can still hold coins and release them later.
The saving comes from the floor. On a 132-rebalance position in a pool
two years older than the first deposit, that is up to 168 chunked queries
per NFT instead of 954. See
[Per-NFT Scan Windows](engineering.md#per-nft-scan-windows).

- **The bot's polling shares the queue with any running scan.** A long
  scan slows ordinary poll cycles and vice versa — they interleave, each
  at roughly half rate, rather than one blocking the other.
- **An interrupted scan starts over.** The pool rebalance-event scan
  saves its progress only when it completes. The per-NFT event history
  is read afresh after a restart. Interrupting a long first scan means
  the next start repeats it. Let the first one finish.

---

## Other Operator Tunables

These have no control in the dashboard and should not need changing in
normal operation. Each lives in one shipped file, and its comment in that
file explains the figure. Override one the usual way, in the matching file
under `app-config/user-configurable/`, and restart. A value that cannot
work, or is outside its range, stops the app at startup, naming the
setting. Ranges are in `setting-bounds.json` at the same key.

### Failover and the reads someone waits on

In `bot-config-defaults.json`. `boundedReadRetryDelayMs` becomes a timer,
so it is bounded like the timer settings above.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `rpcFailoverStickyMs` | `3600000` | How long failover stays on the endpoint it moved to before reads go back to the first one. 1 minute to 2 days. |
| `boundedReadAttemptsPerEndpoint` | `2` | How often each endpoint in service is asked for pool state, or for the wallet balances behind the re-open check, before the read reports itself unavailable. 1 to 10. |
| `boundedReadRetryDelayMs` | `3000` | The wait before asking the same endpoint again. Moving to another endpoint is not a reason to wait. |

### History scans

In `bot-config-defaults.json`.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `historyLookbackYears` | `5` | How far back the rebalance-history and closed-position scans reach, turned into blocks at the chain's `blockTimeSec`. 1 to 20. |
| `eventCacheTtlMs` | `31536000000` | How long the on-disk event cache keeps a pool's history after its last write (a year); [When a File Changes](engineering.md#when-a-file-changes) says what writes it. One hour to ten years. |
| `poolScanReuseMs` | `60000` | How long a finished scan is handed to the next view asking for the same pool and wallet, instead of scanning again. `0` turns reuse off; at most one hour. |
| `rebalancePairingWindowSec` | `300` | The most seconds between an NFT leaving the wallet and a new one arriving for the two to be read as one rebalance. 1 to 86400. |
| `feeDataLogIntervalMs` | `3600000` | How often the network's gas price is written to the log; `--verbose` logs every read. One second to one day. |

### Swaps and the throttle

In `bot-config-defaults.json`. An override of `throttleDoubling` changes
the rule the bot enforces and the numbers the dashboard shows.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `swapChunkCount` | `3` | How many equal parts a swap is split into when the aggregator refuses it whole for a price impact above slippage, before the V3 router. At least 2. |
| `minSwapAmountRaw` | `1000` | The least amount worth swapping, in the token's smallest unit; less is skipped. |
| `slippageSuggestionMarginPct` | `0.5` | Percentage points a "raise slippage to" message adds to the impact it saw, once rounded up to a tenth of a percent. |
| `correctiveSwapMaxRounds` | `3` | The most corrective swaps one rebalance makes after its main swap moved the pool's own price and left the coins off the new range's ratio. 1 to 10. |
| `throttleDoubling.triggerCount` | `3` | Rebalances inside the trigger window that switch doubling mode on. 2 to 12. |
| `throttleDoubling.triggerWindowMultiple` | `4` | The trigger window, as a multiple of Min Time Between Rebalances. A whole number, 1 to 1440. |
| `throttleDoubling.quietWindowMultiple` | `4` | The quiet spell that clears doubling mode, as a multiple of the current doubled wait. A whole number, 1 to 1440. |

### Waiting for gas

In `bot-config-defaults.json`. `gasDeferRetrySec` becomes a timer, so it
is bounded like the timer settings above.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `rebalanceGasDeferPct` | `0.5` | A rebalance waits when its gas, `estimatedRebalanceGasUnits` at the current gas price, would cost more than this percent of the position's value. |
| `gasDeferRetrySec` | `3600` | How long a waiting rebalance waits before the bot looks again, in place of the poll interval, until gas comes down or a rebalance goes through. |

### Sending and stopping

In `app-runtime.json`.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `tx.sendRetries` | `3` | How often a send that failed for a passing reason is sent again. `0` to `10`. |
| `tx.sendRetryBaseDelayMs` | `30000` | The wait before the first retry; each later retry waits one more of it (30, 60 and 90 seconds as shipped). |
| `tx.cancelPhaseFloorSec` | `10` | The least time a sped-up transaction gets to confirm before the cancel goes out. |
| `tx.swapBackoffBaseMs` | `60000` | After the price moved under a rebalance, the wait before it is tried again; each failure in a row doubles it. One second to an hour. |
| `tx.swapBackoffMaxMs` | `1200000` | The longest that wait may grow. One second to a day. |
| `tx.midwayRetryLimit` | `4` | How many times a rebalance left mid-way, its coins in the wallet, is tried again before the bot aborts and asks you to act. 1 to 20. |
| `poll.afterActionMs` | `2000` | How soon the bot looks again after a rebalance, compound or cancel, so the dashboard shows the result. |
| `poll.lifetimeRescanCheckMs` | `1800000` | How often the bot checks whether a position's lifetime figures need their scan run again, and runs it if so. |
| `retire.drainedAfterMs` | `1800000` | How long a managed position may sit drained, with no rebalance under way, before LP Ranger stops managing it. A rebalance aborted after its drain counts. One minute to two days. |
| `shutdown.exitTimeoutMs` | `3000` | How long the server spends stopping before it exits regardless. One second to one minute. |
| `shutdown.stopKillMarginMs` | `2000` | How much longer `npm stop` waits, after that, before it falls back to SIGKILL. Half a second to one minute. |
| `shutdown.stopCheckIntervalMs` | `100` | How often `npm stop`, and `npm run gentle-stop` once the server has taken its stop, check whether the server has gone. 10 milliseconds to five seconds. |
| `shutdown.gentleStopPollMs` | `300000` | How often `npm run gentle-stop` asks whether a rebalance or compound is under way, and how long it waits for each answer. One second to one hour. |
| `dashboard.pollsBeforeAssumedSeen` | `2.5` | How many dashboard polls the server waits, after a change the dashboard must show, before assuming it was seen: the alert for a failed re-open comes up before the position is retired. 1 to 100. |
| `compound.autoSpacingPolls` | `5` | The least time between two automatic compounds of one position, in polls of `CHECK_INTERVAL_SEC`. 1 to 100. |
| `compound.autoSpacingFloorSec` | `300` | The floor under that time, in seconds, however short the poll interval. Compound Now is held to neither. 1 to 86400. |

### Logs and price services

| File | Setting | Default | What it governs |
| ---- | ------- | ------- | --------------- |
| `logging.json` | `errorLogPath` | `logs/error.log` | Where catastrophic failures are recorded. Emptied at every startup; the dashboard's alert for one names this file. |
| `price-services.json` | `dexScreener.baseUrl` | `https://api.dexscreener.com` | DexScreener's api. |
| `price-services.json` | `geckoTerminal.baseUrl` | `https://api.geckoterminal.com/api/v2` | GeckoTerminal's api, with its version. |
| `price-services.json` | `geckoTerminal.topPoolsConsidered` | `10` | How many of GeckoTerminal's top-ranked pools for a token are considered for its historical price. At least 1. |
| `price-services.json` | `moralis.baseUrl` | `https://deep-index.moralis.io/api/v2.2` | Moralis's api, with its version. |

### Dashboard settings the server sends

In `ui-defaults_non-layout_for-server-up-scenario.json`. The server reads
them at startup and sends them to the dashboard, so an override takes
effect after a restart and a page reload. Startup stops on a value
outside its range in `setting-bounds.json`, or, for the timers
`dashboardPollIntervalMs`, `staleDataCheckIntervalMs`, `copyFeedbackMs`
and `heapLogIntervalMs`, the timer rule. A choice saved in the Settings popover overrides the sounds
and privacy defaults.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `dashboardPollIntervalMs` | `3000` | How often the dashboard asks the server for fresh figures. Half a second to a minute. |
| `staleDataCheckIntervalMs` | `50` | How often the dashboard checks whether its figures are still another position's. From a switch to another position until the server answers about it, every figure shows a dash and every button is disabled, except in the disclaimer and the wallet unlock. Ten milliseconds to a second. |
| `reloadMaxWaitMs` | `14400000` | How long Reload Current Position waits for its scan before reloading the page anyway; its dialogs quote the same figure. |
| `slippageConfirmAbovePct` | `5` | A per-token slippage saved above this asks for a click on Confirm first. The dialog quotes it. |
| `slippageTypedConfirmFromPct` | `10` | A per-token slippage saved at this or more asks for Confirm to be typed. The dialog quotes it. |
| `pollSkipLogEvery` | `20` | While a slow server holds a poll, one console line per this many skipped polls. |
| `lastCheckJustNowSec` | `5` | How long Mission Control's last-check tag reads "just now". |
| `autoCompoundSyncHoldMs` | `5000` | How long after Stop Managing the Auto-Compound toggle is left alone by status polls. |
| `throttleNearLimitPct` | `80` | The share of Max Rebalances / Day at which the throttle badge reads NEAR LIMIT. |
| `activityLogMaxEntries` | `500` | How many entries the Activity Log keeps. |
| `copyFeedbackMs` | `1200` | How long a copy icon shows that it copied. |
| `heapLogIntervalMs` | `600000` | How often the dashboard logs its heap size to the browser console. |
| `soundsEnabled` | `true` | Whether sounds play. |
| `privacyModeEnabled` | `false` | Whether Privacy Mode is on. |
| `privacyBlurWalletAddresses` | `true` | Whether Privacy Mode blurs wallet addresses. |
| `privacyBlurUsdAmounts` | `true` | Whether Privacy Mode blurs USD amounts above the threshold, and every coin amount. |
| `privacyUsdAmountThreshold` | `99` | The USD amount Privacy Mode blurs above. |

### Dashboard settings built into the page

In `ui-defaults_non-layout_for-server-down-scenario.json`. The dashboard
needs these while it cannot reach the server, so `npm run build` builds
them into the page. An override has no effect; change the shipped value
and rebuild.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `chainQueryTimeoutMs` | `3000` | How long the dashboard gives the server to answer each startup question before it asks again. |
| `pollFailuresBeforeHalted` | `3` | Questions to the server left unanswered in a row before the status pill reads HALTED. The startup questions count, and so does every status poll after them. |

The dialog height, `dialogMaxHeightPx` in `ui-defaults_layout.json`, is
built into the CSS; an override takes effect at the next `npm run build`.
