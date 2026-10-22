"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/help.js
 * @description
 * The part of the report's `--help` printed after its list of options:
 * the time zones it takes, the blockchain and configuration it reads, the
 * csv it writes and each column, where its prices come from and the key
 * that needs, the last whole day, which transactions it lists, what stops
 * it, an example and the exit status.
 * Commander prints the usage, the description and the options themselves
 * from the declaration in index.js; this is the rest, kept apart as plain
 * text the way `util/cache/clean-pool-cache-help.js` keeps its tool's.
 */

/** The help printed after the options, line breaks and all. */
const HELP_AFTER = `
Time zones:
  --time-zone takes a full time zone name, such as America/Chicago, or UTC.
  Three-letter designations such as CDT are not taken: one can name several
  clocks (CST is US Central, China and Cuba Standard Time). The days of the
  range are whole days in that zone, daylight saving included.
  --list-valid-timezones prints every name it takes, one per line.

Blockchain and configuration:
  Every setting is LP Ranger's own, from its configuration (.env and
  settings): the blockchain, the endpoint, the position manager and the
  chain's coins. A run reads one blockchain, LP Ranger's own unless
  --blockchain names another the configuration names; when the
  configuration names more than one, the run says so.

The csv:
  Written to app-data/util/bookkeeping/ as
  <wallet>_<start>-to-<end>_<zone>_coins-in-transactions.csv, a slash in the
  zone written as a dash. The last line printed gives its path. One row per
  transaction, in the order the wallet sent them, with these columns:
    date, date_utc        the block's time, in the time zone and in UTC
    block, transaction    the block, and the transaction's hash
    move                  rebalance, compound, or deposit: coins the owner
                          added with no collect before them
    nfts                  a rebalance's old and new NFT, or the NFT
    kind, status          what the transaction did, as coins-in-transaction.js
                          names it, and whether it succeeded or reverted
    token0, token1        the pool's two coins' symbols; with _address, their
                          addresses, and with _usd_price, their USD prices
    token0_out, token0_in,
    token1_out, token1_in the coins that left and entered the wallet
    token0_principal,
    token1_principal      a drain's principal: its DecreaseLiquidity amounts
    token0_fees,
    token1_fees           a drain's Collect less its principal, or the whole
                          Collect of a compound's collect
    gas_paid_<coin>       the gas paid, in the chain's own coin
    <coin>_usd_price      the chain's own coin's USD price
    gas_paid_usd          the gas paid, in USD
    value_sent_<coin>     the chain's own coin sent as the transaction's value
    value_sent_usd        that value, in USD
    other_coins           the wallet's transfers of other coins: each amount,
                          symbol, address and USD value
  Each amount column is followed by its value in USD, in a column of the
  same name ending _usd. Amounts are in coins, divided by each coin's
  decimals exactly. An empty cell means nothing moved, and a coin the row
  moves none of has no price in it.

Prices:
  From Moralis, at the transaction's block, with LP Ranger's own price
  library. Where Moralis has no price, from CoinGecko through
  GeckoTerminal: the closing price of the transaction's UTC day. The
  chain's own coin is priced through its wrapped form. Each coin has one
  price per UTC day: the first one fetched, which every later transaction
  that day takes. GeckoTerminal's free api reaches back only 180 days, so
  an older day's prices come from Moralis. Each price is kept in
  app-data/util/bookkeeping/scan-cache/ as it arrives. A later run, or one
  after a run that stopped, asks only for the coins and days not yet kept.

The Moralis api key:
  The key is LP Ranger's own, as the dashboard's Settings save it:
  encrypted with the wallet's password, in
  app-config/user-configurable/api-keys.json. The report needs neither the
  wallet nor its private key; the password opens only the key. Each run
  asks for it, typed in the terminal, which shows nothing as it is typed,
  and asks Moralis about the key before pricing anything. With no key
  saved yet, the run asks for it, and for the password twice, and saves it
  there only if Moralis takes it; LP Ranger uses it too from its next
  unlock. Git ignores the file, so it never reaches the remote. A key
  whose quota is used up still runs: CoinGecko answers until the quota
  resets. To enter another key, or once the wallet is imported again under
  a new password, save the key in the dashboard's Settings.

The last whole day:
  The run ends at the last whole day. A day is whole once it has ended, and
  so has the UTC day of its last hour: a UTC day's closing price is known
  only once that day ends. West of Greenwich, a day's last hours fall on
  the next UTC day, so a day in America/Chicago is whole at 7 pm the next
  day (6 pm in winter). A range reaching past the last whole day is cut
  there, with a line saying when the next day becomes whole. A range with
  no whole day writes nothing.

Which transactions:
  Every rebalance and compound app-data/ records for the wallet, from the
  event caches, the rebalance log and the position records: the positions
  this install has records for. A rebalance or compound belongs to the
  range its last transaction, the mint or the deposit, falls in, and every
  transaction of it is listed, so reports of back-to-back ranges never share
  a transaction or skip one. Approvals, cancels and reverted tries are
  listed with the rest. A failed compound's collect, with no deposit after
  it, is in no report.

  Requests to the endpoint are spaced as LP Ranger spaces its own, and the
  report writes nothing of LP Ranger's, so it is safe to run while LP Ranger
  runs. One run at a time prices: a run takes a lock on the cache of prices
  as it starts, and releases it as it ends, Ctrl+C included. A day with eight
  rebalances and compounds takes about 40 seconds to read from the chain.
  Prices CoinGecko gives take longer: its free api answers only a few
  requests a minute, and the run waits and asks again whenever it is
  refused for asking too often. Priced by CoinGecko alone, that day took
  about seven minutes more the first time. A later run of the same days
  takes its prices from the cache.

What stops a run:
  A run started while another holds the lock on the cache of prices stops
  at once, saying which run holds it. A run killed outright (kill -9, or
  the machine going down) cannot release the lock, so the next run says
  how to release it.
  The run asks one endpoint, and moves to no other; for prices it asks
  Moralis, then CoinGecko, and no third. When the endpoint fails, or
  neither oracle has a price for a coin, it stops with the error and writes
  no csv. It says what to try: a different rpc node with --rpc-endpoint,
  or a different price oracle. An endpoint with no receipt for a transaction
  it must hold, one LP Ranger recorded or one the endpoint lists in a
  block, has failed too: a csv without it would look complete. A password
  that does not open the saved key, or a key Moralis refuses or cannot
  check, stops the run too, saying what to do.

Example:
  node util/bookkeeping/coins-in-transactions-on-wallet --wallet <address> \\
       --start-date 2026-10-01 --end-date 2026-10-31 \\
       --time-zone America/Chicago

User manual: docs/util/bookkeeping-for-coins-in-transactions/user-manual.md
How it works: docs/util/bookkeeping-for-coins-in-transactions/engineering.md

Exit status: 0 when the csv was written or the time zones were listed, 1
when the arguments were refused or the csv was not written.
`;

module.exports = { HELP_AFTER };
