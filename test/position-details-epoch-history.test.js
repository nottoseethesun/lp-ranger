"use strict";

/**
 * @file test/position-details-epoch-history.test.js
 * @description The unmanaged details view keeps a saved P&L history only
 *   when it covers every closed NFT in the rebalance chain, and rebuilds
 *   one that falls short.
 *
 *   Runs the real `reconstructEpochs` against the real epoch cache, kept
 *   in a temporary file. The pool scan and each closed NFT's history are
 *   replaced, so the tests see exactly when a rebuild happens.
 */

const { describe, it, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const config = require("../src/config");
const epochCache = require("../src/epoch-cache");
const { createPnlTracker } = require("../src/pnl-tracker");
const {
  CHAIN_HISTORY_MODULE,
  chainHistoryStub,
} = require("./helpers/chain-history-stub");

const WALLET = "0x" + "3".repeat(40);
const POSITION = {
  tokenId: "300",
  token0: "0x" + "1".repeat(40),
  token1: "0x" + "2".repeat(40),
  fee: 3000,
};
/** #100 → #200 → #300: two closed NFTs. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000 },
];
/** The pool's epoch-cache key, as the details view builds it. */
const KEY = {
  contract: config.POSITION_MANAGER,
  wallet: WALLET,
  token0: POSITION.token0,
  token1: POSITION.token1,
  fee: POSITION.fee,
};
/** A history every closed NFT can build an epoch from. */
const HISTORY = {
  mintDate: "2026-01-01T00:00:00Z",
  closeDate: "2026-01-02T00:00:00Z",
  entryValueUsd: 100,
  exitValueUsd: 95,
  feesEarnedUsd: 1,
  gasCostWei: "0",
};

/** What the replaced modules saw during one request. */
const run = { historyCalls: [], beforeCallback: () => {} };

/**
 * Load `src/position-details.js` with the pool scan and the closed NFTs'
 * histories replaced, and every module it pulls in for the first time
 * evicted again afterwards, so no stubbed copy outlives the load.
 */
function loadSnapshot() {
  const stubs = {
    [CHAIN_HISTORY_MODULE]: chainHistoryStub(),
    "./position-history": {
      getPositionHistory: async (tokenId) => {
        run.historyCalls.push(String(tokenId));
        return { ...HISTORY };
      },
    },
    "./bot-pnl-updater": { actualGasCostUsd: async () => 0 },
    "./price-fetcher": {
      fetchTokenPriceUsd: async () => 1,
      withFreshPricesAllowed: (fn) => fn(),
    },
    "./pool-scanner": {
      scanPoolHistory: async (_p, _e, opts) => {
        run.beforeCallback();
        await opts.computeFromHistoricalPrices(CHAIN);
        return CHAIN;
      },
    },
    // Not used by the history path; replaced so they load nothing heavy.
    "./rebalancer": {},
    "./position-details-quick": {},
    "./position-details-compound": {},
    "./position-details-lifetime-scan": {},
    "./resolve-position-symbols": {},
    "./block-time-cache": {},
    "./bot-pnl-initial-residual": {},
  };
  const loadedBefore = new Set(Object.keys(require.cache));
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return origRequire.apply(this, arguments);
  };
  const file = require.resolve("../src/position-details");
  delete require.cache[file];
  try {
    return require(file)._getLifetimeSnapshot;
  } finally {
    Module.prototype.require = origRequire;
    for (const k of Object.keys(require.cache)) {
      if (!loadedBefore.has(k)) delete require.cache[k];
    }
  }
}

/** A saved tracker state with `closed` closed epochs, and an open one if asked. */
function savedHistory(closed, { open = false } = {}) {
  const tracker = createPnlTracker();
  const params = {
    entryValue: 100,
    entryPrice: 1,
    lowerPrice: 0.9,
    upperPrice: 1.1,
  };
  for (let i = 0; i < closed; i++) {
    tracker.openEpoch(params);
    tracker.closeEpoch({ exitValue: 99, gasCost: 0 });
  }
  if (open === true) tracker.openEpoch(params);
  return tracker.serialize();
}

describe("the unmanaged view's saved P&L history", () => {
  let dir;
  let file;
  let getLifetimeSnapshot;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-epochs-"));
    file = path.join(dir, "pnl-epochs-cache.json");
    epochCache._setCachePath(file);
    getLifetimeSnapshot = loadSnapshot();
  });

  beforeEach(() => {
    fs.rmSync(file, { force: true });
    run.historyCalls = [];
    run.beforeCallback = () => {};
  });

  after(() => {
    epochCache._setCachePath(
      path.join(process.cwd(), "tmp", "pnl-epochs-cache.json"),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** One details request for the position. */
  function request() {
    return getLifetimeSnapshot(
      {},
      {},
      POSITION,
      WALLET,
      { price0: 1, price1: 1 },
      0,
      null,
      () => undefined,
    );
  }

  const closedCount = (tracker) => tracker.serialize().closedEpochs.length;

  it("rebuilds a saved history that is missing a closed NFT", async () => {
    epochCache.setCachedEpochs(KEY, savedHistory(1));
    const { tracker } = await request();
    assert.deepEqual(run.historyCalls.sort(), ["100", "200"]);
    assert.equal(closedCount(tracker), 2);
    assert.equal(epochCache.getCachedEpochs(KEY).closedEpochs.length, 2);
  });

  it("rebuilds a saved history that is empty", async () => {
    // What a rebuild leaves behind when the chain read failed.
    epochCache.setCachedEpochs(KEY, []);
    const { tracker } = await request();
    assert.deepEqual(run.historyCalls.sort(), ["100", "200"]);
    assert.equal(closedCount(tracker), 2);
  });

  it("rebuilds when only the open epoch is saved, and keeps it", async () => {
    epochCache.setCachedEpochs(KEY, savedHistory(0, { open: true }));
    const { tracker } = await request();
    assert.deepEqual(run.historyCalls.sort(), ["100", "200"]);
    assert.equal(closedCount(tracker), 2);
    assert.notEqual(tracker.serialize().liveEpoch, null);
  });

  it("keeps a saved history that covers every closed NFT", async () => {
    epochCache.setCachedEpochs(KEY, savedHistory(2));
    const { tracker } = await request();
    assert.deepEqual(run.historyCalls, [], "a complete history was rebuilt");
    assert.equal(closedCount(tracker), 2);
  });

  it("keeps a complete history another request saved meanwhile", async () => {
    /*-
     *  Nothing is saved when this request starts, but an overlapping
     *  request for the pool saves a complete history before this one's
     *  rebuild would begin.
     */
    run.beforeCallback = () => epochCache.setCachedEpochs(KEY, savedHistory(2));
    const { tracker } = await request();
    assert.deepEqual(run.historyCalls, [], "the saved history was ignored");
    assert.equal(closedCount(tracker), 2);
  });
});
