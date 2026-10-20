"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/csv.js
 * @description
 * The rows of a wallet's bookkeeping report, one per transaction, and the
 * csv they are written as. A row holds the transaction's date in the
 * report's time zone and in UTC, its block and hash, the move it belongs
 * to, its kind, the pool's two coins, the amount of each that left and
 * entered the wallet, a drain's principal and fees or a collect's fees,
 * the gas paid and any PLS sent as the transaction's value. Coin amounts
 * are in coins, divided by each coin's decimals exactly, as strings; an
 * empty cell means nothing moved.
 */

const { ethers } = require("ethers");
const { sameAddress } = require("../coins-in-transaction");
const { formatIn } = require("./dates");

/**
 * The report's column names. The gas and value columns carry the chain's
 * own coin in their names, PLS on PulseChain.
 * @param {string} nativeSymbol  The chain's own coin.
 * @returns {string[]}
 */
function columns(nativeSymbol) {
  return [
    "date",
    "date_utc",
    "block",
    "transaction",
    "move",
    "nfts",
    "kind",
    "status",
    "token0",
    "token0_address",
    "token1",
    "token1_address",
    "token0_out",
    "token0_in",
    "token1_out",
    "token1_in",
    "token0_principal",
    "token1_principal",
    "token0_fees",
    "token1_fees",
    `gas_paid_${nativeSymbol}`,
    `value_sent_${nativeSymbol}`,
    "other_coins",
  ];
}

/**
 * Coins as a decimal string, or an empty cell for none.
 * @param {bigint} raw  The raw amount.
 * @param {number|bigint} decimals  The coin's decimals.
 * @returns {string}
 */
function coins(raw, decimals) {
  return raw === 0n ? "" : ethers.formatUnits(raw, decimals);
}

/**
 * The raw amount of one coin a transaction moved one way, summed over its
 * transfers.
 * @param {object} record  The transaction's record.
 * @param {string} coin  The coin's address.
 * @param {string} direction  "out" or "in".
 * @returns {bigint}
 */
function moved(record, coin, direction) {
  let sum = 0n;
  for (const t of record.transfers) {
    if (t.direction === direction && sameAddress(t.coin, coin))
      sum += BigInt(t.amount);
  }
  return sum;
}

/**
 * The principal and fees a transaction took out of the move's NFTs. A
 * drain's fees are its `Collect` less its `DecreaseLiquidity`; a collect
 * has no principal, and the whole of its `Collect` is fees.
 * @param {object} record  The transaction's record.
 * @param {string[]} nfts  The move's NFT ids.
 * @returns {{principal0: bigint, principal1: bigint, fees0: bigint,
 *   fees1: bigint}}
 */
function takenOut(record, nfts) {
  const out = { principal0: 0n, principal1: 0n, fees0: 0n, fees1: 0n };
  const ours = (e) => nfts.includes(e.nftId);
  for (const e of record.liquidity.filter(ours)) {
    if (e.event === "DecreaseLiquidity") {
      out.principal0 += BigInt(e.amount0);
      out.principal1 += BigInt(e.amount1);
    }
    if (e.event === "Collect" && record.kind === "collect") {
      out.fees0 += BigInt(e.amount0);
      out.fees1 += BigInt(e.amount1);
    }
  }
  for (const f of record.fees.filter(ours)) {
    out.fees0 += BigInt(f.amount0);
    out.fees1 += BigInt(f.amount1);
  }
  return out;
}

/**
 * The wallet's transfers of coins that are not the pool's, raw, as text.
 * @param {object} record  The transaction's record.
 * @param {{token0: string, token1: string}} pool  The pool's coins.
 * @returns {string}  Such as "out 5 of 0x…; in 7 of 0x…", or empty.
 */
function otherCoins(record, pool) {
  return record.transfers
    .filter(
      (t) =>
        !sameAddress(t.coin, pool.token0) && !sameAddress(t.coin, pool.token1),
    )
    .map((t) => `${t.direction} ${t.amount} of ${t.coin}`)
    .join("; ");
}

/**
 * One transaction's row.
 *
 * @param {{tx: {blockNumber: number, timestamp: number, value: bigint},
 *   record: object, move: {type: string, nfts: string[]},
 *   pool: {token0: string, token1: string},
 *   info: Map<string, {symbol: string, decimals: number|bigint}>,
 *   timeZone: string}} parts
 *   The transaction as the chain listed it, its record from
 *   coins-in-transaction, its move, the pool's coins, each coin's symbol
 *   and decimals keyed by lower-cased address, and the report's zone.
 * @returns {string[]}  The cells, in the order `columns` names them.
 */
function rowOf({ tx, record, move, pool, info, timeZone }) {
  const c0 = info.get(pool.token0.toLowerCase());
  const c1 = info.get(pool.token1.toLowerCase());
  const ms = tx.timestamp * 1000;
  const out = takenOut(record, move.nfts);
  return [
    formatIn(ms, timeZone),
    new Date(ms).toISOString().replace(".000Z", "Z"),
    String(tx.blockNumber),
    record.hash,
    move.type,
    move.nfts.join(" to "),
    record.kind,
    record.status,
    c0.symbol,
    pool.token0,
    c1.symbol,
    pool.token1,
    coins(moved(record, pool.token0, "out"), c0.decimals),
    coins(moved(record, pool.token0, "in"), c0.decimals),
    coins(moved(record, pool.token1, "out"), c1.decimals),
    coins(moved(record, pool.token1, "in"), c1.decimals),
    coins(out.principal0, c0.decimals),
    coins(out.principal1, c1.decimals),
    coins(out.fees0, c0.decimals),
    coins(out.fees1, c1.decimals),
    ethers.formatEther(record.gasPaid),
    tx.value === 0n ? "" : ethers.formatEther(tx.value),
    otherCoins(record, pool),
  ];
}

/**
 * One csv cell: quoted when it holds a comma, a quote or a line break,
 * with any quote doubled.
 * @param {string} cell
 * @returns {string}
 */
function csvCell(cell) {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * A whole csv file: the column names, then one line per row.
 * @param {string[]} names  The column names.
 * @param {string[][]} rows  The rows' cells.
 * @returns {string}  The file's text, ending in a line break.
 */
function toCsv(names, rows) {
  const lines = [names, ...rows].map((cells) => cells.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

module.exports = {
  columns,
  coins,
  moved,
  takenOut,
  otherCoins,
  rowOf,
  csvCell,
  toCsv,
};
