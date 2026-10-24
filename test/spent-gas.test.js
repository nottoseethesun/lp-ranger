"use strict";

/**
 * @file test/spent-gas.test.js
 * @description Gas a failed move paid reaches the record.
 *
 * A rebalance or a compound can pay for transactions that do not complete
 * it: an approval mined before an aggregator quote that then fails, a swap
 * that reverts on chain, a cancel. `src/lib/spent-gas.js` carries that cost on
 * whatever the attempt ends with, and the cycle that ran the move records
 * it in the position's records when the move fails outright, apart from
 * the P&L periods a rebuild could drop (test/failed-move-gas.test.js
 * covers how the P&L counts it).
 *
 * Before, the open period was charged only when the failure was a
 * cancelled transaction. A rebalance that failed for any other reason
 * dropped the gas its swap attempts had paid, and a failed compound
 * dropped all of it, so the Per-Day gas and the lifetime gas read lower
 * than what the wallet paid. These tests pin each end of a failed move:
 * the module itself, the rebalance's failure result, the rebalance cycle,
 * and the compound. How a swap carries the figure from route to route is
 * `test/failed-attempt-gas.test.js`.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  spentGasOf,
  addSpentGas,
  recordSpentGas,
} = require("../src/lib/spent-gas");
const { createPnlTracker } = require("../src/lib/pnl-tracker");
const { executeRebalance } = require("../src/lib/rebalancer");
const {
  ADDR,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
} = require("./helpers/rebalancer-mocks");

/** A tracker with its open period started, as the bot keeps one. */
function openTracker() {
  const tracker = createPnlTracker();
  tracker.openEpoch({
    entryValue: 1000,
    entryPrice: 0.001,
    lowerPrice: 0.0005,
    upperPrice: 0.002,
  });
  return tracker;
}

/** An error as a failed move throws it, carrying the gas it paid. */
function failedWith(message, gasCostWei, extra = {}) {
  return Object.assign(new Error(message), { gasCostWei }, extra);
}

// ── The module ───────────────────────────────────────────────────────

describe("spentGasOf and addSpentGas", () => {
  it("reads nothing paid from an outcome that names no gas", () => {
    assert.equal(spentGasOf(new Error("quote refused")), 0n);
    assert.equal(spentGasOf({}), 0n);
  });

  it("adds to a result and to an error alike, and hands each back", () => {
    const result = { txHash: "0xswap", gasCostWei: 10n };
    assert.equal(addSpentGas(result, 5n), result);
    assert.equal(result.gasCostWei, 15n);

    const err = new Error("route stale");
    assert.equal(addSpentGas(err, 7n), err);
    assert.equal(err.gasCostWei, 7n);
    addSpentGas(err, 3n);
    assert.equal(err.gasCostWei, 10n, "a second layer adds, never replaces");
  });
});

describe("recordSpentGas", () => {
  const toUsd = async () => 0.25;

  it("records the charge, when it was paid, its wei and its dollars, and saves it at once", async () => {
    const writes = [];
    const before = Date.now();
    await recordSpentGas(
      21_000_000_000_000_000n,
      { _botState: {}, updateBotState: (p) => writes.push(p) },
      toUsd,
    );
    assert.equal(writes.length, 1, "saved at once: gas only accumulates");
    const [charge] = writes[0].failedMoveGas;
    assert.equal(charge.wei, "21000000000000000");
    assert.equal(charge.usd, 0.25);
    assert.ok(Date.parse(charge.at) >= before - 1000, charge.at);
  });

  it("keeps the charges already recorded", async () => {
    const prior = { at: "2026-10-01T00:00:00.000Z", wei: "5", usd: 0.1 };
    const writes = [];
    await recordSpentGas(
      7n,
      {
        _botState: { failedMoveGas: [prior] },
        updateBotState: (p) => writes.push(p),
      },
      toUsd,
    );
    assert.deepEqual(writes[0].failedMoveGas[0], prior);
    assert.equal(writes[0].failedMoveGas.length, 2);
  });

  it("still records the coins when there is no dollar price for them", async () => {
    /*-
     *  A chain without a price service, the testnet among them, prices
     *  every charge at zero. What was paid is still paid, so the coins are
     *  recorded and only the dollar figure is zero.
     */
    const writes = [];
    await recordSpentGas(
      21_000_000_000_000_000n,
      { _botState: {}, updateBotState: (p) => writes.push(p) },
      async () => 0,
    );
    const [charge] = writes[0].failedMoveGas;
    assert.equal(charge.usd, 0);
    assert.equal(charge.wei, "21000000000000000");
  });

  it("adds nothing to the open period, which a rebuild could drop", async () => {
    const tracker = openTracker();
    await recordSpentGas(
      21_000_000_000_000_000n,
      { _botState: {}, _pnlTracker: tracker, updateBotState: () => {} },
      toUsd,
    );
    assert.equal(tracker.getLiveEpoch().gas, 0);
    assert.equal(tracker.getLiveEpoch().gasNative, 0);
  });

  it("records nothing, and prices nothing, when nothing was paid", async () => {
    const writes = [];
    let priced = false;
    await recordSpentGas(
      0n,
      { _botState: {}, updateBotState: (p) => writes.push(p) },
      async () => {
        priced = true;
        return 0.25;
      },
    );
    assert.equal(writes.length, 0);
    assert.equal(priced, false, "no price lookup for a charge of nothing");
  });
});

/** The charges a run recorded: the last `failedMoveGas` it saved. */
function recorded(writes) {
  const saves = writes.filter((w) => w.failedMoveGas);
  return saves.length === 0 ? [] : saves.at(-1).failedMoveGas;
}

// ── The rebalance's failure result ───────────────────────────────────

describe("executeRebalance — a failure result carries the error's gas", () => {
  it("reports the gas the failing step's error says was paid", async () => {
    /*-
     *  The mint's transaction is stuck and cancelled, which is how
     *  `tx-speedup.js` ends one: an error marked `cancelled`, carrying the
     *  cancel's gas.
     */
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => {
        throw failedWith("Transaction cancelled after 60 min", 42n, {
          cancelled: true,
          cancelTxHash: "0xcancel",
        });
      },
    };
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      {
        position: {
          tokenId: 1n,
          token0: ADDR.token0,
          token1: ADDR.token1,
          fee: 3000,
          liquidity: 5000n,
          tickLower: -600,
          tickUpper: 600,
        },
        factoryAddress: ADDR.factory,
        positionManagerAddress: ADDR.pm,
        swapRouterAddress: ADDR.router,
        slippagePct: 0.5,
      },
    );
    assert.equal(r.success, false);
    assert.equal(r.cancelled, true);
    assert.equal(r.gasCostWei, 42n);
  });
});

// ── The cycles that record a failed move ─────────────────────────────

const PNL = require.resolve("../src/lib/bot-pnl-updater");
const REBALANCER = require.resolve("../src/lib/rebalancer");
const COMPOUNDER = require.resolve("../src/lib/compounder");
const CYCLE = require.resolve("../src/lib/bot-cycle");
const COMPOUND_CYCLE = require.resolve("../src/lib/bot-cycle-compound");

/**
 * Load a cycle module with chosen exports of its dependencies replaced.
 *
 * The cycle takes `actualGasCostUsd` and the move it runs by destructuring
 * them at load, so each test loads its own copy against stand-ins and puts
 * the real exports back before anything else can load them.
 *
 * @param {string} cyclePath  Resolved path of the cycle module.
 * @param {Object<string, object>} stand  Resolved path → exports to
 *   lay over that module's real ones.
 * @returns {object} The freshly loaded cycle module.
 */
function loadCycleWith(cyclePath, stand) {
  const saved = {};
  for (const [p, over] of Object.entries(stand)) {
    const real = require(p);
    saved[p] = require.cache[p].exports;
    require.cache[p].exports = { ...real, ...over };
  }
  delete require.cache[cyclePath];
  try {
    return require(cyclePath);
  } finally {
    for (const p of Object.keys(saved)) require.cache[p].exports = saved[p];
    delete require.cache[cyclePath];
  }
}

/** Bot deps for one position, recording what is written out. */
function cycleDeps(tracker, writes) {
  return {
    signer: { getAddress: async () => ADDR.signer },
    address: ADDR.signer,
    position: {
      tokenId: "77",
      token0: ADDR.token0,
      token1: ADDR.token1,
      fee: 3000,
      liquidity: "5000",
      tickLower: -600,
      tickUpper: 600,
    },
    throttle: { recordRebalance() {}, getState: () => ({ dailyCount: 0 }) },
    _botState: {},
    _pnlTracker: tracker,
    _getConfig: () => undefined,
    updateBotState: (p) => writes.push(p),
  };
}

describe("a failed rebalance records the gas it paid", () => {
  it("records the gas when nothing was cancelled", async () => {
    /*-
     *  The aggregator approved, its swap reverted on every attempt, and
     *  the V3 router then failed too: no transaction was cancelled, but
     *  the approval and the reverted swaps were mined and paid for.
     *  Before, only a cancelled failure was charged.
     */
    const { _executeAndRecord } = loadCycleWith(CYCLE, {
      [PNL]: { actualGasCostUsd: async () => 0.25 },
      [REBALANCER]: {
        executeRebalance: async () => ({
          success: false,
          error: "Swap quote failed: no pool liquidity",
          cancelled: false,
          cancelTxHash: null,
          gasCostWei: 21_000_000_000_000_000n,
          nonceUnsettled: false,
        }),
      },
    });
    const tracker = openTracker();
    const writes = [];
    const out = await _executeAndRecord(cycleDeps(tracker, writes), {});
    assert.equal(out.rebalanced, false);
    const [charge] = recorded(writes);
    assert.equal(charge.usd, 0.25);
    assert.equal(charge.wei, "21000000000000000");
    assert.equal(
      writes.filter((w) => w.failedMoveGas).length,
      1,
      "saved at once — no period closes behind a failed rebalance",
    );
    assert.equal(tracker.getLiveEpoch().gas, 0, "kept apart from the period");
  });

  it("still records a cancel's gas", async () => {
    const { _executeAndRecord } = loadCycleWith(CYCLE, {
      [PNL]: { actualGasCostUsd: async () => 0.1 },
      [REBALANCER]: {
        executeRebalance: async () => ({
          success: false,
          error: "Transaction cancelled after 60 min",
          cancelled: true,
          cancelTxHash: "0xcancel",
          gasCostWei: 1_000_000_000_000_000n,
          nonceUnsettled: false,
        }),
      },
    });
    const tracker = openTracker();
    const writes = [];
    await _executeAndRecord(cycleDeps(tracker, writes), {});
    assert.equal(recorded(writes)[0].usd, 0.1);
    assert.ok(
      writes.some((w) => w.txCancelled),
      "the cancel is still shown",
    );
  });
});

describe("a failed compound records the gas it paid", () => {
  it("records the gas the compound's error carries", async () => {
    /*-
     *  The collect landed, and the swap after it failed on both routes:
     *  the aggregator's approval was mined, and the router's quote was
     *  refused. The error carries what the swap attempts paid.
     */
    const { executeCompound } = loadCycleWith(COMPOUND_CYCLE, {
      [PNL]: { actualGasCostUsd: async () => 0.5 },
      [COMPOUNDER]: {
        executeCompound: async () => {
          throw failedWith(
            "Swap quote failed: no pool liquidity",
            2_000_000_000_000_000n,
          );
        },
      },
    });
    const tracker = openTracker();
    const writes = [];
    await executeCompound(
      cycleDeps(tracker, writes),
      { decimals0: 18, decimals1: 18, price: 1, tick: 0 },
      {},
      "auto",
    );
    assert.ok(
      writes.some((w) => w.compoundError),
      "the failure is shown",
    );
    const [charge] = recorded(writes);
    assert.equal(charge.usd, 0.5);
    assert.equal(charge.wei, "2000000000000000");
    assert.equal(tracker.getLiveEpoch().gas, 0, "kept apart from the period");
  });

  it("records the gas of a collect that found no fees to put back", async () => {
    /*-
     *  Skipped, not failed: the collect was mined and paid for, and the
     *  compound stopped there because there was nothing to deposit.
     */
    const { executeCompound } = loadCycleWith(COMPOUND_CYCLE, {
      [PNL]: { actualGasCostUsd: async () => 0.05 },
      [COMPOUNDER]: {
        executeCompound: async () => ({
          compounded: false,
          reason: "no_fees",
          gasCostWei: 500_000_000_000_000n,
        }),
      },
    });
    const tracker = openTracker();
    const writes = [];
    await executeCompound(
      cycleDeps(tracker, writes),
      { decimals0: 18, decimals1: 18, price: 1, tick: 0 },
      {},
      "auto",
    );
    const [charge] = recorded(writes);
    assert.equal(charge.usd, 0.05);
    assert.equal(charge.wei, "500000000000000");
  });
});

describe("a rebalance stopped for price volatility records the gas it paid", () => {
  it("records its drain's and swap's gas", async () => {
    /*-
     *  The price moved too far between the swap and the mint, so the
     *  rebalance stopped with its coins in the wallet: the drain and the
     *  swap were mined and paid for.
     */
    const { _executeAndRecord } = loadCycleWith(CYCLE, {
      [PNL]: { actualGasCostUsd: async () => 0.4 },
      [REBALANCER]: {
        executeRebalance: async () => ({
          success: false,
          priceVolatile: true,
          gasCostWei: 3_000_000_000_000_000n,
        }),
      },
    });
    const tracker = openTracker();
    const writes = [];
    const out = await _executeAndRecord(cycleDeps(tracker, writes), {});
    assert.equal(out.priceVolatile, true);
    const [charge] = recorded(writes);
    assert.equal(charge.usd, 0.4);
    assert.equal(charge.wei, "3000000000000000");
  });
});
