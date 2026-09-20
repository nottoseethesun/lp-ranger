/**
 * @file test/bot-recorder-lifetime.test.js
 * @description Regression tests for `_scanLifetimePoolData`'s early-exit
 *   logic.  Disk values for `compoundedAmount0`/`compoundedAmount1` are
 *   treated as source-of-truth — once present, classification must NOT
 *   re-run; the compound and rebalance paths keep the saved coins
 *   current.  See `_resolveDiskState` in `src/bot-recorder-lifetime.js`
 *   for the full reasoning.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { PoolStateInvalidError } = require("../src/pool-state-validate");

const Module = require("module");
const {
  state,
  resetState,
  installMocks,
  restoreMocks,
  makePosition,
  makeBotState,
  origRequire,
  poolStateMock,
  errorLogMock,
  evictLifetimeModules,
} = require("./helpers/bot-recorder-lifetime-mocks");

describe("_scanLifetimePoolData — disk-as-source-of-truth", () => {
  let _scanLifetimePoolData;

  beforeEach(() => {
    resetState();
    installMocks();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  it("returns early when compound + hodl + deposit are all present on disk", async () => {
    const botState = makeBotState({
      compoundedAmount0: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.scanCalled, false, "fetchAllNftEvents must not run");
    assert.equal(state.classifyCalled, false, "classifyCompounds must not run");
    assert.equal(state.depositCalled, false, "computeDepositUsd must not run");
  });

  it("re-classifies a config that has compoundHistory but no coins", async () => {
    /*-
     *  This is every config written before compounds were stored as
     *  coins: the bot's scans wrote `compoundHistory` alongside a dollar
     *  total, so history is present and the coins are not.
     *
     *  Accepting history as "already known" would leave those positions
     *  with nothing to price and report Fees Compounded as $0 — a live
     *  figure in the hundreds of dollars, gone. One re-classification
     *  from chain fills the coins, and every scan after it returns early.
     */
    const botState = makeBotState({
      compoundHistory: [{ trigger: "auto", usdValue: 5 }],
      totalLifetimeDepositUsd: 1704.15,
    });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.classifyCalled, true, "must re-read the chain once");
  });

  it("runs classification + deposit when neither disk signal is present", async () => {
    const botState = makeBotState({});
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.scanCalled, true, "fetchAllNftEvents must run");
    assert.equal(state.classifyCalled, true, "classifyCompounds must run");
    assert.equal(state.depositCalled, true, "computeDepositUsd must run");
  });

  it("skips classification when the saved coins are 0 — a recorded zero is an answer", async () => {
    /*-
     *  A chain whose NFTs never compounded totals zero, and the scan that
     *  found that out wrote it. Re-deriving it means walking the whole
     *  chain again to arrive back at zero, on every scan, for as long as
     *  the position runs. Only ABSENCE means "not asked yet" — see
     *  `hasCompoundedTotal` in bot-config-keys.js.
     */
    const botState = makeBotState({ compoundedAmount0: 0 });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.classifyCalled, false);
  });

  it("runs classification when the saved coins are absent", async () => {
    /*- The counterpart: nothing recorded, so the chain has not been
     *  classified and the walk is owed. */
    const botState = makeBotState({});
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.classifyCalled, true);
  });

  it("runs classification when botState._getConfig is missing entirely (regression guard)", async () => {
    /*-
     *  If a future refactor drops the `botState._getConfig = gc` wiring in
     *  `startBotLoop`, the disk-as-source-of-truth gate falls back to
     *  "no signal" and classification runs.  That's strictly worse than
     *  the wired path: every scan then re-reads the chain and recomputes
     *  the saved totals.  But it's the only behavior the unit can express
     *  on its own.
     *
     *  The integration contract — that `startBotLoop` actually wires
     *  `_getConfig` — is asserted in test/bot-loop.test.js's
     *  `wireBotStateGetConfig` suite (the helper itself lives in
     *  src/bot-state-init.js).  These two tests together close the gap
     *  that let the original bug ship green.
     */
    const botState = {}; // no _getConfig — simulates broken wiring
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.classifyCalled, true);
  });

  it("does NOT short-circuit when disk has the coins but cachedHodl is missing", async () => {
    /*-
     *  Hodl still needs computing the first time even if compounds are
     *  already known — only the *combined* condition skips work.
     */
    state.cachedHodl = null;
    const botState = makeBotState({
      compoundedAmount0: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.scanCalled, true, "fetch runs to feed hodl computation");
    assert.equal(
      state.classifyCalled,
      false,
      "but classification still skipped — disk total is authoritative",
    );
    assert.equal(
      state.depositCalled,
      false,
      "deposit recompute still skipped — disk total is authoritative",
    );
  });

  // ── Deposit-side guard ──────────────────────────────────────────────────────
  /*-
   *  These mirror the compound-side tests above but focus on the
   *  `totalLifetimeDepositUsd` disk total: a saved total is kept, and
   *  `computeDepositUsd` runs only when none is saved.
   *  See `_resolveDiskState` JSDoc, item 2.
   */
  it("skips computeDepositUsd when totalLifetimeDepositUsd > 0 on disk", async () => {
    /*-
     *  cachedHodl missing forces the function past the early-return so
     *  the deposit-skip branch is exercised in isolation.
     */
    state.cachedHodl = null;
    const botState = makeBotState({
      compoundedAmount0: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.depositCalled, false, "computeDepositUsd must not run");
  });

  it("runs computeDepositUsd when totalLifetimeDepositUsd is 0 (zero-or-undefined treated alike)", async () => {
    state.cachedHodl = null;
    const botState = makeBotState({
      compoundedAmount0: 148.38,
      totalLifetimeDepositUsd: 0,
    });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.depositCalled, true);
  });

  it("runs computeDepositUsd when totalLifetimeDepositUsd is missing", async () => {
    state.cachedHodl = null;
    const botState = makeBotState({ compoundedAmount0: 148.38 });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.depositCalled, true);
  });

  it("does NOT short-circuit when disk has compound + deposit but cachedHodl is missing", async () => {
    /*-
     *  All three disk gates must align for the early return.  Compound +
     *  deposit on disk without cached hodl means the scan still runs to
     *  produce hodl, but neither classify nor deposit recompute fire.
     */
    state.cachedHodl = null;
    const botState = makeBotState({
      compoundedAmount0: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.scanCalled, true, "fetch runs to feed hodl computation");
    assert.equal(state.classifyCalled, false);
    assert.equal(state.depositCalled, false);
  });

  it("stamps _retireReason and aborts the scan when a decimals field is invalid", async () => {
    state.poolStateResult = new PoolStateInvalidError(
      "decimals0",
      undefined,
      "https://rpc",
    );
    const botState = makeBotState({});
    botState._needsFullRescan = true; // force the heal step to run
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    /*- Heal hit a decimals-field validation failure: the scan must stamp the
     *  reason for the poll cycle's checkRetireRequest, write a durable
     *  error.log entry, and abort before any valuation. */
    assert.match(botState._retireReason, /unreadable\/invalid on-chain/);
    assert.ok(
      state.errorLogCalls.some((c) => c.fn === "write"),
      "unhealable decimals must be written to error.log",
    );
    assert.equal(
      state.scanCalled,
      false,
      "scan must abort before fetching events",
    );
    assert.equal(state.classifyCalled, false);
    assert.equal(state.depositCalled, false);
  });
});

// ── Rescan flag + scan-error state tracking ─────────────────────────

describe("_scanLifetimePoolData — rescan flag + error tracking", () => {
  let _scanLifetimePoolData;
  let _shouldThrow = false;

  function _installMocksThrowingHodl() {
    Module.prototype.require = function (id) {
      if (id === "./epoch-cache") {
        return { getCachedLifetimeHodl: () => state.cachedHodl };
      }
      if (id === "./bot-pnl-updater") {
        return {
          fetchTokenPrices: async () => ({ price0: 1, price1: 1 }),
          actualGasCostUsd: async () => 0,
        };
      }
      if (id === "./compounder") {
        return {
          classifyCompounds: async () => ({
            compounds: [],
            totalCompoundedUsd: 0,
            totalGasWei: "0",
          }),
        };
      }
      if (id === "./lifetime-hodl") {
        return { computeLifetimeHodl: async () => ({}) };
      }
      if (id === "./bot-hodl-scan") {
        return {
          computeAndCacheHodl: async () => {
            if (_shouldThrow) throw new Error("simulated Moralis quota error");
            return {};
          },
          computeDepositUsd: async () => {},
        };
      }
      if (id === "./pool-creation-block") {
        return { resolvePoolCreationBlockForPosition: async () => 0 };
      }
      if (id === "./bot-recorder-scan-helpers") {
        return {
          collectTokenIds: () => new Set([1]),
          fetchAllNftEvents: async () => new Map([[1, []]]),
        };
      }
      /*- The scan heals decimals via getPoolState before valuing; stub it so
       *  full-rescan tests never reach a real RPC. pool-state-validate stays
       *  REAL (no mirror of its predicates). */
      if (id === "./rebalancer-pools") return poolStateMock();
      if (id === "./error-log") return errorLogMock();
      return origRequire.apply(this, arguments);
    };
    evictLifetimeModules();
  }

  beforeEach(() => {
    _shouldThrow = false;
    resetState();
    /*- No cached HODL, so `computeAndCacheHodl` actually runs — that is
     *  the call this suite makes throw.  Must come AFTER resetState(),
     *  which restores the default cached value. */
    state.cachedHodl = null;
    _installMocksThrowingHodl();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  it("clears _needsFullRescan + _lifetimeScanError on successful scan", async () => {
    const patches = [];
    const botState = makeBotState({});
    botState._needsFullRescan = true;
    botState._lifetimeScanError = "prior failure";
    botState._lifetimeScanErrorAt = 12345;
    /*- Total > 0 means the success path flips lifetimeScanComplete to
     *  true; the next test covers the total=0 case. */
    botState.totalLifetimeDepositUsd = 1713.93;
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      (p) => patches.push(p),
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(botState._needsFullRescan, false);
    assert.equal(botState._lifetimeScanError, null);
    assert.equal(botState._lifetimeScanErrorAt, null);
    assert.equal(botState.lifetimeScanComplete, true);
    /*- A resolved heal (decimals OK) self-clears any stale error.log entry. */
    assert.ok(
      state.errorLogCalls.some((c) => c.fn === "clear"),
      "a resolved full-rescan heal self-clears error.log",
    );
    /*- The cleared state must also propagate to the per-position state
     *  map via updateState() so /api/status reflects the recovery. */
    const cleared = patches.find((p) => p._lifetimeScanError === null);
    assert.ok(cleared, "updateState must be called with cleared error fields");
    const ready = patches.find((p) => p.lifetimeScanComplete === true);
    assert.ok(ready, "updateState must propagate lifetimeScanComplete: true");
  });

  it("keeps lifetimeScanComplete=false when scan succeeds with zero total", async () => {
    /*- A successful scan that produces no positive total (price-fetch
     *  silent failure, empty rebalance chain, etc.) is not a useful
     *  completion.  The flag must stay false so the Syncing badge stays
     *  engaged and the 30-min auto-rescan keeps retrying. */
    const patches = [];
    const botState = makeBotState({});
    botState.totalLifetimeDepositUsd = 0;
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      (p) => patches.push(p),
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(botState.lifetimeScanComplete, false);
    const notReady = patches.find((p) => p.lifetimeScanComplete === false);
    assert.ok(
      notReady,
      "updateState must propagate lifetimeScanComplete: false",
    );
  });

  it("records _lifetimeScanError and timestamp when a scan step throws", async () => {
    _shouldThrow = true;
    const patches = [];
    const botState = makeBotState({});
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      (p) => patches.push(p),
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(botState._lifetimeScanError, "simulated Moralis quota error");
    assert.ok(
      Number.isFinite(botState._lifetimeScanErrorAt),
      "_lifetimeScanErrorAt should be a numeric timestamp",
    );
    /*- Failure path must also push lifetimeScanComplete back to false
     *  defensively (e.g. when a prior scan flipped it true and a
     *  subsequent post-rebalance re-scan failed). */
    assert.equal(botState.lifetimeScanComplete, false);
    const recorded = patches.find(
      (p) => p._lifetimeScanError === "simulated Moralis quota error",
    );
    assert.ok(recorded, "updateState must propagate the error to state map");
    const notReady = patches.find((p) => p.lifetimeScanComplete === false);
    assert.ok(
      notReady,
      "updateState must propagate lifetimeScanComplete: false on failure",
    );
  });

  it("honors _needsFullRescan by bypassing the disk-fully-populated early-return", async () => {
    state.cachedHodl = { poolAddress: "0xPOOL" };
    const botState = makeBotState({
      compoundedAmount0: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    botState._needsFullRescan = true;
    let depositCalled = false;
    /*- Re-mock just the deposit path so we can detect it ran. */
    const origRequire2 = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === "./bot-hodl-scan") {
        return {
          computeAndCacheHodl: async () => ({}),
          computeDepositUsd: async () => {
            depositCalled = true;
          },
        };
      }
      return origRequire2.apply(this, arguments);
    };
    evictLifetimeModules();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    /*- With the flag set, computeDepositUsd must run even though
     *  totalLifetimeDepositUsd > 0 on disk — the flag is the override
     *  that lets a post-rebalance scan re-classify the chain. */
    assert.equal(depositCalled, true);
  });
});
