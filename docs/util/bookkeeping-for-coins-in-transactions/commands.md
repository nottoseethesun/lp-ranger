# Bookkeeping for Coins in Transactions — Commands

Every command of the bookkeeping tools, what it does, and what to type.

Companion to [`engineering.md`](engineering.md), which covers how the
tools work, and to [`user-manual.md`](user-manual.md), which covers
using them. This file covers how to drive them.

---

## Table of Contents

- [Running a Command](#running-a-command)
- [Getting Help on Any Command](#getting-help-on-any-command)
- [The Commands](#the-commands)
- [Options](#options)
  - [`coins-in-transaction.js`](#coins-in-transactionjs)
  - [`coins-in-transactions-on-wallet`](#coins-in-transactions-on-wallet)
- [Exit Status](#exit-status)
- [Command Notes](#command-notes)
  - [Time Zones](#time-zones)
  - [The Blockchain, the Endpoint and the Position Manager](#the-blockchain-the-endpoint-and-the-position-manager)
  - [What a Run Prints and Writes](#what-a-run-prints-and-writes)
  - [The Password Prompt](#the-password-prompt)
  - [One Run at a Time](#one-run-at-a-time)
  - [Running Alongside LP Ranger](#running-alongside-lp-ranger)
  - [Testing the Tools](#testing-the-tools)
- [See Also](#see-also)

---

## Running a Command

The tools are not npm scripts. Run each with `node`, from LP Ranger's
folder: from there they find LP Ranger's configuration, its records in
`app-data/`, and the file its Moralis key is kept in.

```sh
node util/bookkeeping/coins-in-transaction.js <transaction hash> --wallet <wallet address>
node util/bookkeeping/coins-in-transactions-on-wallet --wallet <wallet address> \
     --start-date 2026-10-01 --end-date 2026-10-31 --time-zone America/Chicago
```

Options follow the command directly, with no `--` before them: that
separator is npm's, and these commands do not run through npm.

---

## Getting Help on Any Command

Each tool takes `--help`, or `-h`. It prints the usage, every option and
the tool's reference, then exits without reading the chain or asking
for a password:

```sh
node util/bookkeeping/coins-in-transaction.js --help
node util/bookkeeping/coins-in-transactions-on-wallet --help
```

The one-transaction tool's reference names each field of the json
object it prints. The report's names the time zones it takes, the
configuration it reads, each column of the csv, where its prices come
from and the key they need, the last whole day, which transactions it
lists, and what stops a run. Each tool renders its help from the same
declaration it parses its options with, so the help and the tables
below describe the same options.

---

## The Commands

| Command | Options | Description | Example |
| ------- | ------- | ----------- | ------- |
| `coins-in-transaction.js` | `<hash>`, `--wallet`, `--blockchain`, `--rpc-endpoint`, `--position-manager`, `--help`/`-h` | Prints, as json, what one transaction moved for a wallet: its kind, the position manager's liquidity events, a drain's fees, the wallet's coin transfers and approvals, and the gas paid. Reads one receipt; writes nothing and sends nothing. | `node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address>` · `node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address> > transaction.json` |
| `coins-in-transactions-on-wallet` | `--wallet`, `--start-date`, `--end-date`, `--time-zone`, `--list-valid-timezones`, `--blockchain`, `--rpc-endpoint`, `--position-manager`, `--help`/`-h` | Writes a csv of every transaction of a wallet's rebalances and compounds in a range of days, one row per transaction, with the coins it moved and the gas it paid, each with its value in USD. Asks for the Moralis key's password first. Sends nothing. | `node util/bookkeeping/coins-in-transactions-on-wallet --wallet <address> --start-date 2026-10-01 --end-date 2026-10-31 --time-zone America/Chicago` · `node util/bookkeeping/coins-in-transactions-on-wallet --list-valid-timezones` |

---

## Options

Every option takes its value after a space, as in `--wallet 0x…`. An
address may be written in any letter case.

### `coins-in-transaction.js`

| Option | Value | Default | What it does |
| ------ | ----- | ------- | ------------ |
| `<hash>` | `0x` and 64 hex digits | None; required | The transaction to read |
| `--wallet` | An address | None; required | The wallet whose coins count: its transfers, its approvals and its gas |
| `--blockchain` | A chain the configuration names, such as `pulsechain` | LP Ranger's own: `CHAIN_NAME` in `.env`, else `pulsechain` as shipped | The blockchain to read |
| `--rpc-endpoint` | An `http` or `https` url | The endpoint LP Ranger tries first | The endpoint asked for the receipt |
| `--position-manager` | An address | LP Ranger's: `chains.json` → `contracts.positionManager` | The position manager whose events are read as liquidity events |
| `--help`, `-h` | — | — | Prints the help and exits |

### `coins-in-transactions-on-wallet`

| Option | Value | Default | What it does |
| ------ | ----- | ------- | ------------ |
| `--wallet` | An address | None; required | The wallet whose rebalances and compounds to report |
| `--start-date` | A date, `YYYY-MM-DD` | None; required | The first day of the range, in the time zone named |
| `--end-date` | A date, `YYYY-MM-DD` | None; required | The last day of the range, included. A range reaching past the [last whole day](user-manual.md#time-zones-and-the-last-whole-day) is cut there |
| `--time-zone` | A full time zone name, such as `America/Chicago`, or `UTC` | None; required. Without it, the run stops and offers the computer's own zone | The time zone the days are in |
| `--list-valid-timezones` | — | — | Prints every name `--time-zone` takes, one per line, and exits. Needs no other option |
| `--blockchain` | A chain the configuration names | LP Ranger's own | The blockchain to read |
| `--rpc-endpoint` | An `http` or `https` url | The endpoint LP Ranger tries first | The endpoint asked for every chain read |
| `--position-manager` | An address | LP Ranger's | The position manager whose positions to report |
| `--help`, `-h` | — | — | Prints the help and exits |

A date must be one the calendar has: `2026-02-30` is refused. A start
date after the end date is refused too.

---

## Exit Status

| Status | `coins-in-transaction.js` | `coins-in-transactions-on-wallet` |
| ------ | ------------------------- | --------------------------------- |
| 0 | The receipt was read and printed, or the help was | The csv was written, or the time zones or the help were printed |
| 1 | An argument was refused, there was no receipt (the transaction is not mined yet, or not on this blockchain), or the endpoint failed | An argument was refused, or no csv was written: no day of the range is whole yet, another run holds the lock, the key could not be had, the endpoint failed, a coin had no price, or the password prompt was left with Ctrl+C or no answer |
| 128 and the signal's number | Stopped by a signal, as a shell reports it: 130 for Ctrl+C | The same, once past the prompt; a run holding the lock releases it first |

A script can rely on 0 alone: any other status means no csv was written.

---

## Command Notes

Detail the tables above cannot carry.

### Time Zones

Which names `--time-zone` takes, how the days of a range are counted,
and where a range ends are in
[Time Zones and the Last Whole Day](user-manual.md#time-zones-and-the-last-whole-day).

### The Blockchain, the Endpoint and the Position Manager

Each is LP Ranger's own unless an option names another. The tools read
LP Ranger's configuration as LP Ranger does: `.env`, then the settings
in `app-config/` ([Configuration](engineering.md#configuration)).

- `--blockchain <name>` reads another blockchain the configuration
  names. A run reads one blockchain. When the configuration names more
  than one, each run says so on stderr, naming the one it reads and
  listing the others.
- `--rpc-endpoint <url>` asks another endpoint. A run asks one endpoint,
  and moves to no other: when it fails, the run stops with the error and
  suggests this option. The report needs an endpoint that keeps the
  state of past blocks, since it asks how many transactions the wallet
  had sent by a past block.
- `--position-manager <address>` reads another position manager's
  events. The report then covers the positions LP Ranger recorded at
  that position manager.

### What a Run Prints and Writes

`coins-in-transaction.js` prints the json object on stdout and every
other line on stderr, so the object can be redirected to a file whole:

```sh
node util/bookkeeping/coins-in-transaction.js <hash> --wallet <address> > transaction.json
```

It writes no file of its own.

`coins-in-transactions-on-wallet` prints a line as it starts, saying how
many rebalances and compounds `app-data/` records near the range and
which endpoint it reads. It prints a line for each move as it finishes
it, and its last line names the csv:

```text
Wrote 9 transactions, from 1 rebalances, 1 compounds and 1 deposits, to …/app-data/util/bookkeeping/<wallet>_<start>-to-<end>_<zone>_coins-in-transactions.csv
```

A slash in the zone is written as a dash, so `America/Chicago` becomes
`America-Chicago`. When the range is cut at the last whole day, the file
is named for the days it covers. A run with the same wallet, days and
zone replaces the file. The prices a run fetches stay in
`app-data/util/bookkeeping/scan-cache/`, so a later run asks only for
those not yet kept. `npm run clean` leaves `app-data/util/bookkeeping/`
in place.

### The Password Prompt

The report asks for the Moralis key's password, which is LP Ranger's
wallet password, at a prompt that shows nothing as it is typed. The
password is never an option, since shell history and `ps` would keep
it. Each prompt and answer is in
[The Moralis Key](user-manual.md#the-moralis-key).

### One Run at a Time

One run of the report prices at a time, and a run started meanwhile
stops at once, with exit status 1. Its message, and how to release a
lock that a killed run left, are in
[One Run at a Time](user-manual.md#one-run-at-a-time).

### Running Alongside LP Ranger

Both tools are safe to run while LP Ranger runs; the
[FAQ](user-manual.md#faq) says why, and names the one thing to avoid
meanwhile.

### Testing the Tools

`npm run test:util` runs every test under `util/`, the bookkeeping
tools' among them, and `npm run check` runs them with the rest. Read
[Before Running Any Lint or Test Command](../../npm-project-commands.md#before-running-any-lint-or-test-command)
first. Which file tests what is in [Tests](engineering.md#tests).

---

## See Also

- [`engineering.md`](engineering.md) — how the tools work, and the
  procedures they run.
- [`user-manual.md`](user-manual.md) — running a report, and reading its
  csv.
- [`docs/npm-project-commands.md`](../../npm-project-commands.md) —
  LP Ranger's own commands.
- [`docs/configuration.md`](../../configuration.md) — every setting the
  tools read from LP Ranger's configuration.
