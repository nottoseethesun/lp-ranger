"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/chain.js
 * @description
 * The chain reads a wallet's bookkeeping report makes, few and spaced
 * out. Every request waits its turn, one every
 * `globalRPCRequestRateIntervalMS`, the pace LP Ranger keeps its own
 * requests to, so a report run while the app runs does not crowd the
 * endpoints they share. That figure and the span of a log search,
 * `getLogsChunkSize`, come from the app's resolver for
 * bot-config-defaults.json (src/lib/bot-config-defaults.js), so an operator's
 * own value applies here as in the app. A receipt or a block is read
 * once, however often it is asked for.
 *
 * The report asks one endpoint and moves to no other. A request the
 * endpoint fails is marked `rpcFailure`, so the report can say what failed
 * and suggest another endpoint; a call the chain refuses, such as a coin
 * with no `symbol()`, is an answer, not a failure, and is not marked.
 *
 * Three searches find what `app-data/` does not name, as the section on
 * finding them in
 * docs/util/bookkeeping-for-coins-in-transactions/engineering.md describes:
 *
 * - searching by NFT, for the latest of the position manager's events
 *   naming an NFT before a block: a rebalance's drain, a compound's
 *   collect;
 * - searching by wallet, for every transaction the wallet sent between
 *   two blocks, those that moved no coins included: an approval, a cancel,
 *   a reverted try;
 * - each coin's symbol and decimals, and each NFT's two coins, when the
 *   files do not hold them.
 */

const { ethers } = require("ethers");
require("../blockchain");
const { sleep } = require("../../diagnostic/_helpers");
const { EVENTS, sameAddress } = require("../coins-in-transaction");
const {
  readBotConfigDefaults,
} = require("../../../src/lib/bot-config-defaults");
const {
  drainBefore,
  collectBeforeDeposit,
} = require("../../../src/lib/nft-move-rules");

/** bot-config-defaults.json as LP Ranger resolves it, overrides applied. */
const BOT_DEFAULTS = readBotConfigDefaults();

/** The widest span of blocks one log search asks for, as LP Ranger's own do. */
const SPAN = BOT_DEFAULTS.getLogsChunkSize;

/** How long each request waits after the one before it, in milliseconds. */
const SPACING_MS = BOT_DEFAULTS.globalRPCRequestRateIntervalMS;

/** The calls a report makes of a coin and of the position manager. */
const CALLS = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

/**
 * What a provider threw, marked as the endpoint's failure. A call the chain
 * refused (ethers' CALL_EXCEPTION) is the chain's answer, not a failure of
 * the endpoint, and is passed on unmarked.
 * @param {*} thrown  What the provider threw.
 * @returns {Error}
 */
function markRpcFailure(thrown) {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  if (error.code !== "CALL_EXCEPTION") error.rpcFailure = true;
  return error;
}

/**
 * Wrap a provider so each request waits its turn and each receipt and
 * block is read once, and a request the endpoint fails is marked
 * `rpcFailure`.
 *
 * @param {object} provider  An ethers provider, or a stand-in.
 * @param {number} spacingMs  The least time between two requests.
 * @returns {{getTransactionReceipt: Function, getBlock: Function,
 *   getTransactionCount: Function, getLogs: Function, call: Function}}
 */
function pacedProvider(provider, spacingMs) {
  let nextAt = 0;
  const receipts = new Map();
  const blocks = new Map();
  /**
   * Wait for this request's turn, then book the next one's from the
   * moment this one goes out. Booked from when this one was due instead,
   * a timer that fired late would let the next request follow it sooner
   * than `spacingMs`.
   */
  async function turn() {
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAt = Date.now() + spacingMs;
  }
  /** Ask the provider, in turn, marking a failure as the endpoint's. */
  async function ask(name, args) {
    await turn();
    try {
      return await provider[name](...args);
    } catch (thrown) {
      throw markRpcFailure(thrown);
    }
  }
  return {
    async getTransactionReceipt(hash) {
      if (!receipts.has(hash))
        receipts.set(hash, await ask("getTransactionReceipt", [hash]));
      return receipts.get(hash);
    },
    async getBlock(number) {
      if (!blocks.has(number))
        blocks.set(number, await ask("getBlock", [number, true]));
      return blocks.get(number);
    },
    getTransactionCount: (address, block) =>
      ask("getTransactionCount", [address, block]),
    getLogs: (filter) => ask("getLogs", [filter]),
    call: (transaction) => ask("call", [transaction]),
  };
}

/**
 * An NFT id as a log topic: a 32-byte number.
 * @param {string} nftId
 * @returns {string}
 */
function nftTopic(nftId) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(nftId)), 32);
}

/**
 * The position manager's logs of some events naming an NFT, searched one
 * span at a time from a block back to a floor, newest span first; the
 * search stops at the first span that holds any.
 *
 * @param {object} provider  A paced provider.
 * @param {{positionManager: string, events: string[], nftId: string,
 *   toBlock: number, floorBlock: number}} search
 * @returns {Promise<object[]>}  That span's logs, oldest first, or none.
 */
async function nftLogsBefore(provider, search) {
  const { positionManager, events, nftId, toBlock, floorBlock } = search;
  const topics = [
    events.map((name) => EVENTS.getEvent(name).topicHash),
    nftTopic(nftId),
  ];
  for (let hi = toBlock; hi >= floorBlock; hi -= SPAN) {
    const lo = Math.max(floorBlock, hi - SPAN + 1);
    const filter = {
      address: positionManager,
      topics,
      fromBlock: lo,
      toBlock: hi,
    };
    const logs = await provider.getLogs(filter);
    if (logs.length > 0) return logs;
  }
  return [];
}

/**
 * A log as the shared move rules (src/lib/nft-move-rules.js) read an event:
 * its block, its transaction, and its place in the block when the
 * endpoint gave one.
 * @param {object} log  A log as the provider returns it.
 * @returns {{blockNumber: number, txHash: string, logIndex?: number}}
 */
function asMoveEvent(log) {
  const event = { blockNumber: log.blockNumber, txHash: log.transactionHash };
  if (typeof log.index === "number") event.logIndex = log.index;
  return event;
}

/**
 * The block of a rebalance's drain, by the rule in src/lib/nft-move-rules.js
 * (`drainBefore`): the latest `DecreaseLiquidity` of the replaced NFT at
 * or before the mint. Searched back to the block that NFT was minted in
 * when the event cache knows it, else across the spans a month of blocks
 * fills.
 *
 * @param {object} provider  A paced provider.
 * @param {{positionManager: string, nftId: string, mintBlock: number,
 *   floorBlock: number|null, blocksPerMonth: number}} search
 * @returns {Promise<number|null>}  The drain's block, or null when none.
 */
async function drainBlockBefore(provider, search) {
  const { mintBlock, floorBlock, blocksPerMonth } = search;
  const floor =
    floorBlock === null ? Math.max(0, mintBlock - blocksPerMonth) : floorBlock;
  const logs = await nftLogsBefore(provider, {
    positionManager: search.positionManager,
    events: ["DecreaseLiquidity"],
    nftId: search.nftId,
    toBlock: mintBlock,
    floorBlock: floor,
  });
  const decreases = logs.map(asMoveEvent);
  const drain = drainBefore(decreases, mintBlock);
  return drain === null ? null : drain.blockNumber;
}

/**
 * The block of a compound's collect, by the rule in src/lib/nft-move-rules.js
 * (`collectBeforeDeposit`): the latest `Collect` of the NFT within one
 * span of blocks before its deposit, provided no other deposit into the
 * NFT came after it. Without one, the deposit was coins the owner added
 * rather than a compound.
 *
 * @param {object} provider  A paced provider.
 * @param {{positionManager: string, nftId: string, depositHash: string,
 *   depositBlock: number}} search
 * @returns {Promise<number|null>}  The collect's block, or null.
 */
async function collectBlockBefore(provider, search) {
  const logs = await nftLogsBefore(provider, {
    positionManager: search.positionManager,
    events: ["Collect", "IncreaseLiquidity"],
    nftId: search.nftId,
    toBlock: search.depositBlock,
    floorBlock: Math.max(0, search.depositBlock - SPAN + 1),
  });
  const collectTopic = EVENTS.getEvent("Collect").topicHash;
  const events = logs.map((log) => ({
    ...asMoveEvent(log),
    kind: log.topics[0] === collectTopic ? "collect" : "deposit",
  }));
  const collect = collectBeforeDeposit(
    events,
    { blockNumber: search.depositBlock, txHash: search.depositHash },
    SPAN,
  );
  return collect === null ? null : collect.blockNumber;
}

/**
 * Every transaction the wallet sent in a span of blocks, in the order
 * sent. The wallet's count of transactions at the end of a block says how
 * many it had sent by then, so a span whose two ends show the same count
 * holds none of them. The search halves each span that holds some, until
 * it reaches single blocks, and reads those blocks whole.
 *
 * @param {object} provider  A paced provider.
 * @param {string} wallet    The wallet's address.
 * @param {number} fromBlock The span's first block.
 * @param {number} toBlock   The span's last block.
 * @returns {Promise<Array<{hash: string, blockNumber: number,
 *   timestamp: number, nonce: number, value: bigint}>>}
 */
async function walletTransactionsIn(provider, wallet, fromBlock, toBlock) {
  const before = await provider.getTransactionCount(wallet, fromBlock - 1);
  const after = await provider.getTransactionCount(wallet, toBlock);
  return halves(provider, wallet, {
    lo: fromBlock,
    hi: toBlock,
    before,
    after,
  });
}

/**
 * One step of the search above: the wallet's transactions in blocks `lo`
 * to `hi`, given its counts at the end of block `lo - 1` and of `hi`.
 * @param {object} provider  A paced provider.
 * @param {string} wallet    The wallet's address.
 * @param {{lo: number, hi: number, before: number, after: number}} span
 * @returns {Promise<object[]>}
 */
async function halves(provider, wallet, { lo, hi, before, after }) {
  if (after === before) return [];
  if (lo === hi) {
    const block = await provider.getBlock(lo);
    return block.prefetchedTransactions
      .filter((tx) => sameAddress(tx.from, wallet))
      .map((tx) => ({
        hash: tx.hash,
        blockNumber: lo,
        timestamp: block.timestamp,
        nonce: tx.nonce,
        value: tx.value,
      }));
  }
  const mid = Math.floor((lo + hi) / 2);
  const atMid = await provider.getTransactionCount(wallet, mid);
  const left = await halves(provider, wallet, {
    lo,
    hi: mid,
    before,
    after: atMid,
  });
  const right = await halves(provider, wallet, {
    lo: mid + 1,
    hi,
    before: atMid,
    after,
  });
  return [...left, ...right];
}

/**
 * Ask a contract one of the calls above.
 * @param {object} provider  A paced provider.
 * @param {string} to        The contract.
 * @param {string} name      The call's name in `CALLS`.
 * @param {Array} [args]     Its arguments.
 * @returns {Promise<ethers.Result>}
 */
async function ask(provider, to, name, args = []) {
  const data = CALLS.encodeFunctionData(name, args);
  const answer = await provider.call({ to, data });
  return CALLS.decodeFunctionResult(name, answer);
}

/**
 * A coin's symbol and decimals, asked of the coin. A coin whose symbol is
 * not a string is named by its address. The decimals stay the bigint the
 * call returns, which `ethers.formatUnits` takes as it is.
 * @param {object} provider  A paced provider.
 * @param {string} coin      The coin's address.
 * @returns {Promise<{symbol: string, decimals: bigint}>}
 */
async function coinInfo(provider, coin) {
  const [decimals] = await ask(provider, coin, "decimals");
  let symbol;
  try {
    [symbol] = await ask(provider, coin, "symbol");
  } catch (error) {
    if (error.rpcFailure === true) throw error;
    symbol = coin;
  }
  return { symbol, decimals };
}

/**
 * An NFT's two coins, asked of the position manager.
 * @param {object} provider  A paced provider.
 * @param {string} positionManager  Its address.
 * @param {string} nftId
 * @returns {Promise<{token0: string, token1: string}>}
 */
async function nftCoins(provider, positionManager, nftId) {
  const position = await ask(provider, positionManager, "positions", [nftId]);
  return { token0: position.token0, token1: position.token1 };
}

module.exports = {
  SPAN,
  SPACING_MS,
  markRpcFailure,
  pacedProvider,
  nftLogsBefore,
  drainBlockBefore,
  collectBlockBefore,
  walletTransactionsIn,
  coinInfo,
  nftCoins,
};
