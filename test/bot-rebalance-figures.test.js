"use strict";

/**
 * @file test/bot-rebalance-figures.test.js
 * @description The end of a scan pass (`finishPassRebalanceFigures`,
 *   src/lib/bot-rebalance-figures.js): the Rebalance events still waiting for
 *   their Activity Log figures are finished from what the pass and
 *   app-data/ already hold, and written back to the pool's event cache,
 *   the bot's own list of events and the next status answer.
 *
 *   The epoch cache, the event cache, the price lookup and the balance
 *   reads are stood in for; the figures are worked out by the real code
 *   (src/lib/rebalance-activity-figures.js). The fixture rebalance is the one
 *   test/rebalance-activity-figures.test.js describes: the wallet held
 *   100 and 50 before the drain at block 900, 1,100 and 50 after it, and
 *   600 and 545 just before the mint at block 1,000.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const config = require("../src/lib/config");

const TOKEN0 = "0x" + "a0".repeat(20);
const TOKEN1 = "0x" + "b1".repeat(20);
const WALLET = "0x1111111111111111111111111111111111111111";
const MINT = 1000;
const READINGS = Object.freeze({
  beforeDrain: { amount0: 100, amount1: 50 },
  afterDrain: { amount0: 1100, amount1: 50 },
  beforeMint: { amount0: 600, amount1: 545 },
});
/** The wallet's two coins at the end of each block the figures read. */
const BALANCES = { 899: [100, 50], 900: [1100, 50], 999: [600, 545] };

/** What the stand-ins were asked, and what they answer. */
const calls = { hodlKeys: [], cacheWrites: [], balances: [], prices: [] };
let lifetimeHodl = null;
let cacheWriteError = null;

const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "./epoch-cache")
    return {
      getCachedLifetimeHodl: (key) => {
        calls.hodlKeys.push(key);
        return lifetimeHodl;
      },
    };
  if (id === "./pool-scanner")
    return {
      updateCachedEvents: async (_position, wallet, finished) => {
        if (cacheWriteError !== null) throw cacheWriteError;
        calls.cacheWrites.push({ wallet, finished });
      },
    };
  if (id === "./price-fetcher")
    return {
      fetchHistoricalPriceGecko: async (...args) => {
        calls.prices.push(args);
        return { price0: 1, price1: 1 };
      },
    };
  if (id === "./liquidity-pair-details")
    return {
      readBalanceAt: async (args) => {
        calls.balances.push(args);
        return BALANCES[args.blockTag][args.tokenAddress === TOKEN0 ? 0 : 1];
      },
    };
  if (id === "./bot-recorder-lifetime")
    return {
      scanLogCtx: () => ({
        t0Sym: "A",
        t1Sym: "B",
        tokenIdStr: "7",
        tokenEmoji: "",
      }),
    };
  return _origRequire.apply(this, arguments);
};
delete require.cache[require.resolve("../src/lib/bot-rebalance-figures")];
const {
  finishPassRebalanceFigures,
} = require("../src/lib/bot-rebalance-figures");
Module.prototype.require = _origRequire;

const POSITION = Object.freeze({
  tokenId: "7",
  token0: TOKEN0,
  token1: TOKEN1,
  decimals0: 0,
  decimals1: 0,
});

/** A rebalance event waiting for its figures, as the scanner marks one. */
const due = (over = {}) => ({
  txHash: "0xmint",
  oldTokenId: "6",
  newTokenId: "7",
  blockNumber: MINT,
  timestamp: 1_700_000_000,
  figuresDue: true,
  ...over,
});

/** The bot's own rebalance, with the readings and figure it stored. */
const live = () =>
  due({
    walletReadings: READINGS,
    historical: { impermanentLossGainPct: -0.44 },
  });

/** The pass's options, with what it publishes recorded. */
function passOpts(events, over = {}) {
  const published = [];
  return {
    published,
    events,
    position: POSITION,
    address: WALLET,
    provider: {},
    ethersLib: {},
    sharedRead: null,
    epochKey: { pool: "the pool's epoch key" },
    botState: { _getConfig: () => undefined, poolAddress: "0xFROMPOLL" },
    updateState: (patch) => published.push(patch),
    readLog: () => [],
    ...over,
  };
}

/** The pass's chain read, holding the old NFT's drain at block 900. */
const drainRead = () => ({
  read: async () =>
    new Map([["6", { dlEvents: [{ blockNumber: 900, txHash: "0xdrain" }] }]]),
});

describe("finishPassRebalanceFigures", () => {
  beforeEach(() => {
    for (const list of Object.values(calls)) list.length = 0;
    lifetimeHodl = { deposits: [], lastBlock: MINT, poolAddress: "0xPOOL" };
    cacheWriteError = null;
  });

  it("does nothing when no event waits for its figures", async () => {
    const o = passOpts([{ txHash: "0xolder" }]);
    await finishPassRebalanceFigures(o);
    assert.deepEqual(calls.hodlKeys, []);
    assert.deepEqual(o.published, []);
  });

  it("finishes the bot's own rebalance everywhere it is kept", async () => {
    const older = { txHash: "0xolder" };
    const o = passOpts([older, live()]);
    await finishPassRebalanceFigures(o);
    assert.deepEqual(calls.hodlKeys, [o.epochKey]);
    const done = o.events[1];
    assert.equal(done.figuresDue, undefined);
    assert.deepEqual(done.beforeRebalance, READINGS.afterDrain);
    assert.deepEqual(done.afterRebalance, READINGS.beforeMint);
    // The pool's event cache, the bot's list, and the next status answer.
    assert.equal(calls.cacheWrites.length, 1);
    assert.equal(calls.cacheWrites[0].wallet, WALLET);
    assert.strictEqual(calls.cacheWrites[0].finished.get("0xmint"), done);
    assert.strictEqual(o.events[0], older);
    assert.deepEqual(o.published, [{ rebalanceEvents: [older, done] }]);
    // Its own readings and figure: nothing read, nothing priced.
    assert.deepEqual(calls.balances, []);
    assert.deepEqual(calls.prices, []);
  });

  it("reads a rebalance rebuilt from the chain around its drain", async () => {
    const o = passOpts([due()], { sharedRead: drainRead() });
    await finishPassRebalanceFigures(o);
    const read = calls.balances.map((b) => [
      b.blockTag,
      b.tokenAddress === TOKEN0 ? 0 : 1,
      b.wallet,
      b.decimals,
    ]);
    read.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.deepEqual(read, [
      [899, 0, WALLET, 0],
      [899, 1, WALLET, 0],
      [900, 0, WALLET, 0],
      [900, 1, WALLET, 0],
      [999, 0, WALLET, 0],
      [999, 1, WALLET, 0],
    ]);
    assert.deepEqual(o.events[0].walletReadings, READINGS);
    // Priced in the cached pool, at the mint's block.
    assert.deepEqual(calls.prices, [
      [
        "0xPOOL",
        1_700_000_000,
        { token0Address: TOKEN0, token1Address: TOKEN1, blockNumber: MINT },
      ],
    ]);
    const pct = o.events[0].historical.impermanentLossGainPct;
    assert.ok(Math.abs(pct - ((1145 - 1150) / 1145) * 100) < 1e-9);
  });

  it("prices in the pool the poll read when the epoch cache names none", async () => {
    lifetimeHodl = { deposits: [], lastBlock: MINT };
    await finishPassRebalanceFigures(
      passOpts([due()], { sharedRead: drainRead() }),
    );
    assert.equal(calls.prices[0][0], "0xFROMPOLL");
  });

  it("takes the readings and prices this install's log recorded", async () => {
    const logged = {
      chain: config.CHAIN_NAME,
      contract: config.POSITION_MANAGER,
      wallet: WALLET,
      newTokenId: "7",
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -0.44 },
      token0UsdPrice: 1,
      token1UsdPrice: 1,
    };
    const o = passOpts([due()], { readLog: () => [logged] });
    await finishPassRebalanceFigures(o);
    assert.deepEqual(o.events[0].walletReadings, READINGS);
    assert.deepEqual(o.events[0].historical, { impermanentLossGainPct: -0.44 });
    assert.deepEqual(calls.balances, []);
    assert.deepEqual(calls.prices, []);
  });

  it("leaves events due when the pass read no chain, or no deposits", async () => {
    // The shared read failed, so the drain cannot be found.
    const failed = { read: async () => Promise.reject(new Error("429")) };
    const o = passOpts([due()], { sharedRead: failed });
    await finishPassRebalanceFigures(o);
    assert.equal(o.events[0].figuresDue, true);
    // No epoch key: the pool's deposits are not known.
    const noKey = passOpts([live()], { epochKey: null });
    await finishPassRebalanceFigures(noKey);
    assert.equal(noKey.events[0].figuresDue, true);
    assert.deepEqual(calls.cacheWrites, []);
    assert.deepEqual([...o.published, ...noKey.published], []);
  });

  it("asks a failed chain read once for every waiting event", async () => {
    /*-
     *  Each event needs the chain to find its drain. A read that fails
     *  is not started again for the next one: on a long chain each is a
     *  full read, minutes of requests.
     */
    let asked = 0;
    const failing = {
      read: async () => {
        asked += 1;
        throw new Error("simulated read failure");
      },
    };
    const second = due({ txHash: "0xmint2", oldTokenId: "7", newTokenId: "8" });
    const o = passOpts([due(), second], { sharedRead: failing });
    await finishPassRebalanceFigures(o);
    assert.equal(asked, 1);
    assert.equal(o.events[0].figuresDue, true);
    assert.equal(o.events[1].figuresDue, true);
  });

  it("leaves the events due, and does not throw, when writing them fails", async () => {
    cacheWriteError = new Error("disk full");
    const o = passOpts([live()]);
    await assert.doesNotReject(finishPassRebalanceFigures(o));
    assert.equal(o.events[0].figuresDue, true);
    assert.deepEqual(o.published, []);
  });
});
