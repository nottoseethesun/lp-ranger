# Bookkeeping for Coins in Transactions — User Manual

Bookkeeping in coins means recording each transaction behind a position
by the coins it moved and the gas it paid. LP Ranger ships with a set of
utilities to assist with this bookkeeping, so that you can get a
per-transaction csv file summarizing your activity on your LP
Ranger-managed liquidity positions. The set is comprised of two
command-line tools: one reads a single transaction, and one writes a csv
of a wallet's rebalances and compounds over a range of days, with each
amount's value in USD on its day.

How the tools work is in [`engineering.md`](engineering.md), and every
option of each is in [`commands.md`](commands.md).

## Contents

1. [Quick Start](#quick-start)
2. [Getting Started & How to Use](#getting-started--how-to-use)
3. [FAQ](#faq)
4. [Reading the CSV](#reading-the-csv)
5. [Which Transactions a Report Lists](#which-transactions-a-report-lists)
6. [Prices](#prices)
7. [The Moralis Key](#the-moralis-key)
8. [Time Zones and the Last Whole Day](#time-zones-and-the-last-whole-day)
9. [Looking Up One Transaction](#looking-up-one-transaction)
10. [One Run at a Time](#one-run-at-a-time)
11. [Troubleshooting](#troubleshooting)
12. [Supported Liquidity Pool Managers](#supported-liquidity-pool-managers)
13. [Supported Blockchains](#supported-blockchains)

## Quick Start

1. Open a terminal in LP Ranger's folder.
2. Write a report of a wallet's rebalances and compounds over a range of
   days:

   ```sh
   node util/bookkeeping/coins-in-transactions-on-wallet --wallet <wallet address> \
        --start-date 2026-10-01 --end-date 2026-10-31 --time-zone America/Chicago
   ```

   Type LP Ranger's wallet password when asked. The last line printed
   names the csv.
3. Or read one transaction:

   ```sh
   node util/bookkeeping/coins-in-transaction.js <transaction hash> --wallet <wallet address>
   ```

Each tool lists its options with `--help`, and
[`commands.md`](commands.md) has every option.
[Getting Started & How to Use](#getting-started--how-to-use) walks
through a first report.

## Getting Started & How to Use

1. First, read LP Ranger's User Manual and its README. The tools are
   part of LP Ranger: they run on the computer LP Ranger runs on, from
   its folder, and they use its settings and what it has recorded.
2. Make sure LP Ranger has recorded the rebalances and compounds you
   want reported. A report lists those LP Ranger recorded for the
   wallet: the positions it manages, or has shown you. A rebalance or
   compound made outside LP Ranger, on the 9mm website or by another
   tool, may not be recorded yet. Open the position in LP Ranger and
   use Reload Current Position first (LP Ranger's User Manual,
   "Rebalancing or Compounding Outside LP Ranger").
3. Have a Moralis api key. The report needs one, and the free tier is
   enough. Save it in LP Ranger (the gear icon at top right → Moralis
   API Key), or enter it when the report first asks for it.
   [The Moralis Key](#the-moralis-key) explains why.
4. Open a terminal in LP Ranger's folder.
5. Run the report, with your wallet's address, the first and last days
   you want, and your time zone:

   ```sh
   node util/bookkeeping/coins-in-transactions-on-wallet --wallet <wallet address> \
        --start-date 2026-10-01 --end-date 2026-10-31 --time-zone America/Chicago
   ```

6. At the prompt, type LP Ranger's wallet password and press Enter.
   Nothing shows as you type; that is on purpose.
7. Wait. The report prints a line as it starts, and one for each
   rebalance or compound as it finishes it. A day with eight rebalances
   and compounds takes about 40 seconds to read from the chain. Prices
   that CoinGecko gives take longer the first time: priced by CoinGecko
   alone, that day took about seven minutes more. A later run of the
   same days is quicker, since the report keeps the prices it fetched.
8. Open the csv. The report's last line names it, in
   `app-data/util/bookkeeping/`. Any spreadsheet program opens it.

A few things to know before you start:

- The report never sends a transaction and never spends gas. It reads
  the blockchain, asks for prices, and writes one file.
- It is safe to run while LP Ranger runs.
- It ends at the last whole day, which can be a day earlier than the
  end date you asked for
  ([Time Zones and the Last Whole Day](#time-zones-and-the-last-whole-day)).
- One report runs at a time ([One Run at a Time](#one-run-at-a-time)).

## FAQ

**Q: Does the report send any transactions, or spend gas?**

A: No. It reads the blockchain, asks Moralis and CoinGecko for prices,
and writes a csv file. It has no way to send a transaction.

**Q: Can I run it while LP Ranger is running?**

A: Yes. It asks the blockchain no faster than LP Ranger does, and it
writes nothing of LP Ranger's. The one exception is a Moralis key you
type into the report, which it saves where LP Ranger keeps its key. So
while the report is asking for a new key, don't save a key or password
in LP Ranger; the report reminds you.

**Q: Does the report need my wallet's private key?**

A: No. It never opens your wallet. It asks for the wallet's password
only because LP Ranger encrypts the Moralis key with that password, and
the report needs the key.

**Q: Why does the report need a Moralis key?**

A: For prices older than 180 days. CoinGecko, the free source that needs
no key, answers only for the last 180 days. Moralis has no such limit,
and it prices each coin at the very block of the transaction. The
report asks Moralis first and CoinGecko only where Moralis has no
price.

**Q: Will a Moralis key cost me anything?**

A: Not on the free tier, which is enough. As LP Ranger's User Manual
advises, open your Moralis account settings and turn off overage or
pay-as-you-go, whatever tier you are on, so you are never charged for
going past it.

**Q: Why does my report end a day earlier than I asked?**

A: A day's prices are final only once that day has ended, in your time
zone and in UTC. The report stops at the last day for which that is
true, and says so when it starts.
[Time Zones and the Last Whole Day](#time-zones-and-the-last-whole-day)
has the rule and examples.

**Q: Why is a rebalance missing from my report?**

A: Most often, it was made outside LP Ranger and LP Ranger has not
recorded it yet: open the position in LP Ranger, use Reload Current
Position, then run the report again. A rebalance also belongs to the
day its last transaction, the mint, falls on, so one that finished just
after midnight is in the next day's report.
[Which Transactions a Report Lists](#which-transactions-a-report-lists)
has the details.

**Q: Why does my report list a transaction from the day before my
range?**

A: It belongs to a rebalance or compound that began that day and
finished inside your range. The report lists every transaction of a
rebalance or compound, each with its own date, in the report its last
transaction falls in. So reports of back-to-back ranges never share a
transaction, and never skip one.

**Q: Why are there rows for approvals, cancels and reverted
transactions?**

A: Each paid gas, so each belongs in your books. An approval lets a
contract move one coin; a cancel replaced a stuck transaction; a
reverted try failed, moved nothing, and still paid its gas.

**Q: Why is a coin's price the same on every row of a day?**

A: The report keeps one price per coin per UTC day: the first one it
fetched, which every later transaction that day takes. See
[Prices](#prices).

**Q: Can I run two reports at once?**

A: No. One report runs at a time, and a second one stops at once,
saying which run holds the lock. Running two would save little anyway:
CoinGecko limits requests by IP address and Moralis by key, not by run.

**Q: Where are my reports kept? Will `npm run clean` delete them?**

A: In `app-data/util/bookkeeping/`, with the prices fetched in its
`scan-cache/` folder. `npm run clean` leaves that folder alone. A report
run again with the same wallet, days and time zone replaces the file.

**Q: Does the report send my data anywhere?**

A: Only what it needs to ask. Your blockchain endpoint is asked for your
wallet's transactions, blocks and events. Moralis and CoinGecko are
asked for coins' prices on given days, and Moralis receives your key.
Nothing else leaves your computer.

**Q: How do I record transactions the report does not list?**

A: [Step by Step](engineering.md#step-by-step), in the engineering
reference, gives the procedure for each kind, and
[Looking Up One Transaction](#looking-up-one-transaction) reads any one
transaction for you.

**Q: What if I can't find the answer here?**

A: Each tool's `--help` gives its whole reference. You may also search
(control-F, or command-F on a Mac) [`commands.md`](commands.md), the
[engineering reference](engineering.md), LP Ranger's User Manual and
README, or the code itself.

## Reading the CSV

The csv has one row per transaction, in the order your wallet sent
them. Amounts are in coins, exact to the last digit the chain records.
Each amount column is followed by its value in USD, in a column of the
same name ending `_usd`. An empty cell means nothing moved, and a coin a
row moves none of has no price on that row.

| Column | What it holds |
| --- | --- |
| `date`, `date_utc` | When the transaction's block was made, in your time zone and in UTC |
| `block`, `transaction` | The block, and the transaction's hash, which a block explorer finds |
| `move` | `rebalance`, `compound`, or `deposit`: coins you added to a position yourself |
| `nfts` | A rebalance's old and new NFT, or the NFT of a compound or deposit |
| `kind` | What the transaction did: `drain`, `swap`, `approval`, `mint`, `collect`, `deposit`, `cancel` or `reverted`, or for a transaction you sent yourself, another kind |
| `status` | `succeeded` or `reverted` |
| `token0`, `token0_address`, `token1`, `token1_address` | The pool's two coins: each one's symbol and address |
| `token0_usd_price`, `token1_usd_price` | Each of the pool's coins' price in USD on the transaction's day |
| `token0_out`, `token0_in`, `token1_out`, `token1_in` | The coins that left and entered your wallet |
| `token0_principal`, `token1_principal` | For a drain, the part of what came in that was the position's own coins |
| `token0_fees`, `token1_fees` | For a drain, the rest of what came in: the fees the position earned. For a collect, all of what came in |
| `gas_paid_PLS` | The gas paid, in the chain's own coin, whose name the column carries |
| `PLS_usd_price`, `gas_paid_usd` | That coin's price in USD on the transaction's day, and the gas paid in USD |
| `value_sent_PLS`, `value_sent_usd` | PLS sent along with the transaction, and its value in USD. LP Ranger's own transactions never send any |
| `other_coins` | Your wallet's transfers of coins outside the pool, which LP Ranger's own transactions never make: each amount in whole coins, with its symbol, address and value in USD |

Some ways to use it:

- **Gas.** Add up `gas_paid_usd` for what the range's moves cost in gas,
  or `gas_paid_PLS` for the same in PLS.
- **Fees earned.** Add up `token0_fees` and `token1_fees`, or their
  `_usd` columns. A drain's fees are those its position earned since its
  last collect; a compound's collect holds the fees before that.
- **Coins in and out.** The `_out` and `_in` columns give each coin's
  movement in and out of your wallet. A swap shows one coin out and the
  other in.
- **One move.** The rows of a rebalance or compound share their `move`
  and `nfts`, from the first transaction, a drain or a collect, to the
  last, a mint or a deposit.

## Which Transactions a Report Lists

A report starts from what LP Ranger has recorded about your wallet: the
rebalances it recorded, and the compounds in each position's records.
So it covers the positions LP Ranger manages, or has shown you, on that
computer. A rebalance or compound made outside LP Ranger is in the
report once LP Ranger has recorded it; use Reload Current Position in
LP Ranger to make sure.

For each rebalance or compound, the report lists every transaction your
wallet sent from its first to its last: approvals, swaps, cancels and
reverted tries included, since each paid gas. A transaction that belongs
to another position, sitting in the same blocks, is left out of this
one and listed with its own.

Each rebalance or compound belongs to the day its last transaction falls
on: the mint, or the deposit. Its earlier transactions come with it,
each with its own date. So a rebalance that began late on the day
before your range lists its first transactions too, and reports of
back-to-back ranges never share a transaction or skip one.

A deposit with no collect before it is coins you added to a position
yourself, and the report names it a deposit. A compound that collected
fees and then failed before its deposit is in no report; LP Ranger
still counts its gas.

## Prices

Prices come from Moralis, through LP Ranger's own price library, which
prices a coin at the transaction's block. Where Moralis has no price for
a coin, CoinGecko gives it: the coin's closing price on the
transaction's UTC day. PLS is priced through WPLS, its wrapped form, so
the gas and any PLS sent take WPLS's price.

Each coin has one price per UTC day: the first one fetched, which every
later transaction that day takes. Moralis could give each transaction
the price at its own block. The report keeps prices by day instead, as
LP Ranger does, so a day's transactions cost one request per coin.

CoinGecko's free service has two limits. It reaches back only 180 days,
so an older day's prices must come from Moralis. It also answers only a
few requests a minute. The report waits and asks again whenever it is
refused for asking too often, which is why prices CoinGecko gives take
minutes the first time.

Each price is kept as it arrives. A later run asks only for the coins
and days not yet kept, even after a run that stopped. These prices are
the report's own: LP Ranger keeps its own prices apart, and the report
never changes them.

## The Moralis Key

The report uses LP Ranger's own Moralis key: one key, kept in one place.
A key you saved in LP Ranger serves the report, and a key you give the
report serves LP Ranger from the next time its wallet is unlocked.
LP Ranger keeps the key encrypted with your wallet's password, in a file
that never leaves your computer.

**Each run** asks:

```text
Password for the Moralis api key (LP Ranger's wallet password):
```

Type LP Ranger's wallet password. Nothing shows as you type. The report
never opens your wallet; the password only opens the key. The report
then asks Moralis whether the key still works, before it prices
anything. A key whose free quota is used up still runs: CoinGecko
prices each coin until the quota resets, for the last 180 days only.

**The first time**, with no key saved, the report says so and warns:

```text
Don't save a key or password in LP Ranger while this runs.
```

It then asks for the key, and for the password twice, the second time
as "That password again:". Type the password LP Ranger's wallet unlocks
with: LP Ranger cannot open a key saved under any other. The report saves
the key only if Moralis takes it, and says where. It never changes the
password itself.

**To change the key**, save the new one in LP Ranger: the gear icon →
Moralis API Key.

**After clearing the wallet** and importing it again under a new
password, the key is still encrypted with the old one, as LP Ranger's
Clear Wallet dialog warns. The report then cannot open it with the new
password. Save the key again in LP Ranger, which encrypts it with the
new password, then run the report again.

## Time Zones and the Last Whole Day

`--time-zone` takes a full time zone name, such as `America/Chicago`,
`Europe/London` or `Asia/Tokyo`, or `UTC`, in any letter case. It
refuses three-letter designations such as `CDT`, because one can name
several clocks: `CST` is US Central, China and Cuba Standard Time. It
refuses the old name `EST` too. `--list-valid-timezones` prints every
name it takes, one per line, and each refusal points to it. Leave the
option out, and the report stops and names your computer's own time
zone, to use if it is the one you want.

The dates are whole days in your time zone, daylight saving included,
and the end date is included. The csv gives each transaction's time
both in your time zone and in UTC.

The report ends at the **last whole day**. A day is whole once it has
ended, and so has the UTC day of its last hour, because CoinGecko's
closing price for a UTC day is known only once that day ends:

- In UTC, yesterday is whole.
- West of Greenwich, a day's last hours fall on the next UTC day. So a
  day in `America/Chicago` is whole at 7 pm the next day, or 6 pm in
  winter.
- East of Greenwich, a day in `Asia/Tokyo` is whole at 9 am the next
  day.

A range that reaches past the last whole day is cut there, and the
report says so before it starts:

```text
The report ends at 2026-10-19, the last whole day. 2026-10-20 becomes whole at 2026-10-21 19:00:00 America/Chicago, once the UTC day of its last hour has ended.
```

The csv is then named for the days it covers. A range with no whole day
writes nothing, and says when its first day becomes whole.

## Looking Up One Transaction

`coins-in-transaction.js` reads one transaction and prints what it moved
for your wallet. Use it to check a row of the report, or to record a
transaction the report does not list:

```sh
node util/bookkeeping/coins-in-transaction.js <transaction hash> --wallet <wallet address>
```

It prints a json object naming the transaction's `kind` (a drain, a
swap, a mint, and so on), the position's events, a drain's `fees`, the
coins that left and entered your wallet (`transfers`), any `approvals`,
and the gas paid (`gasPaid`). Its amounts are raw, as the blockchain
records them: divide each by 10 to the power of its coin's decimals, 18
for PLS and most coins. To keep the result, send it to a file:

```sh
node util/bookkeeping/coins-in-transaction.js <transaction hash> --wallet <wallet address> > transaction.json
```

It needs no key and no password, and asks the blockchain for one
receipt. `--help` names every field.

## One Run at a Time

One report runs at a time. A report takes a lock as it starts and
releases it as it ends, whether it wrote its csv or stopped, Ctrl+C
included. A report started meanwhile stops at once:

```text
Another run of the report holds the cache of prices: process 1234, since 2026-10-21T14:02:11.000Z. Run this one once it ends. If `ps -p 1234` lists no such process, that run stopped before it could release the lock: delete the lock with `rm '…/app-data/util/bookkeeping/scan-cache/price-caches.lock'`, then run again.
```

Wait for the other report to end, and run yours again. Only a report
killed outright, by `kill -9` or the computer going down, leaves its lock
behind. Then do as the message says: check that the process it names is
gone, and run the `rm` it gives.

## Troubleshooting

When a report stops, it writes no csv and says what happened and what to
try. Each message, as it begins, is below with what to do.

`Another run of the report holds the cache of prices…` — Another report
is running. See [One Run at a Time](#one-run-at-a-time).

`Could not open the Moralis api key LP Ranger keeps in …` — The
password did not open the key. Run again and type LP Ranger's wallet
password. If that is what you typed, the key was saved before you
imported your wallet again under a new password: save the key again in
LP Ranger, then run again.

`Moralis refused the api key saved in …` — Moralis no longer takes your
key. Save a new one in LP Ranger (the gear icon → Moralis API Key), then
run again.

`Moralis refused the api key, so it was not saved.` — The key you typed
is not one Moralis takes. Run again, and enter the key exactly as
Moralis shows it.

`Moralis did not answer the check of the api key…` — Moralis could not
be reached. Try again later.

`The two passwords differ, so the key was not saved.` — Run again, and
type the same password twice.

`Neither Moralis nor CoinGecko (GeckoTerminal) gave a USD price for …`
— Neither source has a price for that coin on that day, and the report
writes no csv without every price. CoinGecko reaches back only 180
days, so for an older day the price must come from Moralis: check that
your key works and has quota left. Otherwise, try again later.

`https://… failed: …` — Your blockchain endpoint failed, or had no
record of a transaction it should hold. Run again with `--rpc-endpoint`
and another endpoint's address
([`commands.md`](commands.md#the-blockchain-the-endpoint-and-the-position-manager)).

`No day of the range is whole yet, so no csv was written…` — Every day
you asked for is still too recent. Run again after the time it names.

`error: required option '--time-zone <zone>' not specified…` — Add
`--time-zone`, with the time zone it suggests if that is yours.

**A rebalance or compound is missing.** LP Ranger has not recorded it.
Open the position in LP Ranger, use Reload Current Position, wait for
it to finish, and run the report again.

**The report is slow.** Prices that CoinGecko gives come slowly the
first time, because CoinGecko answers only a few requests a minute. A
working Moralis key with quota left makes most prices quick, and a
later run of the same days takes its prices from what it kept.

## Supported Liquidity Pool Managers

9mm V3: concentrated liquidity, a Uniswap V3 fork, on PulseChain. The
tools read V3 NFT positions created through the 9mm Pro Liquidity
Manager, the positions LP Ranger manages.

## Supported Blockchains

PulseChain: an EVM-compatible Layer 1 blockchain (chain id 369). The
tools read the blockchain LP Ranger is set to, and `--blockchain`
chooses another that LP Ranger's settings name.
