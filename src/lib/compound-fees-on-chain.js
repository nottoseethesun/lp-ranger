/**
 * @file src/lib/compound-fees-on-chain.js
 * @module compound-fees-on-chain
 * @description
 * The fees a compound's deposit put back, worked out from the chain, for a
 * compound whose record does not name them: one LP Ranger made before it
 * kept that record, or one made outside LP Ranger.
 *
 * A compound collects its NFT's fees, may swap part of one fee coin for
 * the other so the coins fit the range, and deposits them back into the
 * same NFT. When the swap runs, the deposit is offered the wallet's whole
 * balance of the pool's two coins, so it can take in coins that are not
 * fees: a deposit the owner sent, or coins a rebalance left in the wallet.
 * Only the fees count as Fees Compounded (src/lib/compounded-coins.js).
 * LP Ranger records them as it makes a compound, from the wallet's
 * readings. For any other compound the chain shows each step:
 *
 * - the collect: the `Collect` event just before the deposit, within one
 *   span of log blocks (`collectBeforeDeposit`, src/lib/nft-move-rules.js),
 *   is what it brought in;
 * - the swap: each transaction between the collect and the deposit that
 *   sent one of the pool's coins from the wallet and paid it the other,
 *   read from its receipt (`exchangeInTx`, src/lib/swap-exchange.js), is
 *   what it traded;
 * - the deposit: its `IncreaseLiquidity` event is what went in.
 *
 * The fee coins after the swap are what the collect brought in, less what
 * the swap sold of one coin, plus what it bought of the other. Of each
 * coin, the deposit put back its fees first, up to those fee coins, and
 * the rest of it came from the wallet's other coins; the fee coins it did
 * not put back stayed in the wallet. That is the rule LP Ranger applies to
 * its own compounds' readings (`compoundFeeUnits`), with the readings
 * taken to show nothing but the fee coins. A deposit with no collect
 * before it collected nothing, so all of it came from the wallet.
 *
 * A rebuild of the compound list asks `feesFromChain` for each compound
 * whose record names no fees (src/lib/compound-activity-figures.js), with
 * the chain reads bound for its position (`walletSwapsFor`,
 * src/lib/bot-recorder-lifetime.js), and keeps the answer on the
 * compound's entry, so each compound is read from the chain once. A scan
 * pass asks for that rebuild while the open NFT holds a compound whose
 * fees are not named yet (`namesNoFeesOn`, src/lib/compounded-coins.js).
 */

"use strict";

const { log } = require("./log");
const { isPlainObject } = require("./plain-object");
const {
  chainOrder,
  sameHex,
  collectBeforeDeposit,
} = require("./nft-move-rules");
const { compoundedFields } = require("./compounded-coins");
const { exchangeInTx } = require("./swap-exchange");
const { scanChunked } = require("./get-logs-chunked");
const sendTx = require("./send-transaction");
const ethers = require("ethers");

/**
 * A compound's deposit among its NFT's events, and the collect that began
 * it (null when nothing was collected for it). Null when the NFT's events
 * do not hold the deposit.
 *
 * @param {{txHash: string}} compound  The compound.
 * @param {object|undefined} nft  The NFT's events: `ilEvents`,
 *   `collectEvents`.
 * @param {number} span  The span of log blocks the collect is looked for
 *   in.
 * @returns {{own: object, collect: object|null}|null}
 */
function depositAndCollect(compound, nft, span) {
  if (!isPlainObject(nft)) return null;
  const own = (nft.ilEvents ?? []).find((e) =>
    sameHex(e.txHash, compound.txHash),
  );
  if (own === undefined) return null;
  const kinds = [
    ...(nft.collectEvents ?? []).map((e) => ({ ...e, kind: "collect" })),
    ...(nft.ilEvents ?? []).map((e) => ({ ...e, kind: "deposit" })),
  ].sort(chainOrder);
  return { own, collect: collectBeforeDeposit(kinds, own, span) };
}

/**
 * The fee coins after the swaps: what the collect brought in, less what
 * the swaps sold of one coin, plus what they bought of the other; none
 * below zero.
 *
 * @param {{raw0: bigint, raw1: bigint}} collected
 * @param {Array<{sold: 0|1, sent: bigint, received: bigint}>} swaps
 * @returns {{raw0: bigint, raw1: bigint}}
 */
function feeCoinsAfterSwaps(collected, swaps) {
  const coins = [BigInt(collected.raw0), BigInt(collected.raw1)];
  for (const s of swaps) {
    coins[s.sold] -= s.sent;
    coins[1 - s.sold] += s.received;
  }
  return {
    raw0: coins[0] > 0n ? coins[0] : 0n,
    raw1: coins[1] > 0n ? coins[1] : 0n,
  };
}

/**
 * The fee fields a compound's record keeps, from its deposit and its fee
 * coins after the swap: the fees it put back (`amount0Compounded`,
 * `amount1Compounded`) and those it left in the wallet
 * (`amount0FeesLeft`, `amount1FeesLeft`), in each coin's smallest unit.
 *
 * @param {{amount0Deposited: bigint|string, amount1Deposited: bigint|string}}
 *   deposited  What the deposit took.
 * @param {{raw0: bigint, raw1: bigint}} feeCoins  From `feeCoinsAfterSwaps`.
 * @returns {object}  Empty when an amount is not one.
 */
function feeFieldsOf(deposited, feeCoins) {
  /*- The wallet's readings taken to show nothing but the fee coins, so
   *  the deposit counts fees first, up to them (`compoundFeeUnits`). */
  const f = compoundedFields(
    { raw0: 0n, raw1: 0n },
    feeCoins,
    deposited,
    0,
    0,
    feeCoins,
  );
  if (f.amount0Compounded === undefined) return {};
  return {
    amount0Compounded: f.amount0Compounded,
    amount1Compounded: f.amount1Compounded,
    amount0FeesLeft: f.amount0FeesLeft,
    amount1FeesLeft: f.amount1FeesLeft,
  };
}

/** One transaction's swap of the pool's two coins, or null when it is none. */
function _swapIn(receipt, o) {
  const coins = [o.token0, o.token1];
  for (const sold of [0, 1]) {
    const ex = exchangeInTx(receipt, coins[sold], coins[1 - sold], o.wallet);
    if (ex !== null && ex.sent > 0n && ex.received > 0n)
      return { sold, sent: ex.sent, received: ex.received };
  }
  return null;
}

/**
 * The wallet's swaps of a pool's two coins in a range of blocks, but for
 * the transactions named: each transaction that sent one of the coins
 * from the wallet and paid it the other, with what it traded. Null when a
 * read fails, since a swap missed would count the coins it bought as the
 * wallet's other coins.
 *
 * @param {object} o
 * @param {object} o.provider  ethers provider with `getLogs` and
 *   `getTransactionReceipt`.
 * @param {object} o.ethersLib  ethers, for `id` and `zeroPadValue`.
 * @param {string} o.wallet  The wallet.
 * @param {string} o.token0  The pool's first coin.
 * @param {string} o.token1  The pool's second coin.
 * @param {number} o.fromBlock  First block read: the collect's.
 * @param {number} o.toBlock  Last block read: the deposit's.
 * @param {string[]} o.skip  Transactions left out: the collect and the
 *   deposit.
 * @returns {Promise<Array<{sold: 0|1, sent: bigint, received: bigint}>|null>}
 */
async function walletSwapsBetween(o) {
  try {
    const padded = o.ethersLib.zeroPadValue(o.wallet, 32);
    const topic0 = o.ethersLib.id("Transfer(address,address,uint256)");
    const sent = [];
    for (const coin of [o.token0, o.token1])
      sent.push(
        ...(await scanChunked({
          provider: o.provider,
          fromBlock: o.fromBlock,
          toBlock: o.toBlock,
          label: `compound swap, transfers-out for Token i.d. ${coin}`,
          query: (from, to) =>
            o.provider.getLogs({
              address: coin,
              fromBlock: from,
              toBlock: to,
              topics: [topic0, padded, null],
            }),
        })),
      );
    const skip = new Set(o.skip.map((h) => String(h).toLowerCase()));
    const txs = [
      ...new Set(sent.map((l) => String(l.transactionHash).toLowerCase())),
    ].filter((h) => !skip.has(h));
    const swaps = [];
    for (const tx of txs) {
      const receipt = await o.provider.getTransactionReceipt(tx);
      if (receipt === null) throw new Error(`no receipt for ${tx}`);
      const swap = _swapIn(receipt, o);
      if (swap !== null) swaps.push(swap);
    }
    return swaps;
  } catch (err) {
    log.warn(
      "[bot] a compound's swap between blocks %d and %d could not be read, so its fees stay unknown: %s",
      o.fromBlock,
      o.toBlock,
      err.message,
    );
    return null;
  }
}

/**
 * `walletSwapsBetween` for one position's wallet and coins, read through
 * the app's managed read provider, which follows the endpoint failover
 * (src/lib/send-transaction.js): what a rebuild of the compound list hands
 * `feesFromChain` as `walletSwaps` (src/lib/bot-recorder-lifetime.js).
 *
 * @param {{token0: string, token1: string}} position  Its two coins.
 * @param {string} walletAddress  The wallet.
 * @returns {(range: {fromBlock: number, toBlock: number, skip: string[]})
 *   => Promise<Array<object>|null>}
 */
function walletSwapsFor(position, walletAddress) {
  return (range) =>
    walletSwapsBetween({
      provider: sendTx.getManagedReadProvider(),
      ethersLib: ethers,
      wallet: walletAddress,
      token0: position.token0,
      token1: position.token1,
      ...range,
    });
}

/**
 * The swaps between a compound's collect and its deposit, or null when
 * they cannot be read: a reader that fails leaves the compound's fees
 * unknown rather than failing the rebuild.
 *
 * @param {{own: object, collect: object}} found  From `depositAndCollect`.
 * @param {Function} walletSwaps  The bound `walletSwapsBetween`.
 * @returns {Promise<Array<object>|null>}
 */
async function _swapsOf(found, walletSwaps) {
  try {
    return await walletSwaps({
      fromBlock: found.collect.blockNumber,
      toBlock: found.own.blockNumber,
      skip: [found.collect.txHash, found.own.txHash],
    });
  } catch (err) {
    log.warn(
      "[bot] a compound's swap could not be read, so its fees stay unknown: %s",
      err.message,
    );
    return null;
  }
}

/**
 * The fee fields a compound's record lacks, from the chain. Empty when
 * they cannot be worked out, so the compound counts its whole deposit as
 * before, until a later rebuild reads them.
 *
 * @param {{txHash: string}} compound  As the rebuild found it.
 * @param {object|undefined} nft  The NFT's events.
 * @param {object} opts
 * @param {number} opts.span  The span of log blocks the collect is
 *   looked for in.
 * @param {Function} [opts.walletSwaps]  `(range) => swaps`:
 *   `walletSwapsBetween` with the chain reads bound, given `fromBlock`,
 *   `toBlock` and `skip`.
 * @returns {Promise<object>}  From `feeFieldsOf`.
 */
async function feesFromChain(compound, nft, opts) {
  const found = depositAndCollect(compound, nft, opts.span);
  if (found === null) return {};
  const deposited = {
    amount0Deposited: found.own.amount0,
    amount1Deposited: found.own.amount1,
  };
  if (found.collect === null)
    return feeFieldsOf(deposited, { raw0: 0n, raw1: 0n });
  if (typeof opts.walletSwaps !== "function") return {};
  const swaps = await _swapsOf(found, opts.walletSwaps);
  if (swaps === null) return {};
  const collected = {
    raw0: BigInt(found.collect.amount0),
    raw1: BigInt(found.collect.amount1),
  };
  return feeFieldsOf(deposited, feeCoinsAfterSwaps(collected, swaps));
}

module.exports = {
  depositAndCollect,
  feeCoinsAfterSwaps,
  feeFieldsOf,
  walletSwapsBetween,
  walletSwapsFor,
  feesFromChain,
};
