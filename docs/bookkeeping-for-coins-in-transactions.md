# Bookkeeping for Coins in Transactions

## Overview

Every transaction behind an LP position moves coins, pays gas, or both.
This guide shows how to find, for each one, how many of each coin left
the wallet, how many came in, and how much PLS it paid in gas. It deals
in coin amounts only, never in dollars.

It covers every kind of transaction a position involves: minting an NFT,
depositing into one, draining it, collecting its fees, swapping one coin
for the other, approving a coin, cancelling a stuck transaction, and
burning an emptied NFT. For each, it names the event in the
transaction's receipt that holds the amounts.

LP Ranger records many of these amounts, and many transactions' hashes,
in its `app-data/` folder. The guide explains what each file there
holds, so that many figures need no rpc call. It then shows how to read
the rest from the chain with few calls, and ends with step-by-step
procedures for a rebalance, a compound, a failed attempt and the owner's
own transactions.

## Table of Contents

- [Overview](#overview)
- [Positions, Coins and Gas](#positions-coins-and-gas)
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

## Positions, Coins and Gas

**What a record holds.** A transaction can send coins out of the wallet
and bring coins in, and every transaction the wallet sends pays gas. A
record of one transaction therefore has three parts: the coins out, the
coins in, and the gas. Its date is the time of the block it was mined
in.

**Positions and NFTs.** A position is liquidity in one pool, held by the
wallet as an NFT. The position manager is the contract that holds these
NFTs and moves their coins. On PulseChain it is 9mm Pro's, at
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

**Raw amounts.** The chain records each amount as a whole number of the
coin's smallest unit. A coin's decimals say how many of those units make
one coin. With 18 decimals, 1.5 coins is recorded as
1500000000000000000. To get coins, divide the raw amount by 10 to the
power of the decimals. LP Ranger's files keep raw amounts too, as
strings of digits, unless this guide says a field is already in coins.
`rebalance_log.json` gives each pool's decimals as `decimals0` and
`decimals1`, and a block explorer's page for a coin shows them too. PLS
and WPLS have 18.

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
transaction still pays its gas, though nothing else in it happened. LP
Ranger's files name their gas fields with `Wei`, as in
`totalGasCostWei`. Those hold the same raw amount of PLS.

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

## How LP Ranger Sends Them

LP Ranger sends these transactions in set orders, from the one wallet
that holds every position it manages. The order tells which
transactions belong together.

### A Rebalance

A rebalance moves a position to a new range. In order, it sends:

1. **A drain** of the old NFT. There is none when the NFT is already
   empty; see [Recording a Failed Attempt](#recording-a-failed-attempt).
2. **A swap** of part of one coin into the other, so that the wallet
   holds the two in the ratio the new range needs. The aggregator is
   tried first and the swap router after it. A swap the aggregator
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
2. **A swap**, when one coin must be traded to match the range's ratio
   and the swap is worth its gas.
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

The entry's other fields hold dollar figures and range details, which
this guide leaves aside.

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
which this guide does not need.

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

| File                       | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-cache-*.json`       | One file per pool, named for the chain, position manager, wallet, coins and fee tier. It holds one entry, and under that entry's `value`, `events` lists every NFT the wallet minted in the pool after its first, paired with the NFT before it (`oldTokenId`, `newTokenId`), with the mint's `txHash`, `blockNumber` and `timestamp`. Beside `events`, `chainFirstTokenId` and `chainFirstMintBlock` give the chain's first NFT and the block it was minted in. |
| `pnl-epochs-cache.json`    | One entry per pool, keyed by the chain, position manager, wallet, coins and fee tier, joined by dots. Under `lifetimeHodlAmounts`, `deposits` lists the coins that came into the pool's chain of NFTs from outside it, as raw amounts (`raw0`, `raw1`), with the block of the mint or deposit that took them in. The first entry is the first NFT's mint.                                                                                                        |
| `lp-position-cache-*.json` | One file per position manager and wallet. Under `positions`, every NFT the wallet holds at that position manager, drained ones included, with its two coins, their symbols and its fee tier. A `liquidity` of `"0"` means drained.                                                                                                                                                                                                                               |

The event cache names each rebalance's mint, even one from before the
rebalance log began or one whose entry is missing. It does not name
drains. The other files in the folder hold prices, block times and
similar, but no transaction amounts.

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

LP Ranger's `util/bookkeeping/coins-in-transaction.js` makes that call
and prints both, with the gas. Run it from the LP Ranger folder:

```sh
node util/bookkeeping/coins-in-transaction.js <transaction hash> --wallet <wallet address>
```

It asks the chain's first endpoint in `chains.json`, unless
`--rpc-endpoint <url>` names another; `--help` lists every option. For a
drain, it also prints the fees: the `Collect` amounts less the
`DecreaseLiquidity` ones. It prints the gas in PLS and every coin amount
raw, so divide each coin amount by 10 to the power of its coin's
decimals. It only reads, so it is safe to run while LP Ranger runs.

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
list is complete when its length matches that count. Each transaction
then shows what it was:

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

## Step by Step

Wherever a step reads a receipt,
`util/bookkeeping/coins-in-transaction.js` prints what the step needs
from it ([One Receipt per Known Transaction](#one-receipt-per-known-transaction)).

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
