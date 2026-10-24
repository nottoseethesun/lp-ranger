# Bookkeeping for Coins in Transactions — Engineering Reference

This is the canonical reference for bookkeeping in coins: what each
transaction behind an LP position moves, which of those amounts LP Ranger
already records, how to read the rest from the blockchain, and how the
two command-line tools in `util/bookkeeping/` do it. It deals in coin
amounts. Only the wallet report adds what each amount was worth in USD.

**Using the tools has its own manual:**
[`user-manual.md`](user-manual.md) — how to run a report, how to read its
csv, and what to do when a run stops.

**The commands have their own reference:** [`commands.md`](commands.md) —
each tool's options, their defaults, and an example of each.

For LP Ranger itself, see its [Engineering Reference](../../engineering.md)
and [`docs/architecture.md`](../../architecture.md). The tools read LP
Ranger's configuration, its records and its price library, and this
reference names each part of LP Ranger they use.

---

## Table of Contents

- [Terminology](#terminology)
- [Commands](#commands) → [`commands.md`](commands.md)
- [Engineering Design](#engineering-design)
  - [System View](#system-view)
  - [Sequence View](#sequence-view)
- [The Kinds of Transaction](#the-kinds-of-transaction)
  - [Principal and Fees in a Drain](#principal-and-fees-in-a-drain)
  - [The Coins in a Swap](#the-coins-in-a-swap)
  - [Paying or Receiving PLS](#paying-or-receiving-pls)
- [How LP Ranger Sends Them](#how-lp-ranger-sends-them)
  - [A Rebalance](#a-rebalance)
  - [A Compound](#a-compound)
  - [Retries, Speed-Ups and Cancels](#retries-speed-ups-and-cancels)
- [What `app-data/` Records](#what-app-data-records)
  - [The Rebalance Log](#the-rebalance-log)
  - [The Position Records](#the-position-records)
  - [The Scan Caches](#the-scan-caches)
- [Reading the Chain](#reading-the-chain)
  - [One Receipt per Known Transaction](#one-receipt-per-known-transaction)
  - [Finding the Transactions the Files Do Not Name](#finding-the-transactions-the-files-do-not-name)
  - [Event Signatures](#event-signatures)
- [Step by Step](#step-by-step)
  - [Recording a Rebalance](#recording-a-rebalance)
  - [Recording a Compound](#recording-a-compound)
  - [Recording a Failed Attempt](#recording-a-failed-attempt)
  - [Recording the Owner's Own Transactions](#recording-the-owners-own-transactions)
- [The Wallet Report](#the-wallet-report) → using it: [`user-manual.md`](user-manual.md)
  - [Which Transactions It Lists](#which-transactions-it-lists)
  - [Prices](#prices)
  - [One Run at a Time](#one-run-at-a-time)
  - [The Moralis Key](#the-moralis-key)
  - [The Last Whole Day](#the-last-whole-day)
  - [When a Run Stops](#when-a-run-stops)
  - [The Rows](#the-rows)
- [Configuration](#configuration)
- [Modules](#modules)
- [Tests](#tests)

---

## Terminology

**Record.** What bookkeeping keeps of one transaction: the coins that
left the wallet, the coins that came in, and the gas it paid. Its date
is the time of the block it was mined in.

**Position and NFT.** A position is liquidity in one pool, held by the
wallet as an NFT. The **position manager** is the contract that holds
these NFTs and moves their coins. On PulseChain it is 9mm Pro's, at
`0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2` (`chains.json` →
`contracts.positionManager`). A rebalance moves a position's coins out
of its NFT and into a new one, so over time one position is a chain of
NFTs. Each NFT has an id, which events and LP Ranger's files call
`tokenId`.

**Coins.** A pool has two coins, which LP Ranger's files call `token0`
and `token1`. An amount named with a 0, such as `amount0`, is
`token0`'s, and one named with a 1 is `token1`'s. Each coin is a
contract, named by its address. PLS, PulseChain's own coin, is the
exception: see [Paying or Receiving PLS](#paying-or-receiving-pls).

**Raw amounts and decimals.** The chain records each amount as a whole
number of the coin's smallest unit. A coin's decimals say how many of
those units make one coin. With 18 decimals, 1.5 coins is recorded as
1500000000000000000. To get coins, divide the raw amount by 10 to the
power of the decimals. LP Ranger's files keep raw amounts too, as
strings of digits, unless this reference says a field is already in
coins. `rebalance_log.json` gives each pool's decimals as `decimals0`
and `decimals1`, and a block explorer's page for a coin shows them too.
PLS and WPLS have 18.

**Receipts and events.** A mined transaction has a receipt. The receipt
gives the transaction's status, 1 if it succeeded and 0 if it reverted,
and its gas. It also lists the events the transaction's contracts
emitted, also called its logs. The events hold the amounts. The
position manager's events give both of a position's amounts at once,
and a coin's `Transfer` event gives one movement of that coin between
two addresses. A block explorer shows the same events on a
transaction's page (`chains.json` → `blockExplorer`).

**Gas.** The receipt gives the gas a transaction used (`gasUsed`) and
the price it paid for each unit (`effectiveGasPrice`). Their product is
the PLS it paid, as a raw amount with 18 decimals. A reverted
transaction still pays its gas, though nothing else in it happened.
LP Ranger's files name their gas fields with `Wei`, as in
`totalGasCostWei`. Those hold the same raw amount of PLS.

**Move.** A rebalance or a compound, as the wallet report groups
transactions: every transaction from its first, a drain or a collect,
to its last, a mint or a deposit. A deposit with no collect before it is
coins the owner added, and the report calls that move a deposit.

**Range of days.** The days a wallet report covers. It has nothing to do
with a position's price range. How its days are counted, and where a
range ends, are in
[Time Zones and the Last Whole Day](user-manual.md#time-zones-and-the-last-whole-day).

---

## Commands

See [`commands.md`](commands.md).

---

## Engineering Design

### System View

The two tools are entry points over LP Ranger's own libraries. They read
the app's configuration, records and prices the way the app does. They
write only under `app-data/util/bookkeeping/`, with one exception: a
Moralis key typed into the report is saved in the app's own key store.

**The modules.** Each is in `util/bookkeeping/`, and
[Modules](#modules) describes each in full.

| File | What it does | How it fits |
| --- | --- | --- |
| `coins-in-transaction.js` | Reads one transaction's receipt and returns what it moved for a wallet (`coinsInTransaction`). Run from a shell, it prints that as json. | The receipt reader. The report calls it for every transaction it lists. |
| `coins-in-transactions-on-wallet/index.js` | The report's entry point (`main`): the options, the range of days, the lock and the key, then every row (`rowsOfMove`) and the csv (`writeReport`). | The only file that runs the others, in order. |
| `coins-in-transactions-on-wallet/moves.js` | The rebalances and compounds `app-data/` records for the wallet near the range (`recordsNear`), with no chain call. | Where a report starts. |
| `coins-in-transactions-on-wallet/chain.js` | Every chain read the report makes, at LP Ranger's pace (`pacedProvider`): searching by NFT (`drainBlockBefore`, `collectBlockBefore`), searching by wallet (`walletTransactionsIn`), a coin's symbol and decimals (`coinInfo`), and an NFT's coins (`nftCoins`). | Finds what the records do not name. |
| `coins-in-transactions-on-wallet/csv.js` | A transaction's row (`rowOf`), the coins it needs priced (`coinsToPrice`), the column names (`columns`) and the csv text (`toCsv`). | Turns what was read into the file. |
| `coins-in-transactions-on-wallet/dates.js` | The time zones the report takes, its dates, the instants a range of days spans (`rangeIn`), and the last whole day (`lastWholeDay`). | The calendar. |
| `coins-in-transactions-on-wallet/help.js` | The text `--help` prints after the options. | Plain text, kept apart. |
| `blockchain.js` | Settles the chain from `--blockchain` before the configuration loads, and gives the line saying a run reads one chain (`oneChainNotice`). | Required first by every module that loads the configuration. |
| `usd-prices.js` | A coin's USD price for a transaction (`usdPriceOn`), from LP Ranger's price library, whose two caches it points at the tools' own folder (`cachePath`). | The report's only source of prices. |
| `moralis-key.js` | Puts LP Ranger's Moralis key in memory for the run, or with none saved, a key typed in and then saved (`unlockMoralisKey`). | Runs before anything is priced. |
| `price-cache-lock.js` | Takes the lock that lets one run price at a time, and releases it (`takePriceCacheLock`). | Taken before the key is asked for. |

**What they use of LP Ranger's.**

| File | What for |
| --- | --- |
| `src/config.js` | The chain, its contracts and coins, and the endpoint list |
| `src/load-merged-defaults.js` | `chains.json` with the operator's copy over it, which `--blockchain` is checked against |
| `src/bot-config-defaults.js` | The pace of requests and the span of a log search |
| `src/historical-token-price.js` | A price: Moralis's at a block, else GeckoTerminal's close for the UTC day |
| `src/price-cache.js`, `src/gecko-pool-cache.js`, `src/shared-json-file.js` | The price library's two caches, and how a cache file is written |
| `src/scan-cache-dir.js` | Where those caches go under `node --test` |
| `src/api-key-store.js`, `src/api-key-holder.js` | The saved Moralis key, and the plain key in memory |
| `src/ask-password.js` | The prompt for the key's password, which shows nothing of what is typed |
| `src/server-moralis.js` | `pingMoralis`, which asks Moralis about the key |
| `src/nft-move-rules.js` | The rules for which NFT event began a move, a rebalance's drain (`drainBefore`) and a compound's collect (`collectBeforeDeposit`), which the bot also applies for the Activity Log's figures; and `sameHex`, how two hashes or addresses are compared |
| `util/diagnostic/check-rpc-health.js` | `parseEndpoint`, which reads `--rpc-endpoint` |

**What they write.** The report writes its csv to
`app-data/util/bookkeeping/`, and keeps the prices it fetches in
`app-data/util/bookkeeping/scan-cache/`, where a run also holds its lock
while it prices. A Moralis key typed into the report is saved in the
app's key store, `app-config/user-configurable/api-keys.json`, so the
app and the report share one key. Nothing else of the app's is written.
Nothing the tools call reads the app's settings through `loadConfig`, so
a run leaves the settings' backups alone. The one-transaction tool
writes nothing at all.

### Sequence View

What each tool does, in the order it does it.

#### Reading One Transaction

1. `blockchain.js` reads `--blockchain` and settles the chain before the
   configuration loads.
2. The options are parsed. `--help` prints and exits here.
3. The tool asks one endpoint for the transaction's receipt: the one
   `--rpc-endpoint` names, else the first LP Ranger tries.
4. It reads the receipt's events into a json object: the kind, the
   position manager's liquidity events, the NFTs minted or burned, a
   drain's fees, the wallet's coin transfers and approvals, and the gas.
5. It prints the object on stdout and exits 0. Every other line goes to
   stderr, so the json can be redirected to a file whole. No receipt, or
   an endpoint that failed, exits 1 with the reason.

#### A Wallet's Report

1. The options are parsed and checked (`readOptions`).
   `--list-valid-timezones` prints the list and exits here.
2. The range of days is cut at the last whole day, or refused when it
   has none (`wholeDays`).
3. The exit status is set to 1. It stays 1 until the csv is written.
4. The lock is taken (`takePriceCacheLock`). A lock another run holds
   stops the run here.
5. The Moralis key is opened, or with none saved, asked for and saved
   (`unlockMoralisKey`). Moralis is asked about the key once.
6. `recordsNear` lists the moves `app-data/` records near the range.
7. For each move, oldest first, `rowsOfMove`:
   1. reads the receipt and block time of the move's last transaction,
      and skips the move when that falls outside the range;
   2. finds the move's first block: a rebalance's drain, or a
      compound's collect;
   3. finds the pool's two coins, and each coin's symbol and decimals;
   4. lists every transaction the wallet sent from the first block to
      the last;
   5. reads each one with `coinsInTransaction`, keeps those that belong
      to the move, prices the coins each moved and its gas, and makes
      each a row.
8. The rows are sorted by block and nonce, the csv is written whole, and
   the last line printed says where. The exit status becomes 0.
9. The lock is released, however the run ended.

---

## The Kinds of Transaction

Each kind of transaction moves coins in its own way. The table names,
for each kind, the coins that leave and enter the wallet, and the event
that holds their amounts. An event is the position manager's unless the
table says otherwise.

| Transaction | What it does                                                                     | Coins out  | Coins in                       | Where the amounts are                                  |
| ----------- | -------------------------------------------------------------------------------- | ---------- | ------------------------------ | ------------------------------------------------------ |
| Mint        | Creates an NFT and puts both coins into it                                       | Both coins | None; the wallet gets the NFT  | `IncreaseLiquidity`                                    |
| Deposit     | Adds both coins to an NFT that already exists                                    | Both coins | None                           | `IncreaseLiquidity`                                    |
| Drain       | Takes liquidity out of an NFT and collects it, in one transaction                | None       | Both coins: principal and fees | `DecreaseLiquidity` for principal, `Collect` for total |
| Collect     | Takes the fees an NFT has earned and leaves its liquidity in place               | None       | Both coins, all of them fees   | `Collect`                                              |
| Swap        | Trades some of one coin for the other                                            | One coin   | The other coin                 | The coins' `Transfer` events from and to the wallet    |
| Approval    | Lets a contract move one coin out of the wallet; sent to that coin's contract    | None       | None                           | Nothing moves                                          |
| Cancel      | Takes a stuck transaction's place, sending zero PLS from the wallet to itself    | None       | None                           | Nothing moves                                          |
| Burn        | Destroys an emptied NFT; only the owner sends this, never LP Ranger              | None       | None                           | Nothing moves                                          |

Every one of them also pays gas. A mint's receipt also holds the new
NFT's `Transfer` from the zero address, and a burn's holds the NFT's
`Transfer` to it. LP Ranger always drains all of an NFT's liquidity; an
owner can take out part of it.

### Principal and Fees in a Drain

A drain's `DecreaseLiquidity` event gives the principal: what the
liquidity taken out was worth, in each coin. Its `Collect` event gives
everything the drain sent to the wallet. That is the principal, plus
every fee the NFT had earned and not yet collected. So, for each coin:

```text
fees = the Collect amount − the DecreaseLiquidity amount
```

These are the fees the NFT earned since it last collected. A compound
collects in a transaction of its own. So the fees an NFT earned before
its last compound are in that compound's `Collect`, not in the drain's.

A position that is out of range holds only one of its two coins. Its
principal is then all in that coin, and the drain's whole amount of the
other coin is fees.

A block explorer's list of a transaction's token transfers shows only
what reached the wallet. It cannot tell principal from fees; only the
events can.

### The Coins in a Swap

A swap's receipt holds many `Transfer` events, most of them between the
pools along its route. Only those that name the wallet count. The coin
sent is in the `Transfer` events from the wallet, and the coin received
is in those to the wallet. Add up each coin's.

A swap through the aggregator is sent to the aggregator's contract. A
swap through the swap router is sent to the router (`chains.json` →
`contracts.swapRouter`). The wallet's coins show the same way in both.

Some coins, PLSX among them, also emit an `Approval` event whenever a
contract spends the wallet's allowance. An `Approval` inside a swap, a
mint or a deposit is one of these. It is not an approval transaction,
which is one sent to the coin's own contract.

### Paying or Receiving PLS

PLS has no contract, so no event records it moving. WPLS stands for PLS
one for one, and it is a coin with a contract (`chains.json` →
`nativeWrappedToken`), so its moves show as `Transfer` events like any
other coin's. LP Ranger's own transactions trade WPLS and spend PLS only
on gas. A transaction the owner sends from the 9mm website can use PLS
instead, and then the wallet's PLS shows only indirectly:

- **Paying PLS**, in a mint or deposit. The transaction carries PLS as
  its value. The position manager wraps as much as the position takes,
  which the WPLS contract records as a `Deposit` event. It returns the
  rest to the wallet in the same transaction, which no event records.
  The PLS that left the wallet, apart from gas, is the WPLS amount in
  the `IncreaseLiquidity` event.
- **Receiving PLS**, in a drain or collect. The position manager unwraps
  the WPLS, which the WPLS contract records as a `Withdrawal` event, and
  sends the PLS to the wallet, which no event records. The PLS that came
  in is the `Withdrawal` amount.

A transaction's value is on its page in a block explorer, or in the
answer to `eth_getTransactionByHash`.

---

## How LP Ranger Sends Them

LP Ranger sends these transactions in set orders, from the one wallet
that holds every position it manages. The order tells which
transactions belong together.

### A Rebalance

A rebalance moves a position to a new price range. In order, it sends:

1. **A drain** of the old NFT. There is none when the NFT is already
   empty; see [Recording a Failed Attempt](#recording-a-failed-attempt).
2. **A swap** of part of one coin into the other, so that the wallet
   holds the two in the ratio the new price range needs. The aggregator
   is tried first and the swap router after it. A swap the aggregator
   refuses for its price impact is tried again in three equal parts
   (`swapChunkCount` in `bot-config-defaults.json`), each its own
   transaction.
3. **Corrective swaps**, up to three (`correctiveSwapMaxRounds`), when
   the first swap moved the price enough to leave the ratio off.
4. **A mint** of the new NFT, with all of both coins in the wallet.

An approval comes before a swap or the mint whenever the contract's
allowance is too small. Coins the mint cannot use stay in the wallet.

### A Compound

A compound puts an NFT's fees back into it. In order, it sends:

1. **A collect** of the NFT's fees. If it finds none, the compound ends
   here.
2. **A swap**, when one coin must be traded to match the price range's
   ratio and the swap is worth its gas.
3. **A deposit** into the same NFT.

Approvals come first where needed, as in a rebalance. Coins the deposit
cannot use stay in the wallet.

### Retries, Speed-Ups and Cancels

These add transactions to a rebalance or compound without changing what
it does. Each transaction the wallet sends carries its nonce: the next
number in the wallet's count of transactions.

- **Speed-up.** A transaction still pending after 120 seconds
  (`TX_SPEEDUP_SEC`) is sent again at a higher gas price, with the same
  nonce. Only one of the two can be mined. The other never happens and
  costs nothing.
- **Cancel.** A transaction still pending after an hour
  (`TX_CANCEL_SEC`) is cancelled: LP Ranger sends zero PLS from the
  wallet to itself, with the same nonce. If the cancel is mined, the
  stuck transaction never happens.
- **Aggregator retries.** A swap through the aggregator that reverts,
  or is cancelled for taking too long, is quoted and sent again, up to
  four tries in all (`aggregator.maxAttempts` in `chains.json`). Each
  try is its own transaction.
- **Failure part way.** A rebalance or compound can fail after some of
  its transactions were mined. Those transactions happened: a drain
  that was mined left the coins in the wallet, and a swap that was mined
  traded them. LP Ranger tries an unfinished rebalance again later,
  starting from what the wallet then holds.

Transactions of different positions can sit in the same blocks. Match
each transaction to its position by the NFT id in its events, or by the
coins it moved.

---

## What `app-data/` Records

`app-data/` holds what LP Ranger records as it works. Three parts of it
matter here: the rebalance log, the position records and the scan
caches. All are json files. Read them freely, but do not edit them
while LP Ranger runs.

### The Rebalance Log

`app-data/rebalance_log.json` is a list with one entry per successful
rebalance, in the order they happened. LP Ranger writes an entry once
the new NFT's mint has been mined. A failed attempt gets no entry.

| Field                                  | What it holds                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `loggedAt`                             | When the entry was written, just after the mint                                                                                      |
| `wallet`, `contract`, `chain`          | The wallet, the position manager and the blockchain                                                                                  |
| `token0`, `token1`                     | The pool's two coins                                                                                                                 |
| `decimals0`, `decimals1`               | The two coins' decimals                                                                                                              |
| `oldTokenId`, `newTokenId`             | The NFT drained and the NFT minted                                                                                                   |
| `txHashes`                             | Some of the rebalance's transactions, in the order they were sent; the last is always the mint                                       |
| `amount0Collected`, `amount1Collected` | What the drain brought in, principal and fees together: the wallet's balance change across the drain, equal to its `Collect` amounts |
| `amount0Minted`, `amount1Minted`       | The mint's `IncreaseLiquidity` amounts: the coins that went into the new NFT                                                         |
| `totalGasCostWei`                      | The gas of every transaction the rebalance sent, whether `txHashes` lists it or not                                                  |
| `mintGasCostWei`                       | The gas of the mint and of any approvals sent just before it                                                                         |
| `blockNumber`                          | The mint's block, in entries written by newer versions of LP Ranger                                                                  |

The entry's other fields hold dollar figures and price-range details,
which this reference leaves aside.

**What `txHashes` leaves out.** It lists the drain, the main swap's last
transaction, the last corrective swap and the mint, each only if it
happened. It leaves out approvals, all but the last part of a swap sent
in parts, all but the last corrective swap, aggregator tries that
reverted, and cancels. Their gas is still in `totalGasCostWei`. So when
the gas of the listed transactions adds up to less than
`totalGasCostWei`, the difference is the gas of transactions the entry
does not name. [Searching by Wallet](#searching-by-wallet) lists them.

**An entry with no drain.** An earlier attempt may have drained the old
NFT and then failed. The rebalance that later succeeded then sent no
drain. Its `txHashes` starts with a swap or the mint, and
`amount0Collected` and `amount1Collected` hold the wallet's whole
balance of each coin when it began, which is not a withdrawal. The drain
belongs to the failed attempt.

**Entries from the test suite.** An entry whose `wallet` is
`0xSIGNER0000000000000000000000000000000001` was written by LP Ranger's
test suite, not by a rebalance. Its `txHashes` hold words such as
`0xmint` in place of hashes. Skip it.

### The Position Records

`app-data/position-records.json` holds what LP Ranger has worked out
about each position. Each position's records are under `positions`, at
the position's key: the chain, the wallet, the position manager and the
current NFT's id, joined by dashes. A rebalance moves the records to the
new NFT's key, so one key holds a position's records across all of its
NFTs.

| Field             | What it holds                                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compoundHistory` | One entry per deposit into one of the position's NFTs after its mint: each compound, and coins the owner added. Each entry gives the deposit's `txHash`, the NFT it went into (`tokenId`), its `timestamp`, and `amount0Deposited` and `amount1Deposited`, the deposit's `IncreaseLiquidity` amounts. |
| `failedMoveGas`   | One entry per failed rebalance or compound that paid gas, and per compound whose collect found no fees: when (`at`) and the gas, in raw PLS (`wei`). It names no transactions.                                                                                                                        |

The other fields hold figures for the dashboard, such as running totals,
which bookkeeping does not need.

`compoundHistory` names a compound's deposit, but neither its collect
nor its swap. LP Ranger rebuilds it from the chain each time it rescans
a position's history, so it also lists deposits made before LP Ranger
managed the position. It leaves out a deposit made within about 5.8
days after liquidity was taken out of the same NFT
(`compound.repositionWindowSec` in `app-runtime.json`). It counts such a
deposit as part of a rebalance, not as a compound.

### The Scan Caches

`app-data/scan-cache/` holds what LP Ranger has read from the chain, so
that it need not read it again. LP Ranger can rebuild any of these
files, so treat them as copies of chain data. Three of them help here:

| File | What it holds |
| --- | --- |
| `event-cache-*.json` | One file per pool and wallet, named for the chain, position manager, wallet, coins and fee tier. Under its one entry's `value`, `events` lists the pool's rebalances, each new NFT paired with the one it replaced (`oldTokenId`, `newTokenId`), with the new NFT's mint as `txHash`, `blockNumber` and `timestamp`. Beside `events`, `chainFirstTokenId` and `chainFirstMintBlock` give the chain's first NFT and the block it was minted in. [Rebalance Event Caches](../../engineering.md#rebalance-event-caches) describes the file in full. |
| `pnl-epochs-cache.json` | One entry per pool, keyed by the chain, position manager, wallet, coins and fee tier, joined by dots. Under `lifetimeHodlAmounts`, `deposits` lists the coins that came into the pool's chain of NFTs from outside it, as raw amounts (`raw0`, `raw1`), with the block of the mint or deposit that took them in. The first entry is the first NFT's mint. |
| `lp-position-cache-*.json` | One file per position manager and wallet. Under `positions`, every NFT the wallet holds at that position manager, drained ones included, with its two coins, their symbols and its fee tier. A `liquidity` of `"0"` means drained. |

The event cache can name a rebalance's mint when the rebalance log
cannot: one from before the log began, or one whose log entry is
missing. It can miss a rebalance made by another install or by hand
([How a Scan Fills a File](../../engineering.md#how-a-scan-fills-a-file));
each rebalance this install makes adds its own record. It does not name
drains. The other files in the folder hold prices, block times and
similar, but no transaction amounts.

---

## Reading the Chain

A receipt answers everything about a transaction whose hash you have. A
search of the chain's events finds the transactions whose hash you
lack. Both are rpc calls to an endpoint such as those LP Ranger uses
(`chains.json` → `rpc.urls`).

### One Receipt per Known Transaction

`eth_getTransactionReceipt` takes a transaction's hash and answers with
its receipt. One call per transaction gives all three parts of its
record. In the receipt, keep:

- the position manager's `IncreaseLiquidity`, `DecreaseLiquidity` and
  `Collect` events for the NFT you are recording;
- the coins' `Transfer` events from or to the wallet.

`util/bookkeeping/coins-in-transaction.js` makes that call and prints
the record as a json object, which [Modules](#modules) describes.
Running it is in
[Looking Up One Transaction](user-manual.md#looking-up-one-transaction).

### Finding the Transactions the Files Do Not Name

Two searches find them. One looks for an NFT's events. The other lists
everything the wallet sent between two blocks.

#### Searching by NFT

To find an NFT's drain, collect or deposit, ask `eth_getLogs` for the
logs of the position manager's address that match two topics. The first
topic is the event's signature hash
([Event Signatures](#event-signatures)). The second is the NFT id,
written as a 32-byte number: in ethers,
`ethers.zeroPadValue(ethers.toBeHex(nftId), 32)`.

An endpoint answers one search over a limited span of blocks. LP Ranger
asks for at most 9,000 blocks at a time (`getLogsChunkSize` in
`bot-config-defaults.json`), and so should you. Search backward from a
block you know, one span at a time, and stop at the first match:

- **A compound's collect** is the latest `Collect` for the NFT at or
  before its deposit's block.
- **A failed attempt's drain** is the latest `DecreaseLiquidity` for the
  old NFT before the block of the rebalance's first listed transaction.
- **The first NFT's mint** is the `IncreaseLiquidity` for
  `chainFirstTokenId`, searched in `chainFirstMintBlock` alone.

#### Searching by Wallet

Approvals, cancels and reverted transactions move no coins. Cancels and
reverted transactions leave no events at all, so no search of events
can find them. Each of them still used one of the wallet's nonces.

`eth_getTransactionCount` gives the number of transactions the wallet
had sent by the end of a given block. Take that number for the span's
last block, less the number for the block just before the span: the
result is how many transactions the wallet sent in the span. This needs
an endpoint that keeps the state of past blocks.

To list them, read each block in the span with `eth_getBlockByNumber`,
asking for full transactions, and keep those sent from the wallet. The
list is complete when its length matches that count. The wallet report
reads far fewer blocks: it halves any span whose two ends show different
counts, until it reaches single blocks, and reads only those
(`walletTransactionsIn`, `chain.js`). Each transaction then shows what
it was:

- sent to the position manager: a drain, collect, deposit or mint, which
  its events tell apart;
- sent to one of the pool's coins, with an `Approval` in its receipt: an
  approval;
- sent from the wallet to itself, with a value of zero: a cancel;
- a receipt status of 0: a reverted try, which paid gas only;
- sent to the aggregator or the swap router, with `Transfer` events
  from and to the wallet: a swap, or one part of one.

A block explorer's list of the wallet's transactions gives the same
list without any rpc calls.

### Event Signatures

A log's first topic says which event it is: the hash of the event's
signature. In the position manager's three events, the second topic is
the NFT id. In a coin's `Transfer`, the second topic is the sender and
the third the receiver.

| Event                                                | Emitted by                                     | First topic                                                          |
| ---------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `IncreaseLiquidity(uint256,uint128,uint256,uint256)` | The position manager                           | `0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f` |
| `DecreaseLiquidity(uint256,uint128,uint256,uint256)` | The position manager                           | `0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4` |
| `Collect(uint256,address,uint256,uint256)`           | The position manager                           | `0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01` |
| `Transfer(address,address,uint256)`                  | Each coin, and the position manager for NFTs   | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |
| `Approval(address,address,uint256)`                  | Each coin                                      | `0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925` |
| `Deposit(address,uint256)`                           | WPLS, when it wraps PLS                        | `0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c` |
| `Withdrawal(address,uint256)`                        | WPLS, when it unwraps to PLS                   | `0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65` |

---

## Step by Step

These are the procedures for recording each kind of move by hand.
Wherever a step reads a receipt, `util/bookkeeping/coins-in-transaction.js`
prints what the step needs from it
([One Receipt per Known Transaction](#one-receipt-per-known-transaction)).
The wallet report runs them for every rebalance and compound in a range
of days at once ([The Wallet Report](#the-wallet-report)).

### Recording a Rebalance

1. Find the rebalance's entry in `rebalance_log.json` by its
   `oldTokenId` and `newTokenId`.
2. **The mint.** Record `amount0Minted` and `amount1Minted` as coins
   out. The mint's hash is the last in `txHashes`. This step needs no
   rpc call.
3. **The drain.** Read the receipt of the first transaction in
   `txHashes`. If it holds a `DecreaseLiquidity` for `oldTokenId`, it is
   the drain. Record its `Collect` amounts as coins in. They equal
   `amount0Collected` and `amount1Collected`. Of them, the
   `DecreaseLiquidity` amounts are principal and the rest are fees. If
   the receipt holds no `DecreaseLiquidity`, the drain belongs to a
   failed attempt: see
   [Recording a Failed Attempt](#recording-a-failed-attempt).
4. **The swaps.** Every transaction in `txHashes` other than the drain
   and the mint is a swap. Read each one's receipt and record the
   wallet's `Transfer` events: the coin out and the coin in.
5. **The gas.** Read the mint's receipt too, then add up the gas of all
   the receipts read. If the sum equals `totalGasCostWei`, every
   transaction is recorded. If it is less, list the wallet's
   transactions from the drain's block to the mint's block
   ([Searching by Wallet](#searching-by-wallet)); the mint's receipt
   gives its block. Read each one not yet recorded. An approval, a
   cancel or a reverted try pays gas only, and a swap part moves coins
   like any swap. Their gas makes up the difference.

### Recording a Compound

1. Find the compound's deposit in `compoundHistory`, in
   `position-records.json`, by its `tokenId` and `txHash`.
2. **The deposit.** Record `amount0Deposited` and `amount1Deposited` as
   coins out. This step needs no rpc call.
3. **The collect.** Read the deposit's receipt, for its gas and its
   block. Then find the latest `Collect` for the same NFT at or before
   that block ([Searching by NFT](#searching-by-nft)). That is the
   compound's collect. Read its receipt. It holds no
   `DecreaseLiquidity`, so its whole `Collect` amounts are fees: record
   them as coins in.
4. **The swap and approvals.** List the wallet's transactions from the
   collect's block to the deposit's block
   ([Searching by Wallet](#searching-by-wallet)). Record any swap among
   them, and every one's gas. A transaction belongs to this compound
   only if it moved or approved this pool's coins.

The coins the deposit did not use stay in the wallet. They need no
record of their own: they are the coins collected, after any swap, less
the coins deposited.

### Recording a Failed Attempt

A failed rebalance leaves no entry in the rebalance log, but its mined
transactions moved coins. The rebalance that later succeeded shows it:
its entry has no drain, as step 3 of
[Recording a Rebalance](#recording-a-rebalance) finds.

1. Find the latest `DecreaseLiquidity` for the entry's `oldTokenId`
   before the block of its first transaction
   ([Searching by NFT](#searching-by-nft)). That is the failed attempt's
   drain. Read its receipt and record it as in a rebalance.
2. List the wallet's transactions from that drain's block to the entry's
   mint ([Searching by Wallet](#searching-by-wallet)). Those that moved
   or approved this pool's coins belong to the failed attempt or to the
   rebalance that finished its work. Record the coins each swap moved
   and every one's gas. The span can run to thousands of blocks; then a
   block explorer's list of the wallet's transactions is quicker.

A failed compound shows in a similar way. A collect that was mined
brought its fees into the wallet. It is a `Collect` for the NFT with no
deposit after it in `compoundHistory`; record it as in step 3 of
[Recording a Compound](#recording-a-compound). The gas of everything a
failed rebalance or compound sent is also in `failedMoveGas`, under the
time it failed.

### Recording the Owner's Own Transactions

Transactions the owner sends without LP Ranger, from the 9mm website
for example, appear in `app-data/` only as LP Ranger's later scans see
them:

- **The first NFT's mint.** The event cache names the NFT and its block
  (`chainFirstTokenId`, `chainFirstMintBlock`). The first entry of
  `deposits` in `pnl-epochs-cache.json` gives its amounts. Its hash
  comes from a search for its `IncreaseLiquidity` in that one block.
- **A deposit into an existing NFT.** It has an entry in
  `compoundHistory`, like a compound.
- **Anything else**, such as taking liquidity out by hand or burning an
  NFT. Nothing records it; find it with
  [Searching by NFT](#searching-by-nft).

If such a transaction paid or received PLS, see
[Paying or Receiving PLS](#paying-or-receiving-pls).

---

## The Wallet Report

`util/bookkeeping/coins-in-transactions-on-wallet` runs the procedures
of [Step by Step](#step-by-step) for every rebalance and compound of a
wallet in a range of days, and writes the result as a csv file, one row
per transaction. Running it and reading its csv are in
[`user-manual.md`](user-manual.md). This section is how it works.

### Which Transactions It Lists

The report starts from what `app-data/` records (`recordsNear`,
`moves.js`): the rebalances in the event caches and the rebalance log,
and the compounds in the position records. It takes those whose
recorded end lies within an hour of the range of days, and those with no
recorded time. A record is written seconds after its last transaction is
mined, so an hour leaves room for a slow write, and the block time then
decides. A rebalance the event caches missed
([The Scan Caches](#the-scan-caches)) is in neither file, so the report
cannot list it.

For each move, the report reads its last transaction's receipt and
block, and keeps the move only when that block's time falls in the
range of days. It then finds the move's first transaction by
[Searching by NFT](#searching-by-nft):

- **A rebalance's drain.** The first transaction the rebalance log lists,
  when that is a drain of the old NFT. Otherwise the latest
  `DecreaseLiquidity` of the old NFT at or before the mint, searched
  back to the block that NFT was minted in when the event cache knows
  it, or else across a month of blocks (`blockTimeSec` in
  `chains.json`).
- **A compound's collect.** The latest `Collect` of the NFT within one
  span of blocks before the deposit, provided no other deposit into the
  NFT came after it. With none, the deposit is coins the owner added,
  and the report names the move a deposit.

It lists everything the wallet sent from that block to the last
([Searching by Wallet](#searching-by-wallet)). A transaction belongs to
the move when it names one of the move's NFTs. One that names no NFT
belongs when every coin it moves or approves is the pool's. One that
moves none, a cancel or a reverted try, belongs to the move whose blocks
it sits in. Each transaction is claimed by one move only. What this
means for a report, back-to-back ranges included, is in
[Which Transactions a Report Lists](user-manual.md#which-transactions-a-report-lists).

### Prices

`usd-prices.js` prices each coin through LP Ranger's own library,
`fetchHistoricalTokenPriceUsd` (`src/historical-token-price.js`), the
lookup the app uses to price gas on a past day. It passes the
transaction's block, so the library asks Moralis first, for the price at
that block, and GeckoTerminal for the UTC day's close where Moralis has
none. The chain's own coin is priced through its wrapped form
(`nativeWrappedToken` in `chains.json`). A lookup that finds no price
throws, with `priceUnavailable` set: a price of zero would value the
coins at nothing. Which price a row gets, and each source's limits, are
in [Prices](user-manual.md#prices).

The library keeps what it fetches in two cache files, whose paths it
reads as it loads: `PRICE_CACHE_PATH` and `GECKO_POOL_CACHE_PATH`.
`usd-prices.js` sets both to `app-data/util/bookkeeping/scan-cache/`
first (`cachePath`), so the tools never write LP Ranger's own caches in
`app-data/scan-cache/`. Under `node --test` both go to the test
process's own folder (`src/scan-cache-dir.js`). A price is written as it
arrives. Each write reads the file as it is at that moment, lays the
run's own prices over it and replaces it whole
(`src/shared-json-file.js`).

### One Run at a Time

`price-cache-lock.js` lets one run of the report price at a time, since
two runs writing the caches together could drop each other's newest
prices. Before it asks for the key, a run creates `price-caches.lock`
beside the caches, which only one process can create (`fs.openSync` with
the `wx` flag). The file holds the id of the process that took it, and
when. The run removes the file in `main`'s `finally`, on `exit`, and on
SIGINT, SIGTERM or SIGHUP, ending with the status a shell gives a
process the signal stopped: 128 and the signal's number. A run that
finds the file stops, with `lockHeld` set and a message naming the run
that holds it. A run killed outright cannot remove the file. What a
user sees, and how to release a lock left behind, are in
[One Run at a Time](user-manual.md#one-run-at-a-time).

### The Moralis Key

`moralis-key.js` uses LP Ranger's own Moralis key, through the app's key
store (`src/api-key-store.js`): one key, in
`app-config/user-configurable/api-keys.json`, encrypted with the
wallet's password by AES-256-GCM, with the encryption key made from the
password by PBKDF2-SHA512 at 600,000 rounds. Git ignores the file. The
report never opens the wallet file; it asks for the wallet's password
only because the store encrypts every api key with it. The prompt is
LP Ranger's own (`src/ask-password.js`), which shows nothing of what is
typed. The password is never an argument, which shell history and `ps`
would keep, and it is kept nowhere. The plain key is only in memory, in
`src/api-key-holder.js`, where the price library reads it.

Every run asks Moralis about the key once, before it prices anything
(`pingMoralis`, `src/server-moralis.js`). The library answers a refused
key as it answers a coin with no price, by asking CoinGecko. Without
the check, a key Moralis stopped taking would leave CoinGecko to answer
alone, and the run would stop only at the first day older than 180
days.

A new key is saved only once Moralis takes it. The store reads its
file, adds the key and writes the file back, so a key the dashboard
saved in between could be lost; that is why the run first warns not to
save one there. The password typed for a new key is not checked against
the wallet's: LP Ranger's wallet module (`src/wallet-manager.js`) reads
the wallet file as it loads, which would have the report, and each of
its tests, read that file. Each prompt and answer, and what to do once
the wallet is imported again under a new password, are in
[The Moralis Key](user-manual.md#the-moralis-key).

### The Last Whole Day

A report ends at the last whole day:
[Time Zones and the Last Whole Day](user-manual.md#time-zones-and-the-last-whole-day)
gives the rule and its examples. `lastWholeDay` (`dates.js`) works it
out for the run's time zone and moment, and `wholeDays` (`index.js`)
cuts the range there, or refuses a range with no whole day, before the
lock is taken.

### When a Run Stops

The report asks one endpoint, and moves to no other. For prices it asks
Moralis, then CoinGecko, and no third. A failure stops the run and
writes no csv: the csv is written only once every row is in. Each
failure is marked on the error, so `failureText` can say what to try:

| Marked | What happened | What the run suggests |
| --- | --- | --- |
| `rpcFailure` | The endpoint failed a request (`markRpcFailure`, `chain.js`) | Another rpc node, with `--rpc-endpoint` |
| `priceUnavailable` | Neither oracle had a price for a coin | Another price oracle, or the same later |
| `keyRefused` | The key could not be opened or entered, or Moralis refused it or did not answer | Its message says which, and what to do |
| `lockHeld` | Another run holds the lock | Its message names that run, and how to release a lock left behind |

An endpoint that has no receipt for a transaction it must hold has
failed too: one LP Ranger recorded as mined, or one the endpoint itself
lists in a block (`missingReceipt`). A csv without that transaction
would look complete, so the run stops instead, marked `rpcFailure`.

A call the chain refuses, such as a coin with no `symbol()`, is an
answer, not a failure, and is not marked. An error that is none of these
is reported as it is, and the exit status is 1. Each message, and what
to do about it, is in [Troubleshooting](user-manual.md#troubleshooting).

### The Rows

`csv.js` makes each transaction a row (`rowOf`). Amounts are divided by
each coin's decimals exactly, as strings, so no amount is rounded. A USD
value is written with two to six decimals, and a price to twelve
significant digits, never with an exponent. `coinsToPrice` names only
the coins a row needs priced, so a swap of one coin asks no price of the
other. The gas and value columns are named for the chain's own coin
(`nativeCurrencySymbol` in `chains.json`), and coins outside the pool go
into one cell, `other_coins`. The rows are sorted by block, and within a
block by nonce. What each column holds is in
[Reading the CSV](user-manual.md#reading-the-csv).

---

## Configuration

Every setting is LP Ranger's own, read through its resolver
(`src/config.js`), so `.env` and the operator's settings files apply to
the tools as to the app. The tools read only what reaching the chain and
the price services needs, never the app's preferences: the report
ignores the dashboard's Moralis on/off switch, for one.

| Setting | Where it is set | What the tools do with it |
| --- | --- | --- |
| The blockchain | `CHAIN_NAME` in `.env`, else `defaults.chain` in `app-runtime.json`; `--blockchain` | Read one chain: its id, contracts and coins |
| The endpoint | The endpoint list: those added in the dashboard (Bot Settings → Network → Add RPC), then `chains.json` → `rpc.urls`, whose first three `RPC_URL`, `RPC_URL_FALLBACK` and `RPC_URL_FALLBACK_2` in `.env` replace; `--rpc-endpoint` | Ask the first, and no other |
| The position manager | `chains.json` → `contracts.positionManager`; `--position-manager` | Count its events and its NFTs |
| The chain's wrapped coin | `chains.json` → `nativeWrappedToken` | Price the chain's own coin, for gas and value sent |
| The chain's coin symbol | `chains.json` → `nativeCurrencySymbol` | Name the gas and value columns |
| Block time | `chains.json` → `blockTimeSec` | Turn a month into blocks, the farthest a drain search reaches back when nothing bounds it |
| Cache tag | `chains.json` → `cacheTag` | Find the event cache files |
| Request pace | `globalRPCRequestRateIntervalMS` in `bot-config-defaults.json` | Space every request, as LP Ranger spaces its own |
| Log span | `getLogsChunkSize` in `bot-config-defaults.json` | Bound each log search |

The endpoint list is a core setting even though it puts the endpoints
saved in the dashboard first. Each setting's rules and range are in
[`docs/configuration.md`](../../configuration.md).

---

## Modules

Each module in `util/bookkeeping/`, in full.

- **`blockchain.js`** — Chooses the blockchain before the configuration
  loads. `src/config.js` serves one chain, which it reads from
  `CHAIN_NAME` as it loads, so every tool module that loads it requires
  this one first. It reads `--blockchain <name>` from the command line
  with a parser of its own that passes over every other argument,
  refuses a name `chains.json` does not have, and sets `CHAIN_NAME`.
  Without the option, the app's own chain stands. When `chains.json`
  names more than one chain, each run says on stderr that it reads only
  one, and which (`oneChainNotice`). Its tests are in
  `util/test/bookkeeping-blockchain.test.js`.
- **`coins-in-transaction.js`** — Reads what one transaction moved for a
  wallet and returns it as a json object (`coinsInTransaction`), which
  it prints when run from a shell. It asks one rpc endpoint for the
  transaction's receipt, and nothing else. The object names the
  transaction's kind (drain, swap, approval, mint, collect, deposit,
  cancel, reverted and others), and holds the position manager's
  `IncreaseLiquidity`, `DecreaseLiquidity` and `Collect` events, its NFT
  mints and burns, the wallet's coin `Transfer` and `Approval` events,
  and the gas paid; for a drain, also the fees, the `Collect` amounts
  less the `DecreaseLiquidity` ones. Every amount is a string of raw
  digits. The endpoint and the position manager are the app's
  (`config.RPC_URLS[0]`, `config.POSITION_MANAGER`) unless an option
  names others ([`commands.md`](commands.md)). A `--blockchain` passed
  to `main` in arguments other than the process's own command line
  comes too late to choose the chain, so it is refused unless it names
  the chain already loaded. It writes nothing. Its tests are in
  `util/test/coins-in-transaction.test.js`.
- **`usd-prices.js`** — A coin's USD price for a transaction
  (`usdPriceOn`), as [Prices](#prices) describes. Its tests are in
  `util/test/bookkeeping-usd-prices.test.js`.
- **`price-cache-lock.js`** — The lock of
  [One Run at a Time](#one-run-at-a-time). Dependency-free, so a test
  can take the lock in a process of its own and stop that process each
  way a run can be stopped. Its tests are in
  `util/test/bookkeeping-price-cache-lock.test.js`.
- **`moralis-key.js`** — The key of [The Moralis Key](#the-moralis-key).
  The key goes into the in-memory `src/api-key-holder.js`, where the
  price library reads it. A wrong password, or a key Moralis refuses or
  cannot check, stops the run with `keyRefused` set and a message saying
  what to do. Its tests are in
  `util/test/bookkeeping-moralis-key.test.js`, against a store file of
  the test process's own (`API_KEYS_FILE_PATH`).
- **`coins-in-transactions-on-wallet/`** — The wallet report, a folder of
  its own:
  - `index.js` — The entry point (`main`), and the report's run, as
    [Sequence View](#sequence-view) lists it: the options
    (`readOptions`, as [`commands.md`](commands.md) lists them), the
    range of days (`wholeDays`), each move's rows (`rowsOfMove`), what a
    failure prints (`failureText`), and the csv (`writeReport`,
    `reportPath`). Until the csv is written the exit status is 1, so a
    run whose prompt is left unanswered when stdin closes exits 1 too.
  - `moves.js` — The moves `app-data/` records, with no chain call:
    every rebalance from the event caches, joined with the rebalance
    log's entry where there is one; every compound from
    `compoundHistory`; and each NFT's two coins and their symbols from
    the LP position cache.
  - `chain.js` — Every chain read the report makes. Each request waits
    its turn, one every `globalRPCRequestRateIntervalMS`, so a report
    run while LP Ranger runs does not crowd the endpoints they share. A
    receipt or a block is read once, however often it is asked for. A
    request the endpoint fails is marked `rpcFailure`.
  - `csv.js` — The rows and the csv, as [The Rows](#the-rows)
    describes.
  - `dates.js` — The calendar. Its list of time zones is the names
    Node's `Intl.supportedValuesOf("timeZone")` gives, and UTC; Node's
    own `Intl` holds the time zone database and its daylight-saving
    rules, so the report needs nothing installed for them. Which names a
    run takes, and the last whole day (`lastWholeDay`), are in
    [Time Zones and the Last Whole Day](user-manual.md#time-zones-and-the-last-whole-day).
  - `help.js` — The text `--help` prints after the options: the time
    zones, the configuration, the csv and each column, the prices and
    the key, the last whole day, which transactions it lists, what stops
    a run, an example and the exit status.

---

## Tests

Every module has its tests in `util/test/`. They run with the rest of
the suite in `npm run check`, and alone with `npm run test:util`. Read
[Before Running Any Lint or Test Command](../../npm-project-commands.md#before-running-any-lint-or-test-command)
first. No test reaches the network or reads the install's `app-data/`:
a stand-in answers for the chain (`util/test/_bookkeeping-chain.js`), a
report is run with its own `app-data/`, its own prices and its own
moment (`util/test/_wallet-report-run.js`), and the price caches, the
key store and the lock are in the test process's own folders.

| Test file | What it covers |
| --- | --- |
| `coins-in-transaction.test.js` | Reading one transaction: the options, each event, each kind, a drain's fees, the wallet's transfers and approvals, and what a run prints and exits with |
| `bookkeeping-blockchain.test.js` | `--blockchain`, read before the configuration loads, and the one-chain notice |
| `bookkeeping-usd-prices.test.js` | Where the price caches go, a price asked by coin, block and day, and an answer that is not a price |
| `bookkeeping-moralis-key.test.js` | Opening the app's key, saving a new one where the app reads it, and every refusal |
| `bookkeeping-price-cache-lock.test.js` | The lock, taken and released, in a process of its own that ends, gets each kill signal, or is killed outright |
| `coins-in-transactions-on-wallet-options.test.js` | The report's options and their refusals, `--list-valid-timezones`, `--help`, and the csv's name |
| `coins-in-transactions-on-wallet-dates.test.js` | Dates, time zones and daylight saving, the range of days, and when a day becomes whole |
| `coins-in-transactions-on-wallet-key-and-days.test.js` | The lock, the key and the last whole day, as a run settles them |
| `coins-in-transactions-on-wallet-moves.test.js` | The moves read from `app-data/`, and those near the range |
| `coins-in-transactions-on-wallet-chain.test.js` | The request pace, the searches by NFT and by wallet, a coin's symbol and decimals, and which failures are the endpoint's |
| `coins-in-transactions-on-wallet-rows.test.js` | The columns, the amounts and their USD values, the coins a row needs priced, and what a failure prints |
| `coins-in-transactions-on-wallet.test.js` | Whole runs: the rows written, their dates and prices, and the failures that stop a run |
