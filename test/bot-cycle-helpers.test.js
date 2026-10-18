/**
 * @file test/bot-cycle-helpers.test.js
 * @description Unit tests for pure helper functions in bot-cycle.js:
 *   _humanizeError, _checkRangeAndThreshold, and _checkRebalanceGates
 *   (src/bot-cycle.js), plus _isTimeoutExpired, _isBeyondThreshold,
 *   and _reloadFromConfig (src/bot-cycle-triggers.js).
 */

"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const {
  _humanizeError,
  _checkRangeAndThreshold,
  _checkZeroLiquidity,
  _checkRebalanceGates,
  _activateSwapBackoff,
  _liquidityChanged,
} = require("../src/bot-cycle");
const config = require("../src/config");
const { loadMergedDefaults } = require("../src/load-merged-defaults");
const {
  EVENT_DEFAULTS,
} = require("../src/telegram-notifications/telegram-events");
const { DRAINED_RETIRE_MS, SWAP_BACKOFF_BASE_MS, SWAP_BACKOFF_MAX_MS } = config;
const {
  _isTimeoutExpired,
  _isBeyondThreshold,
  _reloadFromConfig,
} = require("../src/bot-cycle-triggers");

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

// ── The OOR Timeout alert ───────────────────────────────────────────

describe("the OOR Timeout alert", () => {
  const tg = require("../src/telegram-notifications/telegram");
  const realFetch = globalThis.fetch;
  /*-
   *  The OOR Timeout messages sent, caught at the fetch the telegram
   *  module makes.
   */
  let sent;
  beforeEach(() => {
    sent = [];
    globalThis.fetch = async (_url, opts) => {
      const text = JSON.parse(opts.body).text;
      if (text.includes("OOR Timeout Triggered")) sent.push(text);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    tg.setBotToken("tok");
    tg.setChatId("123");
    tg.setEnabledEvents(EVENT_DEFAULTS);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    tg.setBotToken(null);
    tg.setChatId(null);
  });

  /*-
   *  Ninety minutes and 7%, off the shipped 180 and 5, so the test cannot
   *  pass on the defaults.
   */
  const gc = (k) =>
    ({ rebalanceTimeoutMin: 90, rebalanceOutOfRangeThresholdPercent: 7 })[k];
  const position = {
    tokenId: 1,
    fee: 3000,
    token0: "0xA",
    token1: "0xB",
    tickLower: -100,
    tickUpper: 100,
  };
  /*-
   *  Just above the range and inside the threshold, so only the timeout
   *  can trigger the rebalance.
   */
  const outOfRange = { tick: 105, price: 1.0105, decimals0: 18, decimals1: 18 };
  const inRange = { tick: 0, price: 1, decimals0: 18, decimals1: 18 };

  /** One poll at `iso`, then let the alert's send run. */
  async function pollAt(bs, iso, poolState = outOfRange) {
    mock.method(Date, "now", () => Date.parse(iso));
    _checkRangeAndThreshold(
      { position, _botState: bs, _getConfig: gc },
      poolState,
      () => {},
    );
    mock.restoreAll();
    await new Promise((r) => setImmediate(r));
  }

  it("goes out once, not on every poll while the rebalance is held", async () => {
    /*-
     *  Each poll after the timeout is one the daily cap, the throttle,
     *  the Guard or a gas wait held; before the fix each sent the alert.
     */
    const bs = { oorSince: Date.parse("2026-10-18T10:00:00Z") };
    for (const iso of [
      "2026-10-18T12:00:00Z",
      "2026-10-18T12:05:00Z",
      "2026-10-18T18:00:00Z",
    ])
      await pollAt(bs, iso);
    assert.equal(sent.length, 1);
  });

  it("goes out again once a new UTC day begins, while the spell lasts", async () => {
    const bs = { oorSince: Date.parse("2026-10-18T20:00:00Z") };
    await pollAt(bs, "2026-10-18T23:50:00Z");
    await pollAt(bs, "2026-10-18T23:55:00Z");
    assert.equal(sent.length, 1);
    // Twenty minutes later, but past midnight UTC.
    await pollAt(bs, "2026-10-19T00:10:00Z");
    assert.equal(sent.length, 2);
  });

  it("goes out for each new out-of-range spell, the same day included", async () => {
    const bs = { oorSince: Date.parse("2026-10-18T08:00:00Z") };
    await pollAt(bs, "2026-10-18T10:00:00Z");
    assert.equal(sent.length, 1);
    /*-
     *  Back in range ends the spell. Out again at 11:10 starts a new one,
     *  whose ninety minutes run out at 12:40.
     */
    await pollAt(bs, "2026-10-18T11:00:00Z", inRange);
    await pollAt(bs, "2026-10-18T11:10:00Z");
    await pollAt(bs, "2026-10-18T12:45:00Z");
    assert.equal(sent.length, 2);
  });
});

// ── _reloadFromConfig ───────────────────────────────────────────────

describe("_reloadFromConfig", () => {
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
    _reloadFromConfig(gc, throttle);
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

  it("returns scanRunning when _scanRunning is true", () => {
    /*- Reload / initial-scan gate: while `_triggerScan` is running,
     *  the position's on-chain-derived state is being rebuilt.  An
     *  auto-rebalance fired mid-scan would race the reconstruction
     *  and re-corrupt the very numbers the reload is trying to fix. */
    const deps = makeDeps({ _botState: { _scanRunning: true } });
    const r = _checkRebalanceGates(deps, {}, false);
    assert.ok(r);
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(r.scanRunning, true);
  });

  it("ignores scanRunning when forced (manual rebalance during scan)", () => {
    /*- Manual (user-clicked) rebalance still bypasses the scan gate.
     *  If the user explicitly clicks Rebalance while a scan is
     *  running, that's their call. */
    const deps = makeDeps({ _botState: { _scanRunning: true } });
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
  it("waits tx.swapBackoffBaseMs on the first call", () => {
    const state = { rebalanceInProgress: true };
    _activateSwapBackoff(state, null);
    assert.strictEqual(state.swapBackoffMs, SWAP_BACKOFF_BASE_MS);
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

  it("caps backoff at tx.swapBackoffMaxMs", () => {
    const state = {
      swapBackoffMs: SWAP_BACKOFF_MAX_MS - 1000,
      swapBackoffAttempts: 4,
    };
    _activateSwapBackoff(state, null);
    assert.strictEqual(state.swapBackoffMs, SWAP_BACKOFF_MAX_MS);
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

  it("takes the retire wait from app-runtime.json's retire.drainedAfterMs", () => {
    assert.strictEqual(
      DRAINED_RETIRE_MS,
      loadMergedDefaults("app-runtime.json").retire.drainedAfterMs,
    );
  });
});

// ── _liquidityChanged ────────────────────────────────────────────────

describe("_liquidityChanged", () => {
  /*- Guards the pollCycle activePosition re-emit that fixes the "Open
   *  Positions badge stale on drain" bug.  `null`/`undefined` normalise
   *  to "0" via explicit `!== undefined && !== null` checks (not the
   *  `x || 0` type-conversion trick, per the "Type Checks" rule in
   *  CLAUDE-BEST-PRACTICES.md) so a first-poll snapshot of an
   *  uninitialised position doesn't spuriously trigger the emit. */
  it("true when liquidity drops to zero (drain)", () => {
    assert.strictEqual(_liquidityChanged("12345", "0"), true);
  });

  it("true when liquidity re-mints from zero", () => {
    assert.strictEqual(_liquidityChanged("0", "9876"), true);
  });

  it("true when a non-zero liquidity changes value (compound)", () => {
    assert.strictEqual(_liquidityChanged("1000", "1500"), true);
  });

  it("false when liquidity is unchanged (steady state)", () => {
    assert.strictEqual(_liquidityChanged("12345", "12345"), false);
  });

  it("false when both readings are zero (stays drained)", () => {
    assert.strictEqual(_liquidityChanged("0", "0"), false);
  });

  it("treats null as zero (missing prev on first poll)", () => {
    assert.strictEqual(_liquidityChanged(null, "0"), false);
    assert.strictEqual(_liquidityChanged(null, "1000"), true);
  });

  it("treats undefined as zero", () => {
    assert.strictEqual(_liquidityChanged(undefined, "0"), false);
    assert.strictEqual(_liquidityChanged("0", undefined), false);
  });

  it("compares BigInt against post-refresh String (first-poll type transition)", () => {
    /*- Detected position has liquidity as BigInt (from _detectPosition);
     *  _refreshPosition rewrites to String on first poll.  Same numeric
     *  value across the transition must NOT trigger a spurious emit. */
    assert.strictEqual(_liquidityChanged(12345n, "12345"), false);
    assert.strictEqual(_liquidityChanged(0n, "0"), false);
    assert.strictEqual(_liquidityChanged(12345n, "0"), true);
  });

  it("normalises number 0 and string '0' to the same reading", () => {
    assert.strictEqual(_liquidityChanged(0, "0"), false);
    assert.strictEqual(_liquidityChanged("0", 0), false);
  });
});
