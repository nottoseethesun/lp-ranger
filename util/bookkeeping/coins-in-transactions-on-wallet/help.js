"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/help.js
 * @description
 * The part of the report's `--help` printed after its list of options:
 * the time zones it takes, the csv it writes and each column, which
 * transactions it lists, an example and the exit status. Commander prints
 * the usage, the description and the options themselves from the
 * declaration in index.js; this is the rest, kept apart as plain text the
 * way `util/cache/clean-pool-cache-help.js` keeps its tool's.
 */

/** The help printed after the options, line breaks and all. */
const HELP_AFTER = `
Time zones:
  --time-zone takes a full time zone name, such as America/Chicago, or UTC.
  Three-letter designations such as CDT are not taken: one can name several
  clocks (CST is US Central, China and Cuba Standard Time). The days of the
  range are whole days in that zone, daylight saving included.
  --list-valid-timezones prints every name it takes, one per line.

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
    token0, token1        the pool's two coins' symbols, and with
                          _address, their addresses
    token0_out, token0_in,
    token1_out, token1_in the coins that left and entered the wallet
    token0_principal,
    token1_principal      a drain's principal: its DecreaseLiquidity amounts
    token0_fees,
    token1_fees           a drain's Collect less its principal, or the whole
                          Collect of a compound's collect
    gas_paid_<coin>       the gas paid, in the chain's own coin
    value_sent_<coin>     the chain's own coin sent as the transaction's value
    other_coins           the wallet's transfers of other coins, raw
  Amounts are in coins, divided by each coin's decimals exactly. An empty
  cell means nothing moved.

Which transactions:
  Every rebalance and compound app-data/ records for the wallet, from the
  event caches, the rebalance log and the position records: the positions
  this install has records for. A rebalance or compound belongs to the
  range its last transaction, the mint or the deposit, falls in, and every
  transaction of it is listed, so reports of back-to-back ranges never share
  a transaction or skip one. Approvals, cancels and reverted tries are
  listed with the rest. A failed compound's collect, with no deposit after
  it, is in no report.

  Requests are spaced as LP Ranger spaces its own, so it is safe to run
  while LP Ranger runs. A day with eight rebalances and compounds takes
  about 40 seconds.

Example:
  node util/bookkeeping/coins-in-transactions-on-wallet --wallet <address> \\
       --start-date 2026-10-01 --end-date 2026-10-31 \\
       --time-zone America/Chicago

How it works: docs/bookkeeping-for-coins-in-transactions.md

Exit status: 0 when the csv was written or the time zones were listed, 1
when the arguments were refused or the csv was not written.
`;

module.exports = { HELP_AFTER };
