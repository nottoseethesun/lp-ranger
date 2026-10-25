"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet-chain.test.js
 * @description
 * Tests for the chain reads of the wallet bookkeeping report
 * (`util/bookkeeping/coins-in-transactions-on-wallet/chain.js`): the
 * pacing and caching wrapper, the search by NFT, the search by wallet, and
 * the calls for a coin's symbol and decimals and an NFT's coins. Each runs
 * against a stand-in provider that models a chain's answers, so no test
 * reaches the network.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

const { EVENTS } = require("../bookkeeping/coins-in-transaction");
const {
  SPAN,
  markRpcFailure,
  pacedProvider,
  nftLogsBefore,
  drainBlockBefore,
  collectBlockBefore,
  walletTransactionsIn,
  coinInfo,
  nftCoins,
} = require("../bookkeeping/coins-in-transactions-on-wallet/chain");

const PM = "0x2222222222222222222222222222222222222222";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x5555555555555555555555555555555555555555";
const COIN = "0x3333333333333333333333333333333333333333";
const hash = (n) => "0x" + String(n).padStart(64, "0");
const topicOf = (name) => EVENTS.getEvent(name).topicHash;

/* ---------- pacing and caching ---------- */

test("pacedProvider spaces requests and reads each receipt and block once", async () => {
  const asked = [];
  const inner = {
    async getTransactionReceipt(h) {
      asked.push(["receipt", h, Date.now()]);
      return { hash: h };
    },
    async getBlock(n, prefetch) {
      asked.push(["block", n, Date.now(), prefetch]);
      return { number: n };
    },
    async getTransactionCount(address, block) {
      asked.push(["count", block, Date.now()]);
      return 7;
    },
    async getLogs(filter) {
      asked.push(["logs", filter, Date.now()]);
      return [];
    },
    async call(tx) {
      asked.push(["call", tx, Date.now()]);
      return "0x";
    },
  };
  const paced = pacedProvider(inner, 25);
  await paced.getTransactionReceipt(hash(1));
  await paced.getTransactionReceipt(hash(1));
  await paced.getBlock(5);
  await paced.getBlock(5);
  assert.equal(await paced.getTransactionCount(WALLET, 9), 7);
  await paced.getLogs({ fromBlock: 1 });
  await paced.call({ to: COIN });
  assert.deepEqual(
    asked.map((a) => a[0]),
    ["receipt", "block", "count", "logs", "call"],
  );
  assert.equal(asked[1][3], true);
  for (let i = 1; i < asked.length; i++)
    assert.ok(asked[i][2] - asked[i - 1][2] >= 20, `request ${i} waited`);
});

test("pacedProvider keeps its spacing after a timer that fires late", async () => {
  /*-
   *  A busy process runs a timer late. The second request's turn is due
   *  25 ms after the first, but the event loop is held for 30 ms while it
   *  waits, so it goes out late; the third must still wait its full
   *  spacing after the second, not only what is left of the slot the
   *  second was due in.
   */
  const sentAt = [];
  const inner = {
    async getTransactionCount() {
      sentAt.push(Date.now());
      return 7;
    },
  };
  const paced = pacedProvider(inner, 25);
  await paced.getTransactionCount(WALLET, 1);
  setTimeout(() => {
    const until = Date.now() + 30;
    while (Date.now() < until);
  }, 5);
  await paced.getTransactionCount(WALLET, 2);
  await paced.getTransactionCount(WALLET, 3);
  const gap = sentAt[2] - sentAt[1];
  assert.ok(gap >= 20, `the third request followed the second by ${gap} ms`);
});

/* ---------- searching by NFT ---------- */

/**
 * A provider whose position manager emitted `logs`; each search answers
 * those inside its span, and is recorded.
 * @param {object[]} logs  Each with `blockNumber`, `topics` and `transactionHash`.
 * @returns {{getLogs: Function, filters: object[]}}
 */
function logsProvider(logs) {
  const filters = [];
  return {
    filters,
    async getLogs(filter) {
      filters.push(filter);
      return logs.filter(
        (l) =>
          l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock,
      );
    },
  };
}

/** A log of the position manager's naming NFT #7. */
const nftLog = (name, blockNumber, transactionHash = hash(blockNumber)) => ({
  blockNumber,
  transactionHash,
  topics: [topicOf(name), ethers.zeroPadValue("0x07", 32)],
});

test("nftLogsBefore walks back one span at a time, to the first span with any", async () => {
  const toBlock = 10 * SPAN;
  const provider = logsProvider([
    nftLog("DecreaseLiquidity", toBlock - SPAN - 5),
  ]);
  const logs = await nftLogsBefore(provider, {
    positionManager: PM,
    events: ["DecreaseLiquidity"],
    nftId: "7",
    toBlock,
    floorBlock: 0,
  });
  assert.equal(logs.length, 1);
  assert.deepEqual(
    provider.filters.map((f) => [f.fromBlock, f.toBlock]),
    [
      [toBlock - SPAN + 1, toBlock],
      [toBlock - 2 * SPAN + 1, toBlock - SPAN],
    ],
  );
  assert.equal(provider.filters[0].address, PM);
  assert.deepEqual(provider.filters[0].topics, [
    [topicOf("DecreaseLiquidity")],
    ethers.zeroPadValue("0x07", 32),
  ]);
});

test("nftLogsBefore stops at the floor and finds nothing below it", async () => {
  const provider = logsProvider([nftLog("Collect", 10)]);
  const logs = await nftLogsBefore(provider, {
    positionManager: PM,
    events: ["Collect"],
    nftId: "7",
    toBlock: SPAN + 100,
    floorBlock: 50,
  });
  assert.deepEqual(logs, []);
  assert.deepEqual(
    provider.filters.map((f) => [f.fromBlock, f.toBlock]),
    [
      [101, SPAN + 100],
      [50, 100],
    ],
  );
});

test("drainBlockBefore gives the latest drain, searching to the floor it is given", async () => {
  const provider = logsProvider([
    nftLog("DecreaseLiquidity", 900),
    nftLog("DecreaseLiquidity", 950),
  ]);
  const search = {
    positionManager: PM,
    nftId: "7",
    mintBlock: 1000,
    floorBlock: 800,
    blocksPerMonth: 10,
  };
  assert.equal(await drainBlockBefore(provider, search), 950);
  assert.equal(provider.filters[0].fromBlock, 800);
});

test("drainBlockBefore searches a month back without a floor, and may find none", async () => {
  const provider = logsProvider([]);
  const found = await drainBlockBefore(provider, {
    positionManager: PM,
    nftId: "7",
    mintBlock: 1000,
    floorBlock: null,
    blocksPerMonth: 300,
  });
  assert.equal(found, null);
  assert.equal(provider.filters.at(-1).fromBlock, 700);
});

test("collectBlockBefore finds the collect just before the deposit", async () => {
  const deposit = hash(105);
  const provider = logsProvider([
    nftLog("Collect", 100),
    nftLog("IncreaseLiquidity", 105, deposit),
  ]);
  const search = {
    positionManager: PM,
    nftId: "7",
    depositHash: deposit,
    depositBlock: 105,
  };
  assert.equal(await collectBlockBefore(provider, search), 100);
  assert.deepEqual(provider.filters[0].topics[0], [
    topicOf("Collect"),
    topicOf("IncreaseLiquidity"),
  ]);
});

test("collectBlockBefore finds none when another deposit came after the collect", async () => {
  const deposit = hash(105);
  const after = logsProvider([
    nftLog("Collect", 90),
    nftLog("IncreaseLiquidity", 95),
    nftLog("IncreaseLiquidity", 105, deposit),
  ]);
  const search = {
    positionManager: PM,
    nftId: "7",
    depositHash: deposit,
    depositBlock: 105,
  };
  assert.equal(await collectBlockBefore(after, search), null);
  const alone = logsProvider([nftLog("IncreaseLiquidity", 105, deposit)]);
  assert.equal(await collectBlockBefore(alone, search), null);
});

/* ---------- searching by wallet ---------- */

/**
 * A provider modelling a chain where the wallet sent `mine` and another
 * address sent `theirs`: the wallet's count at a block is how many of its
 * transactions came at or before it, on top of 40 sent long before.
 * @param {object[]} mine    Each with `hash`, `blockNumber` and `nonce`.
 * @param {object[]} theirs  Likewise, from another address.
 * @returns {object}  The provider, with `asked` recording what was asked.
 */
function chainOf(mine, theirs) {
  const asked = { counts: [], blocks: [] };
  const all = [
    ...mine.map((t) => ({ ...t, from: WALLET, value: 0n })),
    ...theirs.map((t) => ({ ...t, from: OTHER, value: 1n })),
  ];
  return {
    asked,
    async getTransactionCount(address, block) {
      asked.counts.push(block);
      return 40 + mine.filter((t) => t.blockNumber <= block).length;
    },
    async getBlock(number) {
      asked.blocks.push(number);
      return {
        timestamp: 1000 + number,
        prefetchedTransactions: all.filter((t) => t.blockNumber === number),
      };
    },
  };
}

test("walletTransactionsIn lists the wallet's transactions, reading only their blocks", async () => {
  const mine = [
    { hash: hash(1), blockNumber: 102, nonce: 40 },
    { hash: hash(2), blockNumber: 102, nonce: 41 },
    { hash: hash(3), blockNumber: 105, nonce: 42 },
    { hash: hash(4), blockNumber: 117, nonce: 43 },
  ];
  const theirs = [{ hash: hash(9), blockNumber: 105, nonce: 7 }];
  const provider = chainOf(mine, theirs);
  const found = await walletTransactionsIn(provider, WALLET, 100, 120);
  assert.deepEqual(
    found.map((t) => [t.hash, t.blockNumber, t.nonce, t.timestamp, t.value]),
    [
      [hash(1), 102, 40, 1102, 0n],
      [hash(2), 102, 41, 1102, 0n],
      [hash(3), 105, 42, 1105, 0n],
      [hash(4), 117, 43, 1117, 0n],
    ],
  );
  assert.deepEqual(provider.asked.blocks, [102, 105, 117]);
});

test("walletTransactionsIn asks two counts of a span the wallet sent nothing in", async () => {
  const provider = chainOf([{ hash: hash(1), blockNumber: 99, nonce: 40 }], []);
  assert.deepEqual(await walletTransactionsIn(provider, WALLET, 100, 5000), []);
  assert.deepEqual(provider.asked.counts, [99, 5000]);
  assert.deepEqual(provider.asked.blocks, []);
});

/* ---------- coins ---------- */

const CALLS = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

/**
 * A provider whose contracts answer each call from `answers`, by name; an
 * answer that is an Error makes the call revert.
 * @param {object} answers
 * @returns {{call: Function}}
 */
function callsProvider(answers) {
  return {
    async call({ data }) {
      const name = CALLS.parseTransaction({ data }).name;
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return CALLS.encodeFunctionResult(name, answer);
    },
  };
}

test("coinInfo asks a coin its symbol and decimals", async () => {
  const provider = callsProvider({ symbol: ["AAA"], decimals: [8] });
  assert.deepEqual(await coinInfo(provider, COIN), {
    symbol: "AAA",
    decimals: 8n,
  });
});

test("coinInfo names a coin by its address when its symbol cannot be read", async () => {
  const provider = callsProvider({
    symbol: new Error("reverted"),
    decimals: [18],
  });
  assert.deepEqual(await coinInfo(provider, COIN), {
    symbol: COIN,
    decimals: 18n,
  });
});

/* ---------- an endpoint that fails ---------- */

test("markRpcFailure marks the endpoint's failures, not the chain's refusals", () => {
  const down = markRpcFailure(
    Object.assign(new Error("timeout"), { code: "TIMEOUT" }),
  );
  assert.equal(down.rpcFailure, true);
  assert.equal(down.message, "timeout");
  const refused = markRpcFailure(
    Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" }),
  );
  assert.equal(refused.rpcFailure, undefined);
  const odd = markRpcFailure("socket hang up");
  assert.ok(odd instanceof Error);
  assert.equal(odd.message, "socket hang up");
  assert.equal(odd.rpcFailure, true);
});

test("pacedProvider passes on a failed request, marked as the endpoint's", async () => {
  const paced = pacedProvider(
    {
      async getTransactionReceipt() {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "NETWORK_ERROR",
        });
      },
      async call() {
        throw Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
        });
      },
    },
    0,
  );
  await assert.rejects(paced.getTransactionReceipt(hash(1)), {
    message: "connect ECONNREFUSED",
    rpcFailure: true,
  });
  await assert.rejects(paced.call({ to: COIN, data: "0x" }), (error) => {
    assert.equal(error.rpcFailure, undefined);
    return true;
  });
});

test("coinInfo passes on an endpoint's failure rather than naming the coin", async () => {
  const paced = pacedProvider(
    {
      async call({ data }) {
        const name = CALLS.parseTransaction({ data }).name;
        if (name === "decimals") return CALLS.encodeFunctionResult(name, [18]);
        throw Object.assign(new Error("502 Bad Gateway"), {
          code: "SERVER_ERROR",
        });
      },
    },
    0,
  );
  await assert.rejects(coinInfo(paced, COIN), {
    message: "502 Bad Gateway",
    rpcFailure: true,
  });
});

test("nftCoins asks the position manager an NFT's two coins", async () => {
  const provider = callsProvider({
    positions: [
      0,
      ethers.ZeroAddress,
      COIN,
      OTHER,
      2500,
      -10,
      10,
      1,
      0,
      0,
      0,
      0,
    ],
  });
  assert.deepEqual(await nftCoins(provider, PM, "7"), {
    token0: COIN,
    token1: OTHER,
  });
});
