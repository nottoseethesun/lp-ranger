"use strict";

/**
 * @file test/bot-recorder-scan-and-reconstruct.test.js
 * @description One scan pass reads the chain once: epoch reconstruction
 *   and the lifetime scan share a single read when both need one.
 *
 *   Driven through `_scanAndReconstruct`, the entry point that sequences
 *   them. The event scan hands its callback the chain; the pass prepares
 *   the lifetime read there when the lifetime scan will need it;
 *   reconstruction runs inside the callback and may use that read; the
 *   lifetime scan runs afterwards and uses it only while it still
 *   describes the chain the scan sees.
 *
 *   The lifetime scan and its read are real. Around them: the shared
 *   lifetime harness, the event scan (which returns a fixed chain), a
 *   stand-in for epoch reconstruction that records what it was given, and
 *   a recording batched read.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { format } = require("node:util");
const { _setSinkForTests } = require("../src/log");
const { emptyEvents } = require("../src/nft-events-batch");
const { collectTokenIds } = require("../src/bot-recorder-scan-helpers");
const {
  state,
  resetState,
  installMocks,
  restoreMocks,
  makeBotState,
} = require("./helpers/bot-recorder-lifetime-mocks");

const POOL_FLOOR = 100;
const SAVED = { totalCompoundedUsd: 148.38, totalLifetimeDepositUsd: 1704.15 };

/** #100 → #200 → #300, as the event scan finds it. */
function scannedChain() {
  return Object.assign(
    [
      {
        oldTokenId: "100",
        newTokenId: "200",
        blockNumber: 5_000,
        timestamp: 1,
      },
      {
        oldTokenId: "200",
        newTokenId: "300",
        blockNumber: 6_000,
        timestamp: 2,
      },
    ],
    { firstMintBlockNumber: 4_000 },
  );
}

let run;

/**
 * Load `_scanAndReconstruct` with the pass's surroundings stubbed.
 *
 * @param {object} mode
 * @param {() => Array} [mode.found]  What the event scan finds.
 * @param {boolean} [mode.scanFails]  Whether the event scan throws.
 * @param {boolean} [mode.epochReads]  Whether reconstruction asks for the
 *   shared read, as it does when epochs are missing.
 * @param {Function} [mode.afterEpochs]  Runs as reconstruction finishes.
 * @param {number} [mode.failReads]  Batched reads to fail first.
 */
function load(mode) {
  run = {
    reads: [],
    ownEpochReads: 0,
    epochCalls: [],
    epochEvents: null,
    epochError: null,
  };
  let failures = mode.failReads || 0;
  const stubs = {
    "./rebalancer": {
      getPoolState: async () => ({ poolAddress: "0xPOOL" }),
    },
    "./pool-scanner": {
      scanPoolHistory: async (_p, _e, opts) => {
        if (mode.scanFails) throw new Error("simulated event scan failure");
        const found = (mode.found || scannedChain)();
        await opts.computeFromHistoricalPrices?.(found);
        return found;
      },
    },
    "./epoch-reconstructor": {
      reconstructEpochs: async (o) => {
        run.epochCalls.push(o);
        /*- Without a shared read, the real reconstructor reads the
         *  closed NFTs' histories itself: counted, so a pass that reads
         *  twice shows it. */
        if (mode.epochReads && !o.readChainEvents) run.ownEpochReads += 1;
        if (mode.epochReads && o.readChainEvents) {
          try {
            run.epochEvents = await o.readChainEvents();
          } catch (err) {
            run.epochError = err;
          }
        }
        mode.afterEpochs?.();
        return 0;
      },
    },
    "./liquidity-pair-details": {
      ensureInitialResidualData: async () => null,
    },
    "./bot-recorder-scan-helpers": {
      collectTokenIds,
      fetchAllNftEvents: async (ids, fromBlock, _mintBlocks, opts) => {
        run.reads.push({ ids: [...ids], fromBlock, opts });
        if (failures > 0) {
          failures -= 1;
          throw new Error("simulated read failure");
        }
        const allNftEvents = new Map([...ids].map((id) => [id, emptyEvents()]));
        return { allNftEvents, maxBlock: fromBlock };
      },
    },
  };
  installMocks();
  const harnessRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return harnessRequire.apply(this, arguments);
  };
  const file = require.resolve("../src/bot-recorder");
  delete require.cache[file];
  try {
    return require(file)._scanAndReconstruct;
  } finally {
    delete require.cache[file];
  }
}

const position = () => ({
  tokenId: "300",
  token0: "0xA",
  token1: "0xB",
  fee: 3000,
  decimals0: 18,
  decimals1: 18,
  token0Symbol: "A",
  token1Symbol: "B",
});

/**
 * Run one pass; returns the bot's events array after it. State updates
 * land on `botState`, as the server's update callback applies them.
 *
 * @param {object} [o]
 * @param {object} [o.epochKey]  Absent when no P&L tracker could start.
 */
async function pass(scan, pos, botState, { epochKey = "epoch-key" } = {}) {
  const events = [];
  await scan(
    {},
    {},
    "0xW",
    pos,
    null,
    events,
    (patch) => Object.assign(botState, patch),
    null,
    null,
    botState,
    epochKey,
  );
  return events;
}

/** A bot state with nothing saved: every lifetime result is missing. */
function coldState() {
  state.cachedHodl = null;
  return makeBotState({});
}

beforeEach(() => {
  resetState();
  state.poolCreationBlock = POOL_FLOOR;
});
afterEach(restoreMocks);

describe("one scan pass, one chain read", () => {
  it("reads the chain once when both need it", async () => {
    const scan = load({ epochReads: true });
    await pass(scan, position(), coldState());
    assert.equal(
      run.reads.length + run.ownEpochReads,
      1,
      "the chain was read twice",
    );
    assert.equal(state.classifyCalled, true, "the lifetime scan computed");
  });

  it("gives reconstruction the lifetime read, covering every closed NFT", async () => {
    const scan = load({ epochReads: true });
    await pass(scan, position(), coldState());
    assert.equal(typeof run.epochCalls[0].readChainEvents, "function");
    assert.ok(run.epochEvents.has("100"));
    assert.ok(run.epochEvents.has("200"));
    /*- From each NFT's mint: the pool floor lifted to the chain's first
     *  mint, not the checkpoint. */
    assert.equal(run.reads[0].fromBlock, 4_000);
  });

  it("still reads once when reconstruction needs nothing", async () => {
    const scan = load({ epochReads: false });
    await pass(scan, position(), coldState());
    assert.equal(run.reads.length, 1);
  });

  it("lets reconstruction read for itself when the lifetime scan will not", async () => {
    state.cachedHodl = { poolAddress: "0xPOOL" };
    const scan = load({ epochReads: true });
    await pass(scan, position(), makeBotState(SAVED));
    assert.strictEqual(run.epochCalls[0].readChainEvents, undefined);
    assert.equal(run.reads.length, 0);
    assert.equal(run.ownEpochReads, 1);
  });

  it("reads nothing on a restart with everything saved, and reports ready", async () => {
    /*- The common restart: epochs restored from cache, every lifetime
     *  figure on disk. The pass lowers readiness as it starts, so the
     *  skipped lifetime scan must raise it again. */
    state.cachedHodl = { poolAddress: "0xPOOL" };
    const botState = makeBotState(SAVED);
    botState.totalLifetimeDepositUsd = SAVED.totalLifetimeDepositUsd;
    const scan = load({ epochReads: false });
    await pass(scan, position(), botState);
    assert.equal(run.reads.length + run.ownEpochReads, 0);
    assert.equal(botState.rebalanceScanComplete, true);
    assert.equal(botState.lifetimeScanComplete, true);
  });

  it("shares the read before any P&L tracker, and so any cache key, exists", async () => {
    /*- A fresh install whose token prices could not be fetched at start
     *  has no tracker; epoch reconstruction then does nothing, and the
     *  lifetime scan still reads the chain, once. */
    const scan = load({ epochReads: false });
    await pass(scan, position(), coldState(), { epochKey: undefined });
    assert.equal(typeof run.epochCalls[0].readChainEvents, "function");
    assert.equal(run.reads.length, 1);
    assert.equal(run.reads[0].fromBlock, 4_000);
    assert.equal(state.classifyCalled, true);
  });

  it("reads for the lifetime scan alone when the event scan finds no chain", async () => {
    const scan = load({ epochReads: true, found: () => [] });
    await pass(scan, position(), coldState());
    assert.equal(run.epochCalls.length, 0);
    assert.equal(run.reads.length, 1);
  });
});

describe("when the pass does not go to plan", () => {
  it("computes no lifetime figures on a cold start whose event scan failed", async () => {
    /*- The bot holds no chain yet. Figures computed now would cover the
     *  live NFT alone and be saved as settled, and later passes keep
     *  saved figures. */
    const botState = coldState();
    const scan = load({ scanFails: true });
    const warnings = [];
    const restore = _setSinkForTests({
      warn: (...a) => warnings.push(format(...a)),
    });
    try {
      await pass(scan, position(), botState);
    } finally {
      restore();
    }
    assert.equal(run.reads.length, 0, "the empty chain was read");
    assert.equal(state.classifyCalled, false);
    assert.equal(state.depositCalled, false);
    assert.equal(botState.lifetimeScanComplete, false, "so the rescan retries");
    assert.ok(
      warnings.some((l) =>
        l.includes("The rebalance history could not be read"),
      ),
      warnings.join("\n"),
    );
  });

  it("still reports ready when the event scan fails with every figure saved", async () => {
    /*- The saved figures came from a pass that did read the chain, so
     *  they stay on show. */
    state.cachedHodl = { poolAddress: "0xPOOL" };
    const botState = makeBotState(SAVED);
    botState.totalLifetimeDepositUsd = SAVED.totalLifetimeDepositUsd;
    const scan = load({ scanFails: true });
    const restore = _setSinkForTests({ warn: () => {} });
    try {
      await pass(scan, position(), botState);
    } finally {
      restore();
    }
    assert.equal(run.reads.length, 0);
    assert.equal(botState.lifetimeScanComplete, true);
  });

  it("reads afresh when a rebalance lands during reconstruction", async () => {
    /*- A manual rebalance moves the live NFT and flags a full rescan
     *  while reconstruction runs. The prepared read describes the chain
     *  before it. */
    const pos = position();
    const botState = coldState();
    const scan = load({
      epochReads: true,
      afterEpochs: () => {
        pos.tokenId = "301";
        botState._needsFullRescan = true;
      },
    });
    const lines = [];
    const restore = _setSinkForTests({
      log: (...a) => lines.push(format(...a)),
    });
    try {
      await pass(scan, pos, botState);
    } finally {
      restore();
    }
    assert.equal(run.reads.length, 2);
    assert.equal(run.reads[1].opts.liveTokenId, "301");
    assert.ok(run.reads[1].ids.includes("301"));
    assert.ok(
      lines.some((l) => l.includes("The chain changed during this scan pass")),
    );
  });

  it("gives the lifetime scan its own attempt when the shared read fails", async () => {
    const scan = load({ epochReads: true, failReads: 1 });
    await pass(scan, position(), coldState());
    assert.match(String(run.epochError), /simulated read failure/);
    assert.equal(run.reads.length, 2);
    assert.equal(state.classifyCalled, true);
  });

  it("costs only the sharing when preparation fails", async () => {
    /*- The first config read throws — inside the event scan's callback —
     *  and the second succeeds. The event scan must still complete, and
     *  both consumers still get their data. */
    let calls = 0;
    const botState = coldState();
    botState._getConfig = () => {
      calls += 1;
      if (calls === 1) throw new Error("config unreadable");
      return undefined;
    };
    const scan = load({ epochReads: true });
    const warnings = [];
    const restore = _setSinkForTests({
      warn: (...a) => warnings.push(format(...a)),
    });
    let events;
    try {
      events = await pass(scan, position(), botState);
    } finally {
      restore();
    }
    assert.equal(events.length, 2, "the event scan completed");
    assert.strictEqual(run.epochCalls[0].readChainEvents, undefined);
    assert.equal(run.reads.length, 1, "the lifetime scan read for itself");
    assert.ok(
      warnings.some((l) =>
        l.includes("Could not prepare the shared chain read"),
      ),
      warnings.join("\n"),
    );
  });
});
