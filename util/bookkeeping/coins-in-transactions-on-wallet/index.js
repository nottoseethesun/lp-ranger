"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/index.js
 * @description
 * Write a csv of every transaction of a wallet's rebalances and compounds
 * in a range of days, one row per transaction, with the coins it moved and
 * the gas it paid, each with its value in USD: the procedures of
 * `docs/bookkeeping-for-coins-in-transactions.md`, run for a whole range.
 *
 * It starts from what `app-data/` records (moves.js): the rebalances in
 * the event caches and the rebalance log, and the compounds in the
 * position records. A move belongs to the range its last transaction, the
 * mint or the deposit, falls in, judged by that transaction's block time
 * in the given time zone. The report lists every transaction of the move,
 * so a rebalance that began the evening before the range lists those
 * transactions too, and no transaction lands in two reports. For each
 * move, a search by NFT (chain.js) finds the first transaction: a
 * rebalance's drain, a compound's collect. A search by wallet then lists
 * every transaction the wallet sent from that block to the last,
 * approvals, cancels and reverted tries included. A transaction that
 * names another NFT, or moves or approves another pool's coins, is left
 * for its own move. `coins-in-transaction.js` reads each transaction, and
 * csv.js makes it a row. `../usd-prices.js`, which wraps LP Ranger's own
 * price library, prices each coin the row shows and the chain's own coin
 * for the gas. Moralis prices a coin at the transaction's block; where it
 * has no price, CoinGecko, through GeckoTerminal, gives the UTC day's
 * closing price. The library keeps one price per coin per UTC day. The
 * Moralis key is opened with a password before the run reads anything
 * (`../moralis-key.js`).
 *
 * The run ends at the last whole day: the last day that ended before the
 * current UTC day began, along with the UTC day of its last hour. A UTC
 * day's closing price is known only once that day ends. A range reaching
 * past the last whole day is cut there, and one with no whole day writes
 * nothing.
 *
 * The csv goes to `app-data/util/bookkeeping/`, named for the wallet, the
 * dates and the time zone, and the last line printed says where; the
 * prices fetched are kept in its `scan-cache/` folder. It covers the
 * positions whose records this install holds: a position never managed or
 * viewed here has nothing in its files.
 *
 * The run stops, writing no csv, when another run holds the cache of
 * prices, the endpoint fails, a coin cannot be priced, or the Moralis key
 * cannot be opened or is refused. It says which, with what to try: the
 * other run's end, another rpc node, another price oracle, the key's
 * password, or a new key. It moves to no other endpoint by itself.
 *
 * The time zone is a full name from the list dates.js keeps, such as
 * America/Chicago, or UTC; a three-letter designation such as CDT is
 * refused, since one can name several clocks. `--list-valid-timezones`
 * prints the list, and every refusal of a time zone points to it.
 *
 * Every configuration value is LP Ranger's own, from the app's resolver
 * (src/config.js), as in coins-in-transaction.js, whose option parsers it
 * shares: the chain, LP Ranger's own unless `--blockchain` names another
 * (../blockchain.js settles it before the resolver loads), the endpoint,
 * the position manager, and the chain's coins. A run reads one
 * blockchain, and says so when the configuration names more than one. It
 * writes nothing of the app's, so it is safe to run while LP Ranger runs.
 * Nothing it calls reads LP Ranger's settings through `loadConfig`, so a
 * run leaves their backups alone. One run prices at a time: a run takes a
 * lock on the cache of prices before it asks for the key
 * (../price-cache-lock.js), and a run started meanwhile stops at once,
 * saying which run holds it.
 * `--help` prints the rest: the csv's columns, which transactions it
 * lists, where the prices come from, an example (help.js).
 *
 * Exit status is 0 when the csv was written or the time zones were
 * listed, and 1 when the arguments were refused or the csv was not
 * written.
 *
 * Usage:
 *   node util/bookkeeping/coins-in-transactions-on-wallet --wallet <address>
 *        --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> --time-zone <zone>
 *   node util/bookkeeping/coins-in-transactions-on-wallet --list-valid-timezones
 *   node util/bookkeeping/coins-in-transactions-on-wallet --help
 */

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const { parseBlockchain, oneChainNotice } = require("../blockchain");
const config = require("../../../src/config");
const { parseEndpoint } = require("../../diagnostic/check-rpc-health");
const {
  RPC_ADVICE,
  parseAddress,
  sameAddress,
  coinsInTransaction,
  makeProvider,
  positionManagerOf,
  endpointOf,
  blockchainMismatch,
} = require("../coins-in-transaction");
const { PRICE_ADVICE, cachePath, usdPriceOn } = require("../usd-prices");
const {
  PRICE_CACHE_LOCK_FILE,
  takePriceCacheLock,
} = require("../price-cache-lock");
const { unlockMoralisKey } = require("../moralis-key");
const {
  parseDate,
  validTimeZones,
  isValidTimeZone,
  parseTimeZone,
  localTimeZone,
  nextDay,
  rangeIn,
  formatIn,
  wholeFrom,
  lastWholeDay,
} = require("./dates");
const { HELP_AFTER } = require("./help");
const { recordsNear } = require("./moves");
const {
  SPACING_MS,
  pacedProvider,
  drainBlockBefore,
  collectBlockBefore,
  walletTransactionsIn,
  coinInfo,
  nftCoins,
  markRpcFailure,
} = require("./chain");
const { columns, coinsToPrice, rowOf, toCsv } = require("./csv");

/** The `app-data/` folder of the install this tool ships in. */
const APP_DATA_DIR = path.resolve(__dirname, "../../../app-data");

/** Seconds in the month a drain search covers when nothing bounds it. */
const MONTH_SEC = 30 * 24 * 60 * 60;

/** The options a report cannot run without, by key and as help spells them. */
const REQUIRED = [
  ["wallet", "--wallet <address>"],
  ["startDate", "--start-date <YYYY-MM-DD>"],
  ["endDate", "--end-date <YYYY-MM-DD>"],
];

/**
 * Describe the command line, so Commander both parses it and renders
 * `--help` from the same declaration.
 *
 * The required options are declared as plain options and checked in
 * `readOptions`, so that `--list-valid-timezones` works on its own, as
 * `--help` does, and a missing time zone can be refused with the
 * computer's own zone offered.
 *
 * @returns {Command}  Configured, not yet parsed.
 */
function buildProgram() {
  return new Command()
    .name("coins-in-transactions-on-wallet")
    .description(
      "Write a csv of every transaction of a wallet's rebalances and " +
        "compounds in a range of days, one row per transaction, with the " +
        "coins it moved and the gas it paid, each with its value in USD " +
        "from Moralis, or CoinGecko where Moralis has none. Starts from " +
        "what app-data/ records, then reads the chain; sends nothing.",
    )
    .option(
      "--wallet <address>",
      "the wallet whose transactions to list (required)",
      parseAddress,
    )
    .option(
      "--start-date <YYYY-MM-DD>",
      "the range's first day (required)",
      parseDate,
    )
    .option(
      "--end-date <YYYY-MM-DD>",
      "the range's last day, included (required)",
      parseDate,
    )
    .option(
      "--time-zone <zone>",
      "the time zone the days are in, a full name such as America/Chicago, " +
        "or UTC (required)",
      parseTimeZone,
    )
    .option(
      "--list-valid-timezones",
      "print every name --time-zone takes, one per line, and exit",
    )
    .option(
      "--blockchain <name>",
      "the blockchain to read, one the configuration names (default: " +
        "LP Ranger's own, pulsechain as shipped)",
      parseBlockchain,
    )
    .option(
      "--rpc-endpoint <url>",
      "the endpoint to ask (default: the one LP Ranger tries first)",
      parseEndpoint,
    )
    .option(
      "--position-manager <address>",
      "the position manager whose positions to report (default: LP " +
        "Ranger's)",
      parseAddress,
    )
    .addHelpText("after", HELP_AFTER);
}

/**
 * The refusal of a run with no time zone: it offers the computer's own
 * zone when that zone is on the list, and names the way to see the list.
 * @returns {string}
 */
function missingTimeZone() {
  const local = localTimeZone();
  const offer = isValidTimeZone(local)
    ? ` This computer's time zone is ${local}; to use it, pass ` +
      `--time-zone ${local}.`
    : "";
  return (
    `error: required option '--time-zone <zone>' not specified.${offer} ` +
    "Run with --list-valid-timezones to see every valid time zone."
  );
}

/**
 * Parse and check the arguments. `--list-valid-timezones` needs nothing
 * else. Otherwise each required option must be there, a missing time zone
 * is refused with the computer's own zone offered, and a range that ends
 * before it starts is refused; Commander prints each refusal and exits 1.
 *
 * @param {string[]} argv  Arguments after the node/script pair.
 * @param {Command} [program]  The command; tests pass one that throws
 *   instead of exiting.
 * @returns {object}  The parsed options.
 */
function readOptions(argv, program = buildProgram()) {
  program.parse(argv, { from: "user" });
  const opts = program.opts();
  if (opts.listValidTimezones === true) return opts;
  for (const [key, flags] of REQUIRED) {
    if (opts[key] === undefined)
      program.error(`error: required option '${flags}' not specified`);
  }
  if (opts.timeZone === undefined) program.error(missingTimeZone());
  if (opts.startDate > opts.endDate) {
    program.error(
      `error: --start-date ${opts.startDate} is after --end-date ` +
        opts.endDate,
    );
  }
  return opts;
}

/**
 * Where a report is written.
 * @param {string} appDataDir  The `app-data/` folder.
 * @param {{wallet: string, startDate: string, endDate: string,
 *   timeZone: string}} opts  The parsed options.
 * @returns {string}  The csv's path. A time zone's slash becomes a dash.
 */
function reportPath(appDataDir, { wallet, startDate, endDate, timeZone }) {
  const zone = timeZone.replaceAll("/", "-");
  const name = `${wallet}_${startDate}-to-${endDate}_${zone}_coins-in-transactions.csv`;
  return path.join(appDataDir, "util", "bookkeeping", name);
}

/**
 * The range a run reports: the one asked for, ending at the last whole
 * day (dates.js `lastWholeDay`). A range that reaches past it is cut
 * there, with a line saying so and when the next day becomes whole; a
 * range with no whole day is refused, saying when its first day becomes
 * whole.
 *
 * @param {{startDate: string, endDate: string, timeZone: string}} opts
 *   The parsed options.
 * @param {number} nowMs  The moment of the run, in milliseconds since 1970.
 * @returns {{opts: object, note: (string|null)}|{refusal: string}}  The
 *   options to run with and the line to print, or the refusal.
 */
function wholeDays(opts, nowMs) {
  const { startDate, endDate, timeZone } = opts;
  const last = lastWholeDay(nowMs, timeZone);
  if (endDate <= last) return { opts, note: null };
  const whenWhole = (date) =>
    `${formatIn(wholeFrom(date, timeZone), timeZone)} ${timeZone}`;
  if (startDate > last)
    return {
      refusal:
        `No day of the range is whole yet, so no csv was written: ` +
        `${startDate} becomes whole at ${whenWhole(startDate)}, once the ` +
        "UTC day of its last hour has ended.",
    };
  const next = nextDay(last);
  return {
    opts: { ...opts, endDate: last },
    note:
      `The report ends at ${last}, the last whole day. ${next} becomes ` +
      `whole at ${whenWhole(next)}, once the UTC day of its last hour has ` +
      "ended.",
  };
}

/**
 * How a move is named in the lines printed as the report runs.
 * @param {{type: string, nfts: string[]}} move
 * @returns {string}
 */
function describe(move) {
  if (move.type === "rebalance")
    return `Rebalance of NFT #${move.nfts[0]} into #${move.nfts[1]}`;
  if (move.type === "compound") return `Compound of NFT #${move.nfts[0]}`;
  return `Deposit into NFT #${move.nfts[0]}`;
}

/**
 * Whether a transaction belongs to a move. One that names NFTs belongs
 * when it names one of the move's; one that moves or approves coins
 * belongs when every coin is the pool's; one that does neither, a cancel
 * or a reverted try, belongs to the move whose blocks it sits in.
 *
 * @param {object} record  The transaction's record.
 * @param {{nfts: string[]}} move
 * @param {{token0: string, token1: string}} pool  The move's coins.
 * @returns {boolean}
 */
function belongsTo(record, move, pool) {
  const nfts = [
    ...record.liquidity.map((e) => e.nftId),
    ...record.nftTransfers.map((t) => t.nftId),
  ];
  if (nfts.length > 0) return nfts.some((id) => move.nfts.includes(id));
  const touched = [
    ...record.transfers.map((t) => t.coin),
    ...record.approvals.map((a) => a.coin),
  ];
  const ours = (coin) =>
    sameAddress(coin, pool.token0) || sameAddress(coin, pool.token1);
  return touched.every(ours);
}

/**
 * A move's last transaction: its block and that block's time.
 * @param {object} provider  A paced provider.
 * @param {{lastHash: string}} move
 * @returns {Promise<{blockNumber: number, endMs: number}|null>}  Null when
 *   the endpoint has no receipt for it.
 */
async function lastOf(provider, move) {
  const receipt = await provider.getTransactionReceipt(move.lastHash);
  if (receipt === null) return null;
  const block = await provider.getBlock(receipt.blockNumber);
  return { blockNumber: receipt.blockNumber, endMs: block.timestamp * 1000 };
}

/**
 * The error a run stops with when the endpoint has no receipt for a
 * transaction it must hold: one LP Ranger read from a receipt when it
 * recorded the move, or one the endpoint itself lists in a block. Either
 * way the endpoint is missing data, so the error is marked as its
 * failure, and the run suggests another rpc node rather than writing a
 * csv without the transaction.
 * @param {string} hash  The transaction's hash.
 * @param {string} why  Why the endpoint must hold it.
 * @returns {Error}
 */
function missingReceipt(hash, why) {
  return markRpcFailure(new Error(`no receipt for ${hash}, ${why}`));
}

/**
 * A rebalance's drain block. When the rebalance log lists the move, its
 * first listed transaction is checked first; it is the drain unless an
 * earlier attempt drained the NFT, and then a search by NFT finds it.
 *
 * @param {object} provider  A paced provider.
 * @param {object} move  A rebalance.
 * @param {number} mintBlock
 * @param {object} ctx  The run's context.
 * @returns {Promise<number|null>}
 */
async function drainBlockOf(provider, move, mintBlock, ctx) {
  if (move.listed.length > 1) {
    const first = await coinsInTransaction(provider, {
      hash: move.listed[0],
      wallet: ctx.wallet,
      positionManager: ctx.positionManager,
    });
    const drain = (e) =>
      e.event === "DecreaseLiquidity" && e.nftId === move.nfts[0];
    if (first !== null && first.liquidity.some(drain)) return first.blockNumber;
  }
  return drainBlockBefore(provider, {
    positionManager: ctx.positionManager,
    nftId: move.nfts[0],
    mintBlock,
    floorBlock: move.floorBlock,
    blocksPerMonth: ctx.blocksPerMonth,
  });
}

/**
 * A move's first block: a rebalance's drain or a compound's collect. A
 * deposit with no collect before it is coins the owner added, and the
 * move is renamed a deposit.
 *
 * @param {object} provider  A paced provider.
 * @param {object} move
 * @param {number} lastBlock  The block of the move's last transaction.
 * @param {object} ctx  The run's context.
 * @returns {Promise<number>}
 */
async function firstBlockOf(provider, move, lastBlock, ctx) {
  if (move.type === "rebalance") {
    const drain = await drainBlockOf(provider, move, lastBlock, ctx);
    return drain === null ? lastBlock : drain;
  }
  const collect = await collectBlockBefore(provider, {
    positionManager: ctx.positionManager,
    nftId: move.nfts[0],
    depositHash: move.lastHash,
    depositBlock: lastBlock,
  });
  if (collect === null) {
    move.type = "deposit";
    return lastBlock;
  }
  return collect;
}

/**
 * A move's two coins: from the event cache or the rebalance log, else the
 * LP position cache, else the position manager.
 * @param {object} provider  A paced provider.
 * @param {object} move
 * @param {object} ctx  The run's context.
 * @returns {Promise<{token0: string, token1: string}>}
 */
async function poolOf(provider, move, ctx) {
  if (move.coins !== null) return move.coins;
  const cached = ctx.coinsOf.get(move.nfts[0]);
  if (cached !== undefined) return cached;
  return nftCoins(provider, ctx.positionManager, move.nfts[0]);
}

/**
 * Make sure the run knows each coin's symbol and decimals: from
 * `app-data/` where it records them, else from the coin.
 * @param {object} provider  A paced provider.
 * @param {string[]} coins  The coins' addresses.
 * @param {object} ctx  The run's context.
 * @returns {Promise<void>}
 */
async function learnCoins(provider, coins, ctx) {
  for (const coin of coins) {
    const key = coin.toLowerCase();
    if (ctx.info.has(key)) continue;
    let info = {
      symbol: ctx.symbols.get(key),
      decimals: ctx.decimals.get(key),
    };
    if (info.symbol === undefined || info.decimals === undefined)
      info = await coinInfo(provider, coin);
    ctx.info.set(key, info);
  }
}

/**
 * Each coin's USD price for a transaction, keyed by lower-cased address:
 * from Moralis at its block, or from CoinGecko for its UTC day. The price
 * library keeps one price per coin per UTC day once fetched, so the coins
 * of a day's later rows cost no further request.
 * @param {string[]} coins  The coins' addresses.
 * @param {{timestamp: number, blockNumber: number}} moment  The
 *   transaction's block time, in Unix seconds, and its block.
 * @param {{usdPriceOn: Function}} ctx  The run's context.
 * @returns {Promise<Map<string, number>>}
 */
async function pricesOn(coins, moment, ctx) {
  const prices = new Map();
  for (const coin of coins)
    prices.set(coin.toLowerCase(), await ctx.usdPriceOn(coin, moment));
  return prices;
}

/**
 * Every row of one move, or null when its last transaction falls outside
 * the range.
 *
 * @param {object} provider  A paced provider.
 * @param {object} move
 * @param {object} ctx  The run's context.
 * @returns {Promise<Array<{block: number, nonce: number, cells: string[]}>|null>}
 * @throws {Error} Marked `rpcFailure`, when the endpoint has no receipt
 *   for the move's last transaction or for one it lists in the move's
 *   blocks, since a csv without that transaction would look complete.
 */
async function rowsOfMove(provider, move, ctx) {
  const last = await lastOf(provider, move);
  if (last === null)
    throw missingReceipt(move.lastHash, "which LP Ranger recorded as mined");
  if (last.endMs < ctx.range.startMs || last.endMs >= ctx.range.endMs)
    return null;
  const first = await firstBlockOf(provider, move, last.blockNumber, ctx);
  const pool = await poolOf(provider, move, ctx);
  await learnCoins(provider, [pool.token0, pool.token1], ctx);
  const txs = await walletTransactionsIn(
    provider,
    ctx.wallet,
    first,
    last.blockNumber,
  );
  const rows = [];
  for (const tx of txs) {
    if (ctx.claimed.has(tx.hash)) continue;
    const record = await coinsInTransaction(provider, {
      hash: tx.hash,
      wallet: ctx.wallet,
      positionManager: ctx.positionManager,
    });
    if (record === null)
      throw missingReceipt(
        tx.hash,
        `which the endpoint lists in block ${tx.blockNumber}`,
      );
    if (!belongsTo(record, move, pool)) continue;
    ctx.claimed.add(tx.hash);
    const wanted = coinsToPrice(record, pool, move.nfts);
    await learnCoins(provider, wanted, ctx);
    const moment = { timestamp: tx.timestamp, blockNumber: tx.blockNumber };
    const prices = await pricesOn(wanted, moment, ctx);
    const nativePrice = await ctx.usdPriceOn(ctx.nativeCoin, moment);
    const cells = rowOf({
      tx,
      record,
      move,
      pool,
      info: ctx.info,
      timeZone: ctx.timeZone,
      prices,
      nativePrice,
    });
    rows.push({ block: tx.blockNumber, nonce: tx.nonce, cells });
  }
  return rows;
}

/**
 * What a run that stops on a failure prints: the error, and what to try.
 * A coin with no price points to another price oracle, an endpoint that
 * failed to another rpc node, and a Moralis key that could not be opened
 * or was refused, or a lock another run holds, says itself what to do.
 *
 * @param {Error} error  Why the run stopped.
 * @param {string} endpoint  The endpoint the run asked.
 * @returns {string|null}  The lines, or null for any other error, which
 *   is not one of these and is reported as it is.
 */
function failureText(error, endpoint) {
  if (error.priceUnavailable === true)
    return `${error.message}\n${PRICE_ADVICE}`;
  if (error.rpcFailure === true)
    return `${endpoint} failed: ${error.message}\n${RPC_ADVICE}`;
  if (error.keyRefused === true) return error.message;
  if (error.lockHeld === true) return error.message;
  return null;
}

/**
 * Parse the arguments, take the lock on the cache of prices, open the
 * Moralis key, find the transactions, write the csv, say where it is, and
 * release the lock; or, asked for `--list-valid-timezones`,
 * print each time zone the report takes on a line of its own and do
 * nothing else.
 *
 * @param {string[]} [argv]  Arguments after the node/script pair.
 * @param {{makeProvider?: Function, appDataDir?: string,
 *   spacingMs?: number, usdPriceOn?: Function, nowMs?: number,
 *   unlockMoralisKey?: Function}} [deps]  Tests pass a provider that
 *   answers without a network, their own `app-data/`, no spacing, a
 *   stand-in for the price oracles, the moment of the run, and a stand-in
 *   for opening the key.
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = readOptions(argv);
  if (opts.listValidTimezones === true) {
    console.log(validTimeZones().join("\n"));
    process.exitCode = 0;
    return;
  }
  const mismatch = blockchainMismatch(opts);
  if (mismatch !== null) {
    console.error(mismatch);
    process.exitCode = 1;
    return;
  }
  const notice = oneChainNotice(config.CHAIN_NAME);
  if (notice !== null) console.error(notice);
  const whole = wholeDays(
    opts,
    deps.nowMs === undefined ? Date.now() : deps.nowMs,
  );
  if (whole.refusal !== undefined) {
    console.error(whole.refusal);
    process.exitCode = 1;
    return;
  }
  if (whole.note !== null) console.log(whole.note);
  const endpoint = endpointOf(opts);
  const unlock =
    deps.unlockMoralisKey === undefined
      ? unlockMoralisKey
      : deps.unlockMoralisKey;
  /*-
   *  1 until the csv is written, so a run that ends any other way exits
   *  1: a prompt for the key's password left unanswered when stdin closes
   *  ends the process with nothing pending and no error.
   */
  process.exitCode = 1;
  let release = null;
  try {
    release = takePriceCacheLock(cachePath(PRICE_CACHE_LOCK_FILE));
    await unlock();
    await writeReport(whole.opts, endpoint, deps);
  } catch (error) {
    const text = failureText(error, endpoint);
    if (text === null) throw error;
    console.error(text);
    process.exitCode = 1;
  } finally {
    if (release !== null) release();
  }
}

/**
 * Find the transactions, price them, write the csv, and say where it is.
 * The csv is written only once every row is in, so a run stopped by a
 * failure leaves no part of one.
 *
 * @param {object} opts  The parsed options.
 * @param {string} endpoint  The endpoint to ask.
 * @param {object} deps  As `main` takes them.
 * @returns {Promise<void>}
 */
async function writeReport(opts, endpoint, deps) {
  const chain = config.CHAIN;
  const make =
    deps.makeProvider === undefined ? makeProvider : deps.makeProvider;
  const spacingMs = deps.spacingMs === undefined ? SPACING_MS : deps.spacingMs;
  const appDataDir =
    deps.appDataDir === undefined ? APP_DATA_DIR : deps.appDataDir;
  const provider = pacedProvider(make(endpoint, chain.chainId), spacingMs);
  const range = rangeIn(opts.startDate, opts.endDate, opts.timeZone);
  const who = {
    chain: config.CHAIN_NAME,
    cacheTag: chain.cacheTag,
    wallet: opts.wallet,
    positionManager: positionManagerOf(opts),
  };
  const records = recordsNear(appDataDir, who, range);
  console.log(
    `${records.moves.length} rebalances and compounds in app-data/ end ` +
      `near ${opts.startDate} to ${opts.endDate}; reading the chain at ` +
      `${endpoint}, and prices from Moralis, or CoinGecko where Moralis ` +
      "has none",
  );
  const ctx = {
    ...records,
    ...who,
    range,
    timeZone: opts.timeZone,
    blocksPerMonth: Math.round(MONTH_SEC / chain.blockTimeSec),
    claimed: new Set(),
    info: new Map(),
    nativeCoin: chain.nativeWrappedToken,
    usdPriceOn: deps.usdPriceOn === undefined ? usdPriceOn : deps.usdPriceOn,
  };
  const rows = [];
  const counts = { rebalance: 0, compound: 0, deposit: 0 };
  for (const move of records.moves) {
    const moveRows = await rowsOfMove(provider, move, ctx);
    if (moveRows === null) continue;
    counts[move.type] += 1;
    console.log(`${describe(move)}: ${moveRows.length} transactions`);
    rows.push(...moveRows);
  }
  rows.sort((a, b) => a.block - b.block || a.nonce - b.nonce);
  const file = reportPath(appDataDir, opts);
  const text = toCsv(
    columns(chain.nativeCurrencySymbol),
    rows.map((r) => r.cells),
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(
    `Wrote ${rows.length} transactions, from ${counts.rebalance} ` +
      `rebalances, ${counts.compound} compounds and ${counts.deposit} ` +
      `deposits, to ${file}`,
  );
  process.exitCode = 0;
}

/*-
 *  Gated so requiring this file from a test does not read app-data/ or
 *  the chain, the same arrangement every tool under util/ uses.
 */
if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  APP_DATA_DIR,
  buildProgram,
  missingTimeZone,
  readOptions,
  reportPath,
  wholeDays,
  describe,
  belongsTo,
  lastOf,
  drainBlockOf,
  firstBlockOf,
  poolOf,
  learnCoins,
  pricesOn,
  rowsOfMove,
  failureText,
  main,
  writeReport,
};
