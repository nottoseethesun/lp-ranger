"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/index.js
 * @description
 * Write a csv of every transaction of a wallet's rebalances and compounds
 * in a range of days, one row per transaction, with the coins it moved and
 * the gas it paid: the procedures of
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
 * csv.js makes it a row.
 *
 * The csv goes to `app-data/util/bookkeeping/`, named for the wallet, the
 * dates and the time zone, and the last line printed says where. It covers
 * the positions whose records this install holds: a position never
 * managed or viewed here has nothing in its files.
 *
 * The chain, endpoint and position manager are chosen as in
 * coins-in-transaction.js, whose option parsers it shares. It imports
 * nothing from `src/` but the dependency-free composite-key.js, so it is
 * safe to run while LP Ranger runs.
 *
 * Exit status is 0 when the csv was written, and 1 when it was not.
 *
 * Usage:
 *   node util/bookkeeping/coins-in-transactions-on-wallet --wallet <address>
 *        --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> --time-zone <zone>
 */

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");
const CHAINS = require("../../../app-config/app-defaults-for-user-configurable/chains.json");
const {
  DEFAULT_CHAIN,
  defaultEndpoint,
  parseChain,
  parseEndpoint,
} = require("../../diagnostic/check-rpc-health");
const {
  parseAddress,
  sameAddress,
  coinsInTransaction,
  makeProvider,
  positionManagerOf,
} = require("../coins-in-transaction");
const { parseDate, parseTimeZone, localTimeZone, rangeIn } = require("./dates");
const { recordsNear } = require("./moves");
const {
  SPACING_MS,
  pacedProvider,
  drainBlockBefore,
  collectBlockBefore,
  walletTransactionsIn,
  coinInfo,
  nftCoins,
} = require("./chain");
const { columns, rowOf, toCsv } = require("./csv");

/** The `app-data/` folder of the install this tool ships in. */
const APP_DATA_DIR = path.resolve(__dirname, "../../../app-data");

/** Seconds in the month a drain search covers when nothing bounds it. */
const MONTH_SEC = 30 * 24 * 60 * 60;

/**
 * Describe the command line, so Commander both parses it and renders
 * `--help` from the same declaration.
 *
 * `--time-zone` is required, but declared as an option so that its
 * absence can be refused with the computer's own zone offered
 * (`readOptions`).
 *
 * @returns {Command}  Configured, not yet parsed.
 */
function buildProgram() {
  return new Command()
    .name("coins-in-transactions-on-wallet")
    .description(
      "Write a csv of every transaction of a wallet's rebalances and " +
        "compounds in a range of days, one row per transaction, with the " +
        "coins it moved and the gas it paid. Starts from what app-data/ " +
        "records, then reads the chain; sends nothing.",
    )
    .requiredOption(
      "--wallet <address>",
      "the wallet whose transactions to list",
      parseAddress,
    )
    .requiredOption(
      "--start-date <YYYY-MM-DD>",
      "the range's first day",
      parseDate,
    )
    .requiredOption(
      "--end-date <YYYY-MM-DD>",
      "the range's last day, included",
      parseDate,
    )
    .option(
      "--time-zone <zone>",
      "the time zone the days are in, such as America/Chicago (required)",
      parseTimeZone,
    )
    .option(
      "--chain <name>",
      "an entry of chains.json",
      parseChain,
      DEFAULT_CHAIN,
    )
    .option(
      "--rpc-endpoint <url>",
      "the endpoint to ask (default: the chain's first in chains.json)",
      parseEndpoint,
    )
    .option(
      "--position-manager <address>",
      "the position manager whose positions to report (default: the " +
        "chain's, from chains.json)",
      parseAddress,
    )
    .addHelpText(
      "after",
      "\nThe csv is written to app-data/util/bookkeeping/.\nHow it finds " +
        "the transactions: docs/bookkeeping-for-coins-in-transactions.md\n\n" +
        "Exit status: 0 when the csv was written, 1 when it was not.",
    );
}

/**
 * Parse and check the arguments. A missing time zone is refused with the
 * computer's own zone offered, and a range that ends before it starts is
 * refused; Commander prints either refusal and exits 1.
 *
 * @param {string[]} argv  Arguments after the node/script pair.
 * @param {Command} [program]  The command; tests pass one that throws
 *   instead of exiting.
 * @returns {object}  The parsed options.
 */
function readOptions(argv, program = buildProgram()) {
  program.parse(argv, { from: "user" });
  const opts = program.opts();
  if (opts.timeZone === undefined) {
    const local = localTimeZone();
    program.error(
      "error: required option '--time-zone <zone>' not specified. This " +
        `computer's time zone is ${local}; to use it, pass ` +
        `--time-zone ${local}`,
    );
  }
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
 * Make sure the run knows both of a pool's coins' symbols and decimals:
 * from `app-data/` where it records them, else from the coin.
 * @param {object} provider  A paced provider.
 * @param {{token0: string, token1: string}} pool
 * @param {object} ctx  The run's context.
 * @returns {Promise<void>}
 */
async function learnCoins(provider, pool, ctx) {
  for (const coin of [pool.token0, pool.token1]) {
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
 * Every row of one move, or null when its last transaction falls outside
 * the range.
 *
 * @param {object} provider  A paced provider.
 * @param {object} move
 * @param {object} ctx  The run's context.
 * @returns {Promise<Array<{block: number, nonce: number, cells: string[]}>|null>}
 */
async function rowsOfMove(provider, move, ctx) {
  const last = await lastOf(provider, move);
  if (last === null) {
    console.log(`${describe(move)}: no receipt for ${move.lastHash}; skipped`);
    return null;
  }
  if (last.endMs < ctx.range.startMs || last.endMs >= ctx.range.endMs)
    return null;
  const first = await firstBlockOf(provider, move, last.blockNumber, ctx);
  const pool = await poolOf(provider, move, ctx);
  await learnCoins(provider, pool, ctx);
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
    if (record === null || !belongsTo(record, move, pool)) continue;
    ctx.claimed.add(tx.hash);
    const cells = rowOf({
      tx,
      record,
      move,
      pool,
      info: ctx.info,
      timeZone: ctx.timeZone,
    });
    rows.push({ block: tx.blockNumber, nonce: tx.nonce, cells });
  }
  return rows;
}

/**
 * Parse the arguments, find the transactions, write the csv, and say
 * where it is.
 *
 * @param {string[]} [argv]  Arguments after the node/script pair.
 * @param {{makeProvider?: Function, appDataDir?: string,
 *   spacingMs?: number}} [deps]  Tests pass a provider that answers
 *   without a network, their own `app-data/`, and no spacing.
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = readOptions(argv);
  const chain = CHAINS[opts.chain];
  const positionManager = positionManagerOf(opts, chain);
  if (positionManager === "") {
    console.error(
      `chains.json names no position manager for ${opts.chain}: ` +
        "pass --position-manager <address>",
    );
    process.exitCode = 1;
    return;
  }
  const endpoint =
    opts.rpcEndpoint === undefined
      ? defaultEndpoint(opts.chain)
      : opts.rpcEndpoint;
  const make =
    deps.makeProvider === undefined ? makeProvider : deps.makeProvider;
  const spacingMs = deps.spacingMs === undefined ? SPACING_MS : deps.spacingMs;
  const appDataDir =
    deps.appDataDir === undefined ? APP_DATA_DIR : deps.appDataDir;
  const provider = pacedProvider(make(endpoint, chain.chainId), spacingMs);
  const range = rangeIn(opts.startDate, opts.endDate, opts.timeZone);
  const who = {
    chain: opts.chain,
    cacheTag: chain.cacheTag,
    wallet: opts.wallet,
    positionManager,
  };
  const records = recordsNear(appDataDir, who, range);
  console.log(
    `${records.moves.length} rebalances and compounds in app-data/ end ` +
      `near ${opts.startDate} to ${opts.endDate}; reading the chain at ` +
      endpoint,
  );
  const ctx = {
    ...records,
    ...who,
    range,
    timeZone: opts.timeZone,
    blocksPerMonth: Math.round(MONTH_SEC / chain.blockTimeSec),
    claimed: new Set(),
    info: new Map(),
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
  readOptions,
  reportPath,
  describe,
  belongsTo,
  lastOf,
  drainBlockOf,
  firstBlockOf,
  poolOf,
  learnCoins,
  rowsOfMove,
  main,
};
