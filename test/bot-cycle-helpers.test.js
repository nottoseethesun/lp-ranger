/**
 * @file test/bot-cycle-helpers.test.js
 * @description Unit tests for pure helper functions in bot-cycle.js:
 *   _humanizeError, _isTimeoutExpired, _isBeyondThreshold,
 *   _checkRangeAndThreshold, _reloadFromConfig, and _checkRebalanceGates.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  _humanizeError,
  _isTimeoutExpired,
  _isBeyondThreshold,
  _checkRangeAndThreshold,
  _checkZeroLiquidity,
  _reloadFromConfig,
  _checkRebalanceGates,
  _activateSwapBackoff,
  DRAINED_RETIRE_MS,
} = require("../src/bot-cycle");

// ── _humanizeError ──────────────────────────────────────────────────

describe("_humanizeError", () => {
  it("rewrites insufficient funds error", () => {
    const msg = _humanizeError(
      "execution reverted: insufficient funds for gas",
    );
    assert.ok(msg.includes("Wallet has insufficient gas"));
  });

  it("rewrites INSUFFICIENT_FUNDS constant", () => {
    const msg = _humanizeError("INSUFFICIENT_FUNDS");
    assert.ok(msg.includes("Wallet has insufficient gas"));
  });

  it("passes through unrecognized errors", () => {
    assert.strictEqual(_humanizeError("some other error"), "some other error");
  });

  it("passes through empty string", () => {
    assert.strictEqual(_humanizeError(""), "");
  });
});

// ── _isTimeoutExpired ───────────────────────────────────────────────

describe("_isTimeoutExpired", () => {
  it("returns true when timeout expired", () => {
    const bs = { oorSince: Date.now() - 200 * 60_000 };
    const gc = (k) => (k === "rebalanceTimeoutMin" ? 180 : undefined);
    assert.strictEqual(_isTimeoutExpired(bs, gc), true);
  });

  it("returns false when timeout not reached", () => {
    const bs = { oorSince: Date.now() - 10 * 60_000 };
    const gc = (k) => (k === "rebalanceTimeoutMin" ? 180 : undefined);
    assert.strictEqual(_isTimeoutExpired(bs, gc), false);
  });

  it("returns false when timeout is 0 (disabled)", () => {
    const bs = { oorSince: Date.now() - 999999999 };
    const gc = (k) => (k === "rebalanceTimeoutMin" ? 0 : undefined);
    assert.strictEqual(_isTimeoutExpired(bs, gc), false);
  });

  it("returns falsy when oorSince is null", () => {
    const bs = { oorSince: null };
    const gc = () => 180;
    assert.ok(!_isTimeoutExpired(bs, gc));
  });

  it("uses config default when gc returns undefined", () => {
    const bs = { oorSince: Date.now() - 1000 * 60_000 };
    const gc = () => undefined;
    // Default REBALANCE_TIMEOUT_MIN is 180
    assert.strictEqual(_isTimeoutExpired(bs, gc), true);
  });
});

// ── _isBeyondThreshold ──────────────────────────────────────────────

describe("_isBeyondThreshold", () => {
  const poolState = {
    price: 0.001,
    tick: -500,
    decimals0: 18,
    decimals1: 18,
  };

  it("returns true when threshold is 0", () => {
    const pos = { tickLower: -100, tickUpper: 100 };
    const gc = (k) =>
      k === "rebalanceOutOfRangeThresholdPercent" ? 0 : undefined;
    assert.strictEqual(_isBeyondThreshold(poolState, pos, gc), true);
  });

  it("returns true when price far beyond range", () => {
    // Create a pool state where price is way beyond the range
    const ps = { price: 100, tick: 200000, decimals0: 18, decimals1: 18 };
    const pos = { tickLower: -100, tickUpper: 100 };
    const gc = (k) =>
      k === "rebalanceOutOfRangeThresholdPercent" ? 10 : undefined;
    assert.strictEqual(_isBeyondThreshold(ps, pos, gc), true);
  });
});

// ── _checkRangeAndThreshold ─────────────────────────────────────────

describe("_checkRangeAndThreshold", () => {
  it("returns inRange when tick is within range", () => {
    const deps = {
      position: { tickLower: -100, tickUpper: 100 },
      _botState: { oorSince: null },
    };
    const poolState = { tick: 0 };
    const patches = [];
    const emit = (p) => patches.push(p);
    const r = _checkRangeAndThreshold(deps, poolState, emit);
    assert.ok(r);
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(r.inRange, true);
  });

  it("clears oorSince when returning to range", () => {
    const bs = { oorSince: Date.now() };
    const deps = {
      position: { tickLower: -100, tickUpper: 100 },
      _botState: bs,
    };
    const poolState = { tick: 0 };
    const patches = [];
    _checkRangeAndThreshold(deps, poolState, (p) => patches.push(p));
    assert.strictEqual(bs.oorSince, null);
    assert.ok(patches.some((p) => p.oorSince === null));
  });

  it("returns null (proceed) when forced", () => {
    const deps = {
      position: { tickLower: -100, tickUpper: 100 },
      _botState: { forceRebalance: true },
    };
    const poolState = { tick: 0 }; // in range, but forced
    const r = _checkRangeAndThreshold(deps, poolState, () => {});
    assert.strictEqual(r, null); // null means proceed to rebalance
  });
});

// ── _reloadFromConfig ───────────────────────────────────────────────

describe("_reloadFromConfig", () => {
  it("sets interval from config", () => {
    let newInterval = null;
    const gc = (k) => (k === "checkIntervalSec" ? 30 : undefined);
    const throttle = {
      configure: () => {},
    };
    _reloadFromConfig(gc, throttle, (ms) => (newInterval = ms));
    assert.strictEqual(newInterval, 30000);
  });

  it("does not set interval when config returns undefined", () => {
    let called = false;
    const gc = () => undefined;
    const throttle = { configure: () => {} };
    _reloadFromConfig(gc, throttle, () => (called = true));
    assert.strictEqual(called, false);
  });

  it("configures throttle from config", () => {
    let configured = null;
    const gc = (k) => {
      if (k === "minRebalanceIntervalMin") return 15;
      if (k === "maxRebalancesPerDay") return 10;
      return undefined;
    };
    const throttle = {
      configure: (opts) => (configured = opts),
    };
    _reloadFromConfig(gc, throttle, () => {});
    assert.ok(configured);
    assert.strictEqual(configured.minIntervalMs, 15 * 60_000);
    assert.strictEqual(configured.dailyMax, 10);
  });
});

// ── _checkRebalanceGates ────────────────────────────────────────────

describe("_checkRebalanceGates", () => {
  function makeDeps(overrides = {}) {
    return {
      throttle: {
        canRebalance: () => ({ allowed: true }),
        getState: () => ({ dailyMax: 20 }),
      },
      dryRun: false,
      _botState: {},
      position: { token0: "0xA", token1: "0xB", fee: 3000 },
      updateBotState: () => {},
      ...overrides,
    };
  }

  it("returns null when all gates pass", () => {
    const r = _checkRebalanceGates(makeDeps(), {}, false);
    assert.strictEqual(r, null);
  });

  it("returns paused when bot is paused", () => {
    const deps = makeDeps({ _botState: { rebalancePaused: true } });
    const r = _checkRebalanceGates(deps, {}, false);
    assert.ok(r);
    assert.strictEqual(r.paused, true);
  });

  it("ignores paused when forced", () => {
    const deps = makeDeps({ _botState: { rebalancePaused: true } });
    const r = _checkRebalanceGates(deps, {}, true);
    assert.strictEqual(r, null);
  });

  it("returns swap backoff when active", () => {
    const deps = makeDeps({
      _botState: { swapBackoffUntil: Date.now() + 60_000 },
    });
    const r = _checkRebalanceGates(deps, {}, false);
    assert.ok(r);
    assert.strictEqual(r.swapBackoff, true);
  });

  it("returns throttled when canRebalance is false", () => {
    const deps = makeDeps({
      throttle: {
        canRebalance: () => ({
          allowed: false,
          reason: "daily cap",
          msUntilAllowed: 5000,
        }),
        getState: () => ({}),
      },
    });
    const r = _checkRebalanceGates(deps, {}, false);
    assert.ok(r);
    assert.strictEqual(r.rebalanced, false);
  });

  it("returns dry run result in dry run mode", () => {
    const deps = makeDeps({ dryRun: true });
    const ps = { tick: 500 };
    const r = _checkRebalanceGates(deps, ps, false);
    assert.ok(r);
    assert.strictEqual(r.rebalanced, false);
  });

  it("checks pool daily cap when pool key functions provided", () => {
    const deps = makeDeps({
      _canRebalancePool: () => false,
      _poolKey: (t0, t1, f) => t0 + "-" + t1 + "-" + f,
    });
    const r = _checkRebalanceGates(deps, {}, false);
    assert.ok(r);
    assert.strictEqual(r.rebalanced, false);
  });

  it("passes pool daily cap when allowed", () => {
    const deps = makeDeps({
      _canRebalancePool: () => true,
      _poolKey: () => "key",
    });
    const r = _checkRebalanceGates(deps, {}, false);
    assert.strictEqual(r, null);
  });
});

// ── _activateSwapBackoff ────────────────────────────────────────────

describe("_activateSwapBackoff", () => {
  it("sets initial backoff of 60s on first call", () => {
    const state = { rebalanceInProgress: true };
    _activateSwapBackoff(state, null);
    assert.strictEqual(state.swapBackoffMs, 60_000);
    assert.ok(state.swapBackoffUntil > Date.now() - 1000);
    assert.strictEqual(state.swapBackoffAttempts, 1);
    assert.strictEqual(state.rebalanceInProgress, false);
  });

  it("doubles backoff on subsequent calls", () => {
    const state = { swapBackoffMs: 60_000, swapBackoffAttempts: 1 };
    _activateSwapBackoff(state, null);
    assert.strictEqual(state.swapBackoffMs, 120_000);
    assert.strictEqual(state.swapBackoffAttempts, 2);
  });

  it("caps backoff at 20 minutes", () => {
    const state = { swapBackoffMs: 15 * 60_000, swapBackoffAttempts: 4 };
    _activateSwapBackoff(state, null);
    assert.strictEqual(state.swapBackoffMs, 20 * 60_000);
  });

  it("pauses after max retry limit is reached", () => {
    // Default limit is from config.REBALANCE_RETRY_SWAP_LIMIT
    const state = { swapBackoffAttempts: 99 };
    let emitted = null;
    _activateSwapBackoff(state, (p) => (emitted = p));
    assert.strictEqual(state.rebalancePaused, true);
    assert.ok(state.rebalanceError);
    assert.ok(state.rebalanceError.includes("volatile"));
    assert.strictEqual(state.swapBackoffMs, 0);
    assert.ok(emitted);
    assert.strictEqual(emitted.rebalancePaused, true);
  });

  it("does not pause when below limit", () => {
    const state = { swapBackoffAttempts: 0 };
    _activateSwapBackoff(state, null);
    assert.strictEqual(state.rebalancePaused, undefined);
    assert.strictEqual(state.swapBackoffAttempts, 1);
  });
});

// ── _checkZeroLiquidity (drained-position retirement) ──────────────

describe("_checkZeroLiquidity drained retirement", () => {
  function depsWith(state, liquidity) {
    return {
      position: { tokenId: "123", liquidity, token0: "0xA", token1: "0xB" },
      _botState: state,
    };
  }

  it("arms drainedSince on first zero-liquidity poll", () => {
    const state = {};
    const t0 = Date.now();
    const r = _checkZeroLiquidity(depsWith(state, "0"));
    assert.deepStrictEqual(r, { rebalanced: false });
    assert.ok(state.drainedSince >= t0);
    assert.ok(!r.retired);
  });

  it("does NOT retire before the retirement window elapses", () => {
    const state = { drainedSince: Date.now() - 60_000 };
    const r = _checkZeroLiquidity(depsWith(state, "0"));
    assert.deepStrictEqual(r, { rebalanced: false });
  });

  it("signals retired once elapsed >= DRAINED_RETIRE_MS", () => {
    const state = { drainedSince: Date.now() - DRAINED_RETIRE_MS - 1000 };
    const r = _checkZeroLiquidity(depsWith(state, "0"));
    assert.strictEqual(r.retired, true);
    assert.strictEqual(r.rebalanced, false);
    assert.ok(r.drainedForMs >= DRAINED_RETIRE_MS);
  });

  it("does NOT arm the timer while a rebalance is in flight", () => {
    const state = { rebalanceInProgress: true };
    const r = _checkZeroLiquidity(depsWith(state, "0"));
    assert.deepStrictEqual(r, { rebalanced: false });
    assert.strictEqual(state.drainedSince, undefined);
  });

  it("does NOT retire when rebalanceInProgress even if drainedSince is stale", () => {
    /*- rebalanceInProgress takes precedence — we never retire a
     *  position whose old NFT is briefly at 0 liquidity mid-rebalance. */
    const state = {
      rebalanceInProgress: true,
      drainedSince: Date.now() - DRAINED_RETIRE_MS - 10_000,
    };
    const r = _checkZeroLiquidity(depsWith(state, "0"));
    assert.deepStrictEqual(r, { rebalanced: false });
  });

  it("clears drainedSince when position regains liquidity", () => {
    const state = { drainedSince: Date.now() - 1000 };
    const r = _checkZeroLiquidity(depsWith(state, "12345"));
    assert.strictEqual(r, null);
    assert.strictEqual(state.drainedSince, null);
  });

  it("does not arm the timer when forceRebalance is set", () => {
    const state = { forceRebalance: true };
    const r = _checkZeroLiquidity(depsWith(state, "0"));
    /*- forceRebalance skips the zero-liq early exit entirely so the
     *  rebalance pipeline can run on a drained NFT.  Retirement
     *  timer must not arm either. */
    assert.strictEqual(r, null);
    assert.strictEqual(state.drainedSince, undefined);
  });

  it("skips retirement when midway recovery is pending", () => {
    const state = { rebalanceFailedMidway: true };
    const r = _checkZeroLiquidity(depsWith(state, "0"));
    assert.strictEqual(r, null);
    assert.strictEqual(state.drainedSince, undefined);
  });

  it("DRAINED_RETIRE_MS is 30 minutes", () => {
    assert.strictEqual(DRAINED_RETIRE_MS, 30 * 60_000);
  });
});
