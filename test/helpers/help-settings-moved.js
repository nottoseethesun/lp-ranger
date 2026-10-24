/**
 * @file test/helpers/help-settings-moved.js
 * @description The shipped settings with every value the help quotes
 *   moved off what ships, for the tests of the help's figures.
 *
 *   The help states the figures an install runs on: the manual's build
 *   reads them from the shipped files, and the server sends the
 *   dashboard the settings in force. A test that checks a figure against
 *   the shipped files themselves passes on copy that typed the shipped
 *   figure in, so these tests read a copy of the shipped folder
 *   (`useShippedDefaultsCopy`) holding other values, each different from
 *   what ships and from the others. The setting ranges stay as shipped,
 *   since no operator can change them.
 *
 *   Called before anything under src/lib/ or scripts/ that reads a settings
 *   file is required, since the loader reads the copy's path as it loads.
 */

"use strict";

const {
  useShippedDefaultsCopy,
  changeShippedCopy,
} = require("./shipped-defaults-copy");

/**
 * Point the settings loader at a copy of the shipped folder with every
 * value the help quotes moved, and return the changed files.
 *
 * @returns {{BOT: object, UI: object, RUNTIME: object, CHAINS: object}}
 *   bot-config-defaults.json, the server-up dashboard settings,
 *   app-runtime.json and chains.json, as the copy holds them.
 */
function useMovedHelpSettings() {
  const dir = useShippedDefaultsCopy();
  const BOT = changeShippedCopy(dir, "bot-config-defaults.json", {
    impermanentLossGuardPct: 22,
    rebalanceGasDeferPct: 0.7,
    gasDeferRetrySec: 5400,
    historyLookbackYears: 3,
    globalRPCRequestRateIntervalMS: 250,
    approvalMultiple: 12,
    maxRebalancesPerDay: 7,
    minRebalanceIntervalMin: 15,
    throttleDoubling: {
      triggerCount: 2,
      triggerWindowMultiple: 6,
      quietWindowMultiple: 3,
    },
    // 3 hours, then 6 and 12, under a 20-hour ceiling a fourth rung would pass.
    ilGuardRetry: { baseMs: 10800000, maxMs: 72000000 },
    checkIntervalSec: 240,
    slippagePct: 0.6,
    gasFeePct: 2,
    offsetToken0Pct: 40,
  });
  const UI = changeShippedCopy(
    dir,
    "ui-defaults_non-layout_for-server-up-scenario.json",
    {
      throttleNearLimitPct: 70,
      slippageConfirmAbovePct: 4,
      slippageTypedConfirmFromPct: 12,
    },
  );
  const RUNTIME = changeShippedCopy(dir, "app-runtime.json", {
    defaults: { chain: "pulsechain-testnet" },
    compound: { minFeeUsd: 2 },
    tx: { speedupSec: 150, deadlineSec: 600, cancelToDeadlineMultiple: 5 },
  });
  const CHAINS = changeShippedCopy(dir, "chains.json", {
    "pulsechain-testnet": {
      displayName: "A Chain of the Test's Own",
      aggregator: {
        url: "https://aggregator.example/api/943",
        name: "An Aggregator of the Test's Own",
      },
    },
  });
  return { BOT, UI, RUNTIME, CHAINS };
}

module.exports = { useMovedHelpSettings };
