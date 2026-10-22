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
 * The report's column names. Each amount of a coin is followed by its
 * value in USD, at the coin's price on the transaction's day, and each of
 * the pool's coins carries that price. The gas and value columns carry
 * the chain's own coin in their names, PLS on PulseChain.
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
    "token0_usd_price",
    "token1",
    "token1_address",
    "token1_usd_price",
    "token0_out",
    "token0_out_usd",
    "token0_in",
    "token0_in_usd",
    "token1_out",
    "token1_out_usd",
    "token1_in",
    "token1_in_usd",
    "token0_principal",
    "token0_principal_usd",
    "token1_principal",
    "token1_principal_usd",
    "token0_fees",
    "token0_fees_usd",
    "token1_fees",
    "token1_fees_usd",
    `gas_paid_${nativeSymbol}`,
    `${nativeSymbol}_usd_price`,
    "gas_paid_usd",
    `value_sent_${nativeSymbol}`,
    "value_sent_usd",
    "other_coins",
  ];
}

/**
 * A USD price as text, in plain decimals with no exponent, to twelve
 * significant digits; empty for a coin the row does not price.
 * @param {number|undefined} price
 * @returns {string}
 */
function priceText(price) {
  if (price === undefined) return "";
  return price.toLocaleString("en-US", {
    useGrouping: false,
    maximumSignificantDigits: 12,
  });
}

/**
 * The USD value of a raw amount of a coin, as text with two to six
 * decimals.
 * @param {bigint} raw  The raw amount.
 * @param {number|bigint} decimals  The coin's decimals.
 * @param {number} price  The coin's USD price.
 * @returns {string}
 */
function usdValue(raw, decimals, price) {
  const value = Number(ethers.formatUnits(raw, decimals)) * price;
  return value.toLocaleString("en-US", {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

/**
 * A USD value as `usdValue` writes it, or an empty cell for no amount, as
 * `coins` leaves one.
 * @param {bigint} raw  The raw amount.
 * @param {number|bigint} decimals  The coin's decimals.
 * @param {number|undefined} price  The coin's USD price.
 * @returns {string}
 */
function usd(raw, decimals, price) {
  return raw === 0n ? "" : usdValue(raw, decimals, price);
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
 * Whether a coin is one of the pool's two.
 * @param {string} coin  The coin's address.
 * @param {{token0: string, token1: string}} pool  The pool's coins.
 * @returns {boolean}
 */
function inPool(coin, pool) {
  return sameAddress(coin, pool.token0) || sameAddress(coin, pool.token1);
}

/**
 * The coins a row shows an amount of, and so needs a USD price for: each
 * of the pool's coins the row moves, takes out or collects fees in, and
 * every other coin the wallet sent or took in. The chain's own coin, for
 * the gas, is the caller's to price.
 * @param {object} record  The transaction's record.
 * @param {{token0: string, token1: string}} pool  The pool's coins.
 * @param {string[]} nfts  The move's NFT ids.
 * @returns {string[]}  The coins' addresses, each once.
 */
function coinsToPrice(record, pool, nfts) {
  const out = takenOut(record, nfts);
  const shows = (coin, principal, fees) =>
    principal !== 0n ||
    fees !== 0n ||
    moved(record, coin, "out") !== 0n ||
    moved(record, coin, "in") !== 0n;
  const wanted = [];
  if (shows(pool.token0, out.principal0, out.fees0)) wanted.push(pool.token0);
  if (shows(pool.token1, out.principal1, out.fees1)) wanted.push(pool.token1);
  for (const t of record.transfers) {
    if (inPool(t.coin, pool)) continue;
    if (!wanted.some((c) => sameAddress(c, t.coin))) wanted.push(t.coin);
  }
  return wanted;
}

/**
 * The wallet's transfers of coins that are not the pool's, as text: each
 * amount in whole coins, the coin's symbol and address, and its USD value.
 * @param {object} record  The transaction's record.
 * @param {{token0: string, token1: string}} pool  The pool's coins.
 * @param {Map<string, {symbol: string, decimals: number|bigint}>} info
 *   Each coin's symbol and decimals, keyed by lower-cased address.
 * @param {Map<string, number>} prices  Each coin's USD price, keyed the
 *   same way.
 * @returns {string}  Such as "out 5.0 AAA of 0x… ($1.25)", or empty.
 */
function otherCoins(record, pool, info, prices) {
  return record.transfers
    .filter((t) => !inPool(t.coin, pool))
    .map((t) => {
      const key = t.coin.toLowerCase();
      const { symbol, decimals } = info.get(key);
      const raw = BigInt(t.amount);
      const value = usdValue(raw, decimals, prices.get(key));
      return (
        `${t.direction} ${ethers.formatUnits(raw, decimals)} ${symbol} ` +
        `of ${t.coin} ($${value})`
      );
    })
    .join("; ");
}

/**
 * One transaction's row.
 *
 * @param {{tx: {blockNumber: number, timestamp: number, value: bigint},
 *   record: object, move: {type: string, nfts: string[]},
 *   pool: {token0: string, token1: string},
 *   info: Map<string, {symbol: string, decimals: number|bigint}>,
 *   timeZone: string, prices: Map<string, number>,
 *   nativePrice: number}} parts
 *   The transaction as the chain listed it, its record from
 *   coins-in-transaction, its move, the pool's coins, each coin's symbol
 *   and decimals keyed by lower-cased address, the report's zone, the USD
 *   price of each coin `coinsToPrice` names, keyed the same way, and the
 *   chain's own coin's USD price, for the gas and any value sent.
 * @returns {string[]}  The cells, in the order `columns` names them.
 */
function rowOf({
  tx,
  record,
  move,
  pool,
  info,
  timeZone,
  prices,
  nativePrice,
}) {
  const key0 = pool.token0.toLowerCase();
  const key1 = pool.token1.toLowerCase();
  const c0 = info.get(key0);
  const c1 = info.get(key1);
  const p0 = prices.get(key0);
  const p1 = prices.get(key1);
  const ms = tx.timestamp * 1000;
  const out = takenOut(record, move.nfts);
  const amount0 = (raw) => [coins(raw, c0.decimals), usd(raw, c0.decimals, p0)];
  const amount1 = (raw) => [coins(raw, c1.decimals), usd(raw, c1.decimals, p1)];
  const gas = BigInt(record.gasPaid);
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
    priceText(p0),
    c1.symbol,
    pool.token1,
    priceText(p1),
    ...amount0(moved(record, pool.token0, "out")),
    ...amount0(moved(record, pool.token0, "in")),
    ...amount1(moved(record, pool.token1, "out")),
    ...amount1(moved(record, pool.token1, "in")),
    ...amount0(out.principal0),
    ...amount1(out.principal1),
    ...amount0(out.fees0),
    ...amount1(out.fees1),
    ethers.formatEther(gas),
    priceText(nativePrice),
    usd(gas, 18, nativePrice),
    tx.value === 0n ? "" : ethers.formatEther(tx.value),
    usd(tx.value, 18, nativePrice),
    otherCoins(record, pool, info, prices),
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
  priceText,
  usdValue,
  usd,
  coins,
  moved,
  takenOut,
  inPool,
  coinsToPrice,
  otherCoins,
  rowOf,
  csvCell,
  toCsv,
};
