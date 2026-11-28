"use strict";

/**
 * @file test/rebalance-ends-on-failure.test.js
 * @description A rebalance comes off as under way however it ends, and a
 *   rebalance log the bot cannot read or write does not cut the
 *   rebalance's record-keeping short.
 *
 *   While a position is marked as rebalancing, every Clear Wallet and
 *   wallet import is refused (src/bot/under-way.js), so the mark comes
 *   off on every way out of a rebalance, a throw included. A failed read
 *   or write of the rebalance log is told, which stops LP Ranger, but cuts
 *   nothing short in the rebalance that met it, the move onto the new
 *   position included: the stop waits for that rebalance to finish. The rebalance cycle
 *   (`_executeAndRecord`, src/bot/bot-cycle.js) is driven here with the
 *   rebalance itself and the recorder's other writes stood in for.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { _setSinkForTests } = require("../src/lib/log");
const { useRebalanceLog } = require("./helpers/rebalance-log");
const { walletChangeRefusal } = require("../src/bot/under-way");
const { handleFileProblemsWith } = require("../src/lib/file-problem");

/*- The words each file failure was handed on in, this case. */
let _handed = [];

const REBALANCER = require.resolve("../src/bot/rebalancer");
const RECORDER = require.resolve("../src/bot/bot-recorder");
const TELEGRAM = require.resolve("../src/lib/telegram-notifications/telegram");
const PNL = require.resolve("../src/bot/bot-pnl-updater");
const CYCLE = require.resolve("../src/bot/bot-cycle");

const KEY =
  "pulsechain-0x1111111111111111111111111111111111111111-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-42";

/**
 * Load the cycle with chosen exports of its dependencies replaced, then
 * put the real exports back, as test/rebalance-success-alert.test.js does.
 */
function loadCycleWith(stand) {
  const saved = {};
  for (const [p, over] of Object.entries(stand)) {
    const real = require(p);
    saved[p] = require.cache[p].exports;
    require.cache[p].exports = { ...real, ...over };
  }
  delete require.cache[CYCLE];
  try {
    return require(CYCLE);
  } finally {
    for (const p of Object.keys(saved)) require.cache[p].exports = saved[p];
    delete require.cache[CYCLE];
  }
}

/** The cycle's view of one running position. */
function cycleDeps() {
  return {
    signer: { getAddress: async () => "0x" + "11".repeat(20) },
    position: {
      tokenId: "42",
      token0: "0x" + "aa".repeat(20),
      token1: "0x" + "bb".repeat(20),
      fee: 3000,
      liquidity: "5000",
      tickLower: -600,
      tickUpper: 600,
    },
    throttle: {
      recordRebalance() {},
      getState: () => ({ dailyCount: 1 }),
    },
    _botState: { running: true },
    _getConfig: () => undefined,
    updateBotState: () => {},
  };
}

let _restoreSink = null;

beforeEach(() => {
  _handed = [];
  /*-
   *  TEST-ONLY: the cycle's log lines are kept off the test's output,
   *  through the log module's own seam, and the handler a program sets
   *  for file failures (its stop) is a stand-in; both put back in
   *  `afterEach`.
   */
  _restoreSink = _setSinkForTests({
    log: () => {},
    warn: () => {},
    error: () => {},
  });
  handleFileProblemsWith((words) => _handed.push(words));
});

afterEach(() => {
  _restoreSink();
  handleFileProblemsWith(null);
});

describe("a rebalance that fails partway", () => {
  it("comes off as under way when it throws, so a Clear and an import are not refused", async () => {
    const { _executeAndRecord } = loadCycleWith({
      [REBALANCER]: {
        executeRebalance: async () => {
          throw new Error("the swap's nonce is unsettled");
        },
      },
    });
    const deps = cycleDeps();
    await assert.rejects(_executeAndRecord(deps, {}), /nonce is unsettled/);
    assert.equal(deps._botState.rebalanceInProgress, false);
    const states = new Map([[KEY, deps._botState]]);
    assert.equal(walletChangeRefusal(states, [], "Clear Wallet"), null);
  });
});

describe("a rebalance whose log cannot be read or written", () => {
  it("still moves the bot onto the new position, and tells the operator", async () => {
    const applied = [];
    const { _executeAndRecord } = loadCycleWith({
      [REBALANCER]: {
        executeRebalance: async () => ({
          success: true,
          newTokenId: 43n,
          oldTokenId: 42n,
          txHashes: ["0xdrain", "0xmint"],
          gasCostWei: 0n,
        }),
        enrichResultUsd: async () => {},
      },
      [RECORDER]: {
        _closePnlEpoch: async () => {},
        _recordResidual: () => {},
        _applyRebalanceResult: (_deps, result) => applied.push(result),
      },
      [PNL]: { fetchTokenPrices: async () => ({ price0: 1, price1: 1 }) },
      [TELEGRAM]: { notify: () => {} },
    });
    // A folder where the log should be: it can be neither read nor written.
    const file = path.join(
      makeTestTempFolder("rebalance-ends-on-failure"),
      "rebalance_log.json",
    );
    fs.mkdirSync(file);
    const restoreLog = useRebalanceLog(file);
    const deps = cycleDeps();
    try {
      const out = await _executeAndRecord(deps, {});
      assert.equal(out.rebalanced, true);
    } finally {
      restoreLog();
    }
    assert.equal(applied.length, 1, "on to the new position");
    assert.equal(deps._botState.rebalanceInProgress, false);
    assert.ok(
      _handed.some((w) => /could not read its rebalance log/.test(w)),
      "told, which stops LP Ranger",
    );
  });
});
