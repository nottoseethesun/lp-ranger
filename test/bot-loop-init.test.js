/**
 * @file test/bot-loop-init.test.js
 * @description Tests for _initPnlTracker and _detectPosition in bot-loop.js.
 *   Uses module-level require mocks for position-detector and epoch-cache.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

describe("bot-loop _initPnlTracker", () => {
  let _initPnlTracker;
  const _origRequire = Module.prototype.require;
  let _cachedEpochs = null;
  let _cachedHodl = null;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./epoch-cache") {
        return {
          getCachedEpochs: () => _cachedEpochs,
          setCachedEpochs: () => {},
          getCachedLifetimeHodl: () => _cachedHodl,
          setCachedLifetimeHodl: () => {},
          getLastNftScanBlock: () => 0,
          setLastNftScanBlock: () => {},
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-loop")];
    delete require.cache[require.resolve("../src/bot-loop-detect")];
    ({ _initPnlTracker } = require("../src/bot-loop"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/bot-loop")];
    delete require.cache[require.resolve("../src/bot-loop-detect")];
  });

  it("creates tracker and opens epoch when no cache", () => {
    _cachedEpochs = null;
    _cachedHodl = null;
    const botState = { walletAddress: "0xW" };
    const ps = { price: 0.001 };
    const position = {
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
    };
    const { tracker, epochKey } = _initPnlTracker(
      100,
      botState,
      ps,
      0.0009,
      0.0011,
      0.5,
      0.3,
      position,
      "0xW",
    );
    assert.ok(tracker);
    assert.ok(epochKey);
    // openEpoch was called, so epochCount includes the live epoch
    assert.ok(tracker.epochCount() >= 1);
    const snap = tracker.snapshot(0.001);
    assert.ok(snap);
  });

  it("restores from cache when epochs exist", () => {
    _cachedEpochs = {
      closedEpochs: [{ id: 1, status: "closed" }],
      liveEpoch: null,
    };
    _cachedHodl = { amount0: 10, amount1: 20 };
    const botState = { walletAddress: "0xW" };
    const ps = { price: 0.001 };
    const position = { token0: "0xA", token1: "0xB", fee: 3000 };
    const { tracker } = _initPnlTracker(
      100,
      botState,
      ps,
      0.0009,
      0.0011,
      0.5,
      0.3,
      position,
      "0xW",
    );
    assert.ok(tracker);
    assert.ok(botState.lifetimeHodlAmounts);
    assert.strictEqual(botState.lifetimeHodlAmounts.amount0, 10);
  });

  it("builds correct epoch key from position", () => {
    _cachedEpochs = null;
    _cachedHodl = null;
    const position = { token0: "0xT0", token1: "0xT1", fee: 500 };
    const { epochKey } = _initPnlTracker(
      50,
      {},
      { price: 1 },
      0.9,
      1.1,
      1,
      1,
      position,
      "0xWallet",
    );
    assert.strictEqual(epochKey.token0, "0xT0");
    assert.strictEqual(epochKey.token1, "0xT1");
    assert.strictEqual(epochKey.fee, 500);
    assert.strictEqual(epochKey.wallet, "0xWallet");
  });

  it("returns null epochKey when position is null", () => {
    _cachedEpochs = null;
    _cachedHodl = null;
    const { epochKey } = _initPnlTracker(
      50,
      {},
      { price: 1 },
      0.9,
      1.1,
      1,
      1,
      null,
      "0xW",
    );
    assert.strictEqual(epochKey, null);
  });
});

describe("bot-loop _tryInitPnlTracker", () => {
  let _tryInitPnlTracker;
  const _origRequire2 = Module.prototype.require;
  let _mockPrices = { price0: 0, price1: 0 };
  let _mockPoolState = null;
  let _mockPosValue = 0;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        return {
          positionValueUsd: () => _mockPosValue,
          fetchTokenPrices: async () => _mockPrices,
          overridePnlWithRealValues: () => {},
          readUnclaimedFees: async () => ({
            tokensOwed0: 0n,
            tokensOwed1: 0n,
          }),
          estimateGasCostUsd: async () => 0,
          actualGasCostUsd: async () => 0,
          addPoolShare: async () => {},
        };
      }
      if (id === "./rebalancer") {
        return {
          getPoolState: async () => _mockPoolState,
          executeRebalance: async () => ({}),
        };
      }
      if (id === "./epoch-cache") {
        return {
          getCachedEpochs: () => null,
          setCachedEpochs: () => {},
          getCachedLifetimeHodl: () => null,
          setCachedLifetimeHodl: () => {},
          getLastNftScanBlock: () => 0,
          setLastNftScanBlock: () => {},
        };
      }
      return _origRequire2.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-loop")];
    delete require.cache[require.resolve("../src/bot-loop-detect")];
    ({ _tryInitPnlTracker } = require("../src/bot-loop"));
  });

  after(() => {
    Module.prototype.require = _origRequire2;
    delete require.cache[require.resolve("../src/bot-loop")];
    delete require.cache[require.resolve("../src/bot-loop-detect")];
  });

  it("returns null when prices are 0", async () => {
    _mockPrices = { price0: 0, price1: 0 };
    const result = await _tryInitPnlTracker(
      {},
      {},
      {
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        tickLower: -100,
        tickUpper: 100,
      },
      {},
      () => {},
      "0xW",
    );
    assert.strictEqual(result, null);
  });

  it("returns tracker when prices are positive", async () => {
    _mockPrices = { price0: 1.5, price1: 0.5 };
    _mockPoolState = {
      price: 3,
      tick: 0,
      decimals0: 18,
      decimals1: 18,
      sqrtPriceX96: 0n,
      poolAddress: "0xPool",
    };
    _mockPosValue = 100;
    const patches = [];
    const result = await _tryInitPnlTracker(
      {},
      {},
      {
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        tickLower: -100,
        tickUpper: 100,
      },
      {},
      (p) => patches.push(p),
      "0xW",
    );
    assert.ok(result);
    assert.ok(patches.length > 0);
  });

  it("returns null on error", async () => {
    _mockPrices = { price0: 1, price1: 1 };
    _mockPoolState = null; // will cause getPoolState to throw
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        return {
          positionValueUsd: () => 0,
          fetchTokenPrices: async () => {
            throw new Error("RPC down");
          },
          overridePnlWithRealValues: () => {},
        };
      }
      if (id === "./rebalancer") {
        return {
          getPoolState: async () => {
            throw new Error("fail");
          },
        };
      }
      if (id === "./epoch-cache") {
        return {
          getCachedEpochs: () => null,
          setCachedEpochs: () => {},
          getCachedLifetimeHodl: () => null,
          setCachedLifetimeHodl: () => {},
          getLastNftScanBlock: () => 0,
          setLastNftScanBlock: () => {},
        };
      }
      return _origRequire2.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-loop")];
    delete require.cache[require.resolve("../src/bot-loop-detect")];
    const { _tryInitPnlTracker: fn } = require("../src/bot-loop");
    const result = await fn(
      {},
      {},
      {
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        tickLower: -100,
        tickUpper: 100,
      },
      {},
      () => {},
      "0xW",
    );
    assert.strictEqual(result, null);
  });
});

describe("bot-loop _detectPosition", () => {
  let _detectPosition;
  const _origRequire = Module.prototype.require;
  let _mockPositions = [];
  let _detectCallCount = 0;
  let _mockType = "nft";

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./position-detector") {
        return {
          detectPositionType: async () => {
            _detectCallCount++;
            return {
              type: _mockType,
              nftPositions: _mockType === "nft" ? _mockPositions : null,
            };
          },
          refreshLpPositionLiquidity: async () => new Map(),
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-loop")];
    delete require.cache[require.resolve("../src/bot-loop-detect")];
    ({ _detectPosition } = require("../src/bot-loop"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/bot-loop")];
    delete require.cache[require.resolve("../src/bot-loop-detect")];
  });

  it("throws when no NFT positions found", async () => {
    _mockPositions = [];
    _mockType = "nft";
    await assert.rejects(
      () => _detectPosition({}, "0xWallet"),
      /No V3 NFT position found/,
    );
  });

  it("retries on transient detector miss before throwing", async () => {
    // Simulates RPC saturation: detector returns 'unknown' (instead of
    // 'nft') for the first two attempts, then recovers. Without retry,
    // a single transient blip during Manage surfaced to users as the
    // cryptic "No V3 NFT position found" error.  See PR fix-no-nft-found-error.
    _mockType = "unknown";
    _detectCallCount = 0;
    _mockPositions = [{ tokenId: "42", fee: 3000, liquidity: 100n }];
    // Flip back to 'nft' after the second call so attempt #3 succeeds.
    const _orig = Module.prototype.require;
    let calls = 0;
    Module.prototype.require = function (id) {
      if (id === "./position-detector") {
        return {
          detectPositionType: async () => {
            calls++;
            if (calls < 3) return { type: "unknown", nftPositions: null };
            return { type: "nft", nftPositions: _mockPositions };
          },
          refreshLpPositionLiquidity: async () => new Map(),
        };
      }
      return _orig.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-loop-detect")];
    const { _detectPosition: dp } = require("../src/bot-loop-detect");
    const p = await dp({}, "0xW", "42");
    assert.strictEqual(String(p.tokenId), "42");
    assert.strictEqual(calls, 3, "should retry until success");
    Module.prototype.require = _orig;
    delete require.cache[require.resolve("../src/bot-loop-detect")];
  });

  it("engages RPC failover between attempts and gives up after 4 tries", async () => {
    // All attempts return 'unknown'.  Verifies (a) exactly 4 calls
    // (the new cap), (b) onRpcFailure is invoked 3 times — once
    // between each pair of consecutive attempts, never after the
    // final attempt, and (c) the per-attempt getProvider is consulted
    // so failover-routed reads are wired.
    const _orig = Module.prototype.require;
    let calls = 0;
    const providerSeen = [];
    Module.prototype.require = function (id) {
      if (id === "./position-detector") {
        return {
          detectPositionType: async (prov) => {
            calls++;
            providerSeen.push(prov);
            return { type: "unknown", nftPositions: null };
          },
          refreshLpPositionLiquidity: async () => new Map(),
        };
      }
      return _orig.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-loop-detect")];
    const { _detectPosition: dp } = require("../src/bot-loop-detect");
    let failoverCalls = 0;
    const provPrimary = { _label: "primary" };
    const provFallback = { _label: "fallback" };
    let onFallback = false;
    await assert.rejects(
      () =>
        dp({}, "0xW", "42", {
          getProvider: () => (onFallback ? provFallback : provPrimary),
          onRpcFailure: () => {
            failoverCalls++;
            onFallback = true;
          },
        }),
      /No V3 NFT position found after 4 attempts/,
    );
    assert.strictEqual(calls, 4, "should attempt exactly 4 times");
    assert.strictEqual(
      failoverCalls,
      3,
      "failover should fire between attempts (3× for 4 attempts), not after the last",
    );
    assert.strictEqual(
      providerSeen[0],
      provPrimary,
      "first attempt on primary",
    );
    assert.strictEqual(
      providerSeen[1],
      provFallback,
      "subsequent attempts use the failed-over provider",
    );
    Module.prototype.require = _orig;
    delete require.cache[require.resolve("../src/bot-loop-detect")];
  });

  it("throws when no valid fee tiers found", async () => {
    _mockType = "nft";
    _mockPositions = [{ tokenId: "1", fee: 0, liquidity: 100n }];
    await assert.rejects(
      () => _detectPosition({}, "0xWallet"),
      /No positions with a valid V3 fee tier/,
    );
  });

  it("selects the position with matching targetId", async () => {
    _mockType = "nft";
    _mockPositions = [
      { tokenId: "10", fee: 3000, liquidity: 100n },
      { tokenId: "20", fee: 3000, liquidity: 200n },
    ];
    const p = await _detectPosition({}, "0xW", "10");
    assert.strictEqual(String(p.tokenId), "10");
  });

  it("falls back to first valid when targetId not found", async () => {
    _mockType = "nft";
    _mockPositions = [
      { tokenId: "10", fee: 3000, liquidity: 100n },
      { tokenId: "20", fee: 3000, liquidity: 200n },
    ];
    const p = await _detectPosition({}, "0xW", "999");
    assert.strictEqual(String(p.tokenId), "10");
  });

  it("picks highest liquidity when no targetId", async () => {
    _mockType = "nft";
    _mockPositions = [
      { tokenId: "10", fee: 3000, liquidity: 100n },
      { tokenId: "20", fee: 3000, liquidity: 500n },
      { tokenId: "30", fee: 3000, liquidity: 200n },
    ];
    const p = await _detectPosition({}, "0xW");
    assert.strictEqual(String(p.tokenId), "20");
  });

  it("picks highest tokenId when all liquidity is 0", async () => {
    _mockType = "nft";
    _mockPositions = [
      { tokenId: "10", fee: 3000, liquidity: 0n },
      { tokenId: "30", fee: 3000, liquidity: 0n },
      { tokenId: "20", fee: 3000, liquidity: 0n },
    ];
    const p = await _detectPosition({}, "0xW");
    assert.strictEqual(String(p.tokenId), "30");
  });
});
