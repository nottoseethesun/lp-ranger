"use strict";

/**
 * @file test/position-details-unmanaged-response.test.js
 * @description What the unmanaged details request returns, and what it
 *   refuses to do to get there.
 *
 *   The Current panel's Fees Compounded and Gas reach the dashboard by a
 *   long route: this response's `pnlSnapshot` → `_syncLifetimeState`
 *   (src/server-routes.js) → the position's bot state → the next
 *   `/api/status` poll → `_applyUnmanagedSnapshotOverlay`. Every step
 *   drops the figures when the snapshot is absent, and the last one
 *   leaves the two rows as dashes.
 *
 *   A never-managed position has no P&L epochs, and nothing here builds
 *   any — so the snapshot cannot be conditional on having them. That is
 *   what the first test pins.
 *
 *   The second pins the point of the change: no NFT event walk. The
 *   batched read is replaced by one that fails loudly, so any return to
 *   walking the chain fails here rather than costing minutes in
 *   production.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const config = require("../src/config");

const WALLET = "0x" + "3".repeat(40);
const BODY = {
  tokenId: "300",
  token0: "0x" + "1".repeat(40),
  token1: "0x" + "2".repeat(40),
  fee: 3000,
  walletAddress: WALLET,
  liquidity: "1000",
  tickLower: -600,
  tickUpper: 600,
};
/** #100 → #200 → #300: a chain with two closed NFTs. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000 },
];

/** Load the module with everything that would touch a chain replaced. */
function load() {
  const walked = [];
  const stubs = {
    "./rebalancer": {
      getPoolState: async () => ({
        tick: 0,
        price: 1,
        decimals0: 18,
        decimals1: 18,
        poolAddress: "0xPool",
        tickSpacing: 60,
      }),
    },
    "./bot-pnl-updater": {
      positionValueUsd: () => 500,
      fetchTokenPrices: async () => ({ price0: 1, price1: 1 }),
      actualGasCostUsd: async () => 0,
    },
    "./pool-scanner": {
      scanPoolHistory: async (_p, _e, opts) => {
        await opts.computeFromHistoricalPrices(CHAIN);
        return CHAIN;
      },
    },
    "./position-details-quick": {
      computeQuickDetails: async () => ({}),
      _currentPnl: () => ({
        value: 500,
        il: null,
        profit: null,
        priceGainLoss: null,
        residualValueUsd: 0,
      }),
      _applyPriceOverrides: () => {},
      _walletResiduals: async () => ({ usd: 0 }),
    },
    "./position-details-compound": {
      _detectCurrentNftValues: async () => ({
        compoundUsd: 7.5,
        gasUsd: 1.25,
      }),
      savedNftCompoundedUsd: () => 0,
    },
    "./resolve-position-symbols": { resolvePositionSymbols: async () => {} },
    "./bot-pnl-initial-residual": {
      applyInitialResidualFromCache: () => {},
    },
    /*- Any whole-chain NFT read is the thing this change removed. */
    "./nft-events-batch": {
      scanChainNftEvents: async (ids) => {
        walked.push([...ids]);
        throw new Error("the unmanaged path must not walk the chain");
      },
      emptyEvents: () => ({}),
      eventsFor: () => ({}),
      shareRead: (f) => f,
    },
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
    return { fn: require(file).computeLifetimeDetails, walked };
  } finally {
    Module.prototype.require = origRequire;
    for (const k of Object.keys(require.cache))
      if (!loadedBefore.has(k)) delete require.cache[k];
  }
}

const run = () => {
  const { fn, walked } = load();
  return fn(null, null, BODY, { global: {}, positions: {} }).then((r) => ({
    r,
    walked,
  }));
};

describe("the unmanaged details response", () => {
  it("carries the Current-panel figures for a position with no epochs", async () => {
    /*-
     *  The regression this guards: keying the snapshot on the epoch count
     *  left a never-managed position without one, and the two Current
     *  rows rendered as dashes with nothing in the log to say why.
     */
    const { r } = await run();
    assert.ok(r.pnlSnapshot, "a snapshot must be returned, epochs or not");
    assert.equal(r.pnlSnapshot.currentCompoundedUsd, 7.5);
    assert.equal(r.pnlSnapshot.currentGasUsd, 1.25);
  });

  it("returns the rebalance events the table renders", async () => {
    const { r } = await run();
    assert.equal(r.ok, true);
    assert.deepEqual(r.rebalanceEvents, CHAIN);
  });

  it("carries no lifetime figures", async () => {
    /*-
     *  They are shown only in the Lifetime panel, which an unmanaged
     *  position replaces with a placeholder. Returning them would mean
     *  the walk that produces them.
     */
    const { r } = await run();
    for (const k of ["ltNetPnl", "ltProfit", "ltCompounded", "dailyPnl"])
      assert.equal(r[k], undefined, `${k} must not be returned`);
    assert.equal(r.pnlSnapshot.lifetimeIL, undefined);
    assert.equal(r.pnlSnapshot.totalCompoundedUsd, undefined);
  });

  it("never walks the rebalance chain", async () => {
    /*-
     *  The point of the change. The stub throws if asked, so a
     *  reintroduced walk fails here rather than costing minutes per
     *  request in production.
     */
    const { walked } = await run();
    assert.deepEqual(walked, [], "no NFT event read may be made");
  });

  it("still names the pool's own scan as the source of the events", async () => {
    /*- The Transfer scan stays: it is what the Rebalance Events table
     *  is built from, and it is not the per-NFT walk. */
    const { r } = await run();
    assert.equal(r.rebalanceEvents.length, 2);
  });
});

describe("the route's own key shape is unchanged", () => {
  it("builds the composite key the sync writes against", () => {
    const { compositeKey } = require("../src/bot-config-v2");
    const key = compositeKey(
      "pulsechain",
      WALLET,
      config.POSITION_MANAGER,
      BODY.tokenId,
    );
    assert.match(key, /^pulsechain-0x[0-9a-fA-F]{40}-0x[0-9a-fA-F]{40}-300$/);
  });
});
