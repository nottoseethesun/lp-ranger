/**
 * @file test/rebalance-residual-warning.test.js
 * @description Tests that `_applyRebalanceResult` surfaces the
 *   `residualWarning` field from a rebalance result to the bot state
 *   patch, with an `at` timestamp for the dashboard's dedup logic.
 *   Split from bot-recorder.test.js for line-count compliance.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _applyRebalanceResult } = require("../src/bot-recorder");

describe("_applyRebalanceResult — residualWarning surfacing", () => {
  it("surfaces residualWarning from the rebalance result with a timestamp", () => {
    const position = { tokenId: "1" };
    const patches = [];
    const deps = {
      position,
      _rebalanceEvents: [],
      _botState: {},
      throttle: { getState: () => ({}) },
      updateBotState: (p) => patches.push(p),
    };
    _applyRebalanceResult(deps, {
      newTokenId: 2n,
      newTickLower: 0,
      newTickUpper: 0,
      amount0Minted: 0n,
      amount1Minted: 0n,
      residualWarning: {
        iterations: 3,
        imbalanceUsd: 31.8,
        thresholdUsd: 0.99,
      },
    });
    const warnPatch = patches.find((p) => p.residualWarning);
    assert.ok(warnPatch, "expected a patch containing residualWarning");
    assert.strictEqual(warnPatch.residualWarning.iterations, 3);
    assert.strictEqual(warnPatch.residualWarning.imbalanceUsd, 31.8);
    assert.strictEqual(warnPatch.residualWarning.thresholdUsd, 0.99);
    assert.ok(
      warnPatch.residualWarning.at,
      "residualWarning must include `at` timestamp for dedup",
    );
  });

  it("omits residualWarning when the result has none", () => {
    const position = { tokenId: "1" };
    const patches = [];
    const deps = {
      position,
      _rebalanceEvents: [],
      _botState: {},
      throttle: { getState: () => ({}) },
      updateBotState: (p) => patches.push(p),
    };
    _applyRebalanceResult(deps, {
      newTokenId: 2n,
      newTickLower: 0,
      newTickUpper: 0,
      amount0Minted: 0n,
      amount1Minted: 0n,
    });
    const warnPatch = patches.find((p) => p.residualWarning);
    assert.strictEqual(warnPatch, undefined);
  });
});
