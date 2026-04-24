/**
 * @file test/bot-cycle-residual.test.js
 * @description Tests for src/bot-cycle-residual.js — automatic
 *   residual-cleanup rebalance detection.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  checkResidualCleanup,
  classifyTrigger: _classifyTrigger,
  updateCleanupState: _updateCleanupState,
  computeWalletResidualUsd,
  TUNABLES,
} = require("../src/bot-cycle-residual");

/** Build a deps object with a fresh botState and a throttle mock. */
function mkDeps(overrides = {}) {
  const state = {
    lastRebalanceAt: Date.now() - TUNABLES.delayMs - 1000,
    rebalanceInProgress: false,
    residualCleanupUsed: false,
    rebalancePaused: false,
    forceRebalance: false,
    ...(overrides.state || {}),
  };
  const throttle = {
    canRebalance: () => ({ allowed: true, msUntilAllowed: 0, reason: "ok" }),
    ...(overrides.throttle || {}),
  };
  const emitted = [];
  return {
    _botState: state,
    throttle,
    updateBotState: (patch) => emitted.push(patch),
    _emitted: emitted,
    ...overrides.extra,
  };
}

function mkSnap({ lp = 100, residual = 10 } = {}) {
  return { currentValue: lp, residualValueUsd: residual };
}

describe("bot-cycle-residual: checkResidualCleanup", () => {
  it("arms cleanup when all gates pass and residual exceeds threshold", () => {
    const deps = mkDeps();
    const snap = mkSnap({ lp: 90, residual: 10 }); // 10/100 = 10% > 5%
    const fired = checkResidualCleanup(deps, snap);
    assert.strictEqual(fired, true);
    assert.strictEqual(deps._botState.forceRebalance, true);
    assert.strictEqual(deps._botState.residualCleanupInProgress, true);
    assert.ok(
      deps._emitted.some((p) => p.residualCleanupInProgress === true),
      "emits residualCleanupInProgress via updateBotState",
    );
  });

  it("does NOT arm when residual share is at or below threshold", () => {
    const deps = mkDeps();
    // 5/100 = ~4.76% which is below 5% threshold default
    const snap = mkSnap({ lp: 100, residual: 5 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
    assert.strictEqual(deps._botState.residualCleanupInProgress, undefined);
  });

  it("does NOT arm when lastRebalanceAt is within the delay window", () => {
    const deps = mkDeps({ state: { lastRebalanceAt: Date.now() - 1000 } });
    const snap = mkSnap({ lp: 50, residual: 50 }); // 50% residual
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });

  it("does NOT arm when lastRebalanceAt is missing", () => {
    const deps = mkDeps({ state: { lastRebalanceAt: 0 } });
    const snap = mkSnap({ lp: 50, residual: 50 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });

  it("does NOT arm while residualCleanupUsed is set (no back-to-back)", () => {
    const deps = mkDeps({ state: { residualCleanupUsed: true } });
    const snap = mkSnap({ lp: 50, residual: 50 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });

  it("does NOT arm while rebalanceInProgress", () => {
    const deps = mkDeps({ state: { rebalanceInProgress: true } });
    const snap = mkSnap({ lp: 50, residual: 50 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });

  it("does NOT arm while rebalancePaused", () => {
    const deps = mkDeps({ state: { rebalancePaused: true } });
    const snap = mkSnap({ lp: 50, residual: 50 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });

  it("does NOT arm when forceRebalance is already set (manual pending)", () => {
    const deps = mkDeps({ state: { forceRebalance: true } });
    const snap = mkSnap({ lp: 50, residual: 50 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
    // Must not set residualCleanupInProgress on an existing manual request.
    assert.strictEqual(deps._botState.residualCleanupInProgress, undefined);
  });

  it("does NOT arm when throttle blocks", () => {
    const deps = mkDeps({
      throttle: {
        canRebalance: () => ({
          allowed: false,
          msUntilAllowed: 5000,
          reason: "min_interval",
        }),
      },
    });
    const snap = mkSnap({ lp: 50, residual: 50 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });

  it("does NOT arm when snap is null", () => {
    const deps = mkDeps();
    assert.strictEqual(checkResidualCleanup(deps, null), false);
  });

  it("does NOT arm when currentValue is zero (drained position)", () => {
    const deps = mkDeps();
    const snap = mkSnap({ lp: 0, residual: 10 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });

  it("does NOT arm when residual is zero", () => {
    const deps = mkDeps();
    const snap = mkSnap({ lp: 100, residual: 0 });
    assert.strictEqual(checkResidualCleanup(deps, snap), false);
  });
});

describe("bot-cycle: _classifyTrigger", () => {
  it("classifies residual-cleanup when residualCleanupInProgress is set", () => {
    assert.strictEqual(
      _classifyTrigger({
        residualCleanupInProgress: true,
        forceRebalance: true,
      }),
      "residual-cleanup",
    );
  });

  it("classifies manual when forceRebalance without cleanup-in-progress", () => {
    assert.strictEqual(_classifyTrigger({ forceRebalance: true }), "manual");
  });

  it("classifies out-of-range by default", () => {
    assert.strictEqual(_classifyTrigger({}), "out-of-range");
    assert.strictEqual(_classifyTrigger(null), "out-of-range");
  });
});

describe("bot-cycle: _updateCleanupState", () => {
  it("on normal rebalance success: clears used flag, stamps lastRebalanceAt, clears in-progress", () => {
    const state = {
      residualCleanupInProgress: false,
      residualCleanupUsed: true,
      lastRebalanceAt: 123,
    };
    const emitted = [];
    _updateCleanupState(state, "out-of-range", (p) => emitted.push(p));
    assert.strictEqual(state.residualCleanupUsed, false);
    assert.ok(state.lastRebalanceAt > 123, "lastRebalanceAt refreshed");
  });

  it("on manual rebalance success: also clears used flag, stamps lastRebalanceAt", () => {
    const state = { residualCleanupUsed: true, lastRebalanceAt: 123 };
    _updateCleanupState(state, "manual", () => {});
    assert.strictEqual(state.residualCleanupUsed, false);
    assert.ok(state.lastRebalanceAt > 123);
  });

  it("on cleanup rebalance success: sets used flag, does NOT refresh lastRebalanceAt", () => {
    const state = {
      residualCleanupInProgress: true,
      residualCleanupUsed: false,
      lastRebalanceAt: 123,
    };
    const emitted = [];
    _updateCleanupState(state, "residual-cleanup", (p) => emitted.push(p));
    assert.strictEqual(state.residualCleanupUsed, true);
    assert.strictEqual(
      state.lastRebalanceAt,
      123,
      "lastRebalanceAt preserved (cleanup cannot re-arm against own baseline)",
    );
    assert.strictEqual(state.residualCleanupInProgress, false);
    assert.ok(
      emitted.some((p) => p.residualCleanupInProgress === false),
      "clears residualCleanupInProgress via emit",
    );
  });
});

describe("bot-cycle-residual: computeWalletResidualUsd", () => {
  function mkDepsWithTracker({ bal0 = 0n, bal1 = 0n, cappedUsd = 0 } = {}) {
    let cappedCall = null;
    /*- Minimal ethers-like stub: new Contract(addr, abi, provider) returns
     *  an object with an async balanceOf() that resolves to a preset value. */
    const ethersLib = {
      Contract: function (addr) {
        this.addr = addr;
        this.balanceOf = async () =>
          addr === "0xtoken0" ? bal0 : addr === "0xtoken1" ? bal1 : 0n;
      },
    };
    return {
      deps: {
        provider: {},
        signer: { getAddress: async () => "0xwallet" },
        _ethersLib: ethersLib,
        _residualTracker: {
          cappedValueUsd: (poolAddr, b0, b1, p0, p1, d0, d1) => {
            cappedCall = { poolAddr, b0, b1, p0, p1, d0, d1 };
            return cappedUsd;
          },
        },
      },
      getCappedCall: () => cappedCall,
    };
  }

  it("returns the tracker's capped USD value using on-chain balances and result prices", async () => {
    const { deps, getCappedCall } = mkDepsWithTracker({
      bal0: 100n,
      bal1: 200n,
      cappedUsd: 193.45,
    });
    const result = {
      poolAddress: "0xpool",
      token0UsdPrice: 1.23,
      token1UsdPrice: 4.56,
      decimals0: 18,
      decimals1: 6,
    };
    const usd = await computeWalletResidualUsd(
      deps,
      result,
      "0xtoken0",
      "0xtoken1",
    );
    assert.strictEqual(usd, 193.45);
    const call = getCappedCall();
    assert.strictEqual(call.poolAddr, "0xpool");
    assert.strictEqual(call.b0, 100n);
    assert.strictEqual(call.b1, 200n);
    assert.strictEqual(call.p0, 1.23);
    assert.strictEqual(call.p1, 4.56);
    assert.strictEqual(call.d0, 18);
    assert.strictEqual(call.d1, 6);
  });

  it("returns 0 when no residual tracker is available", async () => {
    const deps = { provider: {}, signer: { getAddress: async () => "0x" } };
    const usd = await computeWalletResidualUsd(
      deps,
      { poolAddress: "0xpool" },
      "0xtoken0",
      "0xtoken1",
    );
    assert.strictEqual(usd, 0);
  });

  it("returns 0 when the rebalance result has no poolAddress", async () => {
    const { deps } = mkDepsWithTracker({ cappedUsd: 77 });
    const usd = await computeWalletResidualUsd(
      deps,
      { poolAddress: null },
      "0xtoken0",
      "0xtoken1",
    );
    assert.strictEqual(usd, 0);
  });

  it("swallows RPC errors and returns 0", async () => {
    const deps = {
      provider: {},
      signer: { getAddress: async () => "0x" },
      _ethersLib: {
        Contract: function () {
          this.balanceOf = async () => {
            throw new Error("rpc down");
          };
        },
      },
      _residualTracker: { cappedValueUsd: () => 100 },
    };
    const usd = await computeWalletResidualUsd(
      deps,
      { poolAddress: "0xpool" },
      "0xtoken0",
      "0xtoken1",
    );
    assert.strictEqual(usd, 0);
  });
});
