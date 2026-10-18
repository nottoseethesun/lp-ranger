"use strict";

/**
 * @file test/operator-defaults-honoured.test.js
 * @description An operator's copy of `bot-config-defaults.json` under
 *   `app-config/user-configurable/` changes what the bot does, not only
 *   what Bot Settings shows.
 *
 *   Before, Bot Settings displayed an override of the default slippage,
 *   approval size, position offset or gas-fee limit while the bot went on
 *   using the shipped figure; the doubling rule could not be overridden
 *   at all. The user, 2026-10-17: "it should of course use the
 *   `user-configurable`". Each case reads a default through the module
 *   that acts on it, with an override file of the test's own in place,
 *   written before anything under `src/` loads, because the loader reads
 *   the override directory's path at load.
 *
 *   "No Override" is the one place an override must not reach: it re-uses
 *   the position's range re-centred, so its offset is centred whatever
 *   default the operator chose.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "operator-defaults-"));
const _OVERRIDE = path.join(_USER_DIR, "bot-config-defaults.json");
fs.writeFileSync(
  _OVERRIDE,
  JSON.stringify({
    slippagePct: 1.5,
    approvalMultiple: 7,
    offsetToken0Pct: 30,
    gasFeePct: 2,
    rangeOverrideEnabled: true,
    fullRangeRebalanceEnabled: true,
    throttleDoubling: {
      triggerCount: 2,
      triggerWindowMultiple: 6,
      quietWindowMultiple: 3,
    },
    positionBalancedBandPct: 5,
    positionBalancedCooldownMs: 600000,
    correctiveSwapMaxRounds: 2,
  }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { resolveSlippagePct } = require("../src/slippage-resolver");
const { buildRebalanceOpts } = require("../src/bot-cycle-opts");
const {
  resolveRangeOverrideEnabled,
  fullRangeSetting,
} = require("../src/range-override");
const { buildStatusPositions } = require("../src/build-status-positions");
const { MAX_SWAP_GAS_RATIO } = require("../src/swap-gates");
const { createThrottle } = require("../src/throttle");
const { CENTERED_OFFSET_PCT } = require("../src/centered-offset");
const { _MAX_ITERATIONS } = require("../src/rebalancer-correct");
const balanced = require("../src/telegram-notifications/balanced-notifier");
const { EVENT_LABELS } = require("../src/telegram-notifications/telegram");
const defaultsReader = require("../src/bot-config-defaults");
const mergedLoader = require("../src/load-merged-defaults");

/** Bot deps for one position whose saved settings are `saved`. */
function deps(saved = {}) {
  return {
    position: {
      tokenId: "1",
      token0: "0x" + "aa".repeat(20),
      token1: "0x" + "bb".repeat(20),
      fee: 3000,
    },
    _getConfig: (k) => saved[k],
  };
}

describe("an operator's default reaches the bot", () => {
  it("slippage, for a token with no figure of its own", () => {
    assert.equal(resolveSlippagePct({}, true), 1.5);
    assert.equal(resolveSlippagePct({ slippagePctToken1: 0.4 }, true), 0.4);
  });

  it("the approval size and position offset, for a rebalance", () => {
    const opts = buildRebalanceOpts(deps(), {});
    assert.equal(opts.approvalMultiple, 7);
    assert.equal(opts.offsetToken0Pct, 30);
  });

  it("the Range toggle's default, for a position never configured", () => {
    assert.equal(resolveRangeOverrideEnabled({}), true);
  });

  it("the Full-Range flag, for a position with none saved", () => {
    assert.equal(fullRangeSetting({}), true);
    assert.equal(
      buildRebalanceOpts(deps(), {}).fullRangeRebalanceEnabled,
      true,
    );
    const saved = buildRebalanceOpts(
      deps({ fullRangeRebalanceEnabled: false }),
      {},
    );
    assert.equal(saved.fullRangeRebalanceEnabled, undefined, "saved wins");
  });

  it("the Full-Range flag, as GET /api/status publishes it for the checkbox", () => {
    // One position the bot is running, and one it is not.
    const running = "pulsechain-0xW-0xPM-1";
    const stopped = "pulsechain-0xW-0xPM-2";
    const out = buildStatusPositions(
      { positions: { [running]: {}, [stopped]: { status: "stopped" } } },
      {},
      {},
      {},
      {
        getStates: () => new Map([[running, {}]]),
        attachPoolKeys: () => {},
      },
    );
    assert.equal(out[running].fullRangeRebalanceEnabled, true);
    assert.equal(out[stopped].fullRangeRebalanceEnabled, true);
  });

  it("the gas-fee limit, for a swap with no setting of its own", () => {
    assert.equal(MAX_SWAP_GAS_RATIO, 0.02);
  });

  it("the doubling rule, for the throttle", () => {
    let now = Date.UTC(2026, 9, 17, 12, 0, 0);
    const t = createThrottle({
      minIntervalMs: 60_000,
      dailyMax: 12,
      nowFn: () => now,
    });
    t.recordRebalance();
    now += 120_000;
    t.recordRebalance();
    assert.equal(
      t.getState().doublingActive,
      true,
      "two rebalances within six intervals start doubling",
    );
  });

  it("the position-balanced alert's band and quiet period", () => {
    assert.equal(balanced.BALANCED_THRESHOLD, 0.05);
    assert.equal(balanced.BALANCED_COOLDOWN_MS, 600000);
    assert.match(EVENT_LABELS.positionBalanced, /±5% of 50\/50/);
  });

  it("the corrective swap's round limit", () => {
    assert.equal(_MAX_ITERATIONS, 2);
  });
});

describe("No Override re-uses the range, centred", () => {
  it("pins the offset to centred, whatever the default", () => {
    const opts = buildRebalanceOpts(deps({ rangeOverrideEnabled: false }), {});
    assert.equal(opts.offsetToken0Pct, CENTERED_OFFSET_PCT);
    assert.notEqual(opts.offsetToken0Pct, 30);
  });

  it("leaves Full-Range off, whatever the default", () => {
    const opts = buildRebalanceOpts(deps({ rangeOverrideEnabled: false }), {});
    assert.equal(opts.fullRangeRebalanceEnabled, undefined);
  });

  it("still applies a saved offset under Use Settings Below", () => {
    const opts = buildRebalanceOpts(
      deps({ rangeOverrideEnabled: true, offsetToken0Pct: 70 }),
      {},
    );
    assert.equal(opts.offsetToken0Pct, 70);
  });
});

describe("an override of the doubling rule outside its range", () => {
  it("stops startup, naming the member, its range and the value", () => {
    fs.writeFileSync(
      _OVERRIDE,
      JSON.stringify({ throttleDoubling: { triggerCount: 1 } }),
    );
    mergedLoader._resetMemoForTests();
    defaultsReader._resetMemoForTests();
    assert.throws(
      () => defaultsReader.readBotConfigDefaultsStrict(),
      (err) => {
        assert.equal(err.badSettingValue, true);
        assert.match(
          err.message,
          /throttleDoubling\.triggerCount must be a whole number from 2 to 12; it is 1\./,
        );
        return true;
      },
    );
  });

  it("leaves the shipped rule standing on an ordinary read", () => {
    mergedLoader._resetMemoForTests();
    defaultsReader._resetMemoForTests();
    const shipped = mergedLoader.loadShippedDefaults(
      "bot-config-defaults.json",
    );
    assert.equal(
      defaultsReader.readBotConfigDefaults().throttleDoubling.triggerCount,
      shipped.throttleDoubling.triggerCount,
    );
  });
});
