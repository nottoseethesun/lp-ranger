/**
 * @file test/bot-recorder-rebalance-scan-trigger.test.js
 * @description `_applyRebalanceResult`'s post-rebalance path: the scan
 *   trigger and the epoch-cache clears it performs.
 *
 *   Kept apart from test/bot-recorder.test.js so that file stays under
 *   the 500-line cap. The epoch cache is redirected to a file in a
 *   temporary directory for the duration and restored afterwards — see
 *   the `after` hook.
 */

"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── _applyRebalanceResult: post-rebalance cache clears ─────────────

describe("_applyRebalanceResult — post-rebalance scan trigger", () => {
  const { _applyRebalanceResult } = require("../src/bot-recorder");
  const epochCache = require("../src/epoch-cache");

  // An isolated cache file, outside the project's tmp/.
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "arr-epochs-"));
  epochCache._setCachePath(path.join(isolatedDir, "pnl-epochs-cache.json"));

  /*-
   *  Put the module's path back and remove the directory. The path is a
   *  module-level singleton, so leaving it redirected would send any
   *  later test in this process to the isolated file.
   */
  after(() => {
    epochCache._setCachePath(
      path.join(process.cwd(), "tmp", "pnl-epochs-cache.json"),
    );
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  });

  /** Build a unique key so each test is independent. */
  function uniqKey(suffix) {
    return {
      contract: `0xCC${suffix}`,
      wallet: `0xWW${suffix}`,
      token0: `0xT0${suffix}`,
      token1: `0xT1${suffix}`,
      fee: 2500,
    };
  }

  /** Standard deps/result shape that reaches the post-rebalance branch. */
  function makeDeps(key) {
    return {
      position: { tokenId: "100", tickLower: 0, tickUpper: 0 },
      _rebalanceEvents: [],
      _botState: { oorSince: Date.now() },
      _pnlTracker: { _epochKey: key },
      throttle: { getState: () => ({}) },
      updateBotState: () => {},
    };
  }

  const result = {
    newTokenId: 200n,
    newTickLower: -100,
    newTickUpper: 100,
    amount0Minted: 0n,
    amount1Minted: 0n,
  };

  it("REGRESSION: does NOT null lifetimeHodl/freshDeposits/lastNftScanBlock on disk", () => {
    /*- Earlier implementation wrote `null` to all three fields on every
     *  rebalance and relied on the subsequent `_triggerScan` to repopulate.
     *  When that scan failed silently (Moralis quota exhausted, RPC
     *  hiccup, swallowed catch in bot-recorder-lifetime), the cache
     *  stayed at null forever — the dashboard then fell through to
     *  `closedEpochs[0].entryValue` and surfaced a wrong Total Lifetime
     *  Deposit indefinitely.  See bot-recorder.js:_applyRebalanceResult
     *  and the `_needsFullRescan` flag pattern. */
    const key = uniqKey("A");
    epochCache.setLastNftScanBlock(key, 26_312_976);
    epochCache.setCachedLifetimeHodl(key, { amount0: 100, amount1: 200 });
    epochCache.setCachedFreshDeposits(key, {
      raw0: "1",
      raw1: "2",
      lastBlock: 26_312_976,
    });
    _applyRebalanceResult(makeDeps(key), result);
    assert.strictEqual(
      epochCache.getLastNftScanBlock(key),
      26_312_976,
      "lastNftScanBlock must NOT be reset — _needsFullRescan flag drives the next scan instead",
    );
    assert.ok(
      epochCache.getCachedLifetimeHodl(key),
      "lifetimeHodlAmounts must NOT be nulled — old data is strictly better than null until the next scan succeeds",
    );
    assert.ok(
      epochCache.getCachedFreshDeposits(key),
      "freshDeposits must NOT be nulled — same reasoning",
    );
  });

  it("sets _needsFullRescan=true on botState so the next scan re-classifies the chain", () => {
    const key = uniqKey("B");
    const deps = makeDeps(key);
    assert.strictEqual(deps._botState._needsFullRescan, undefined);
    _applyRebalanceResult(deps, result);
    assert.strictEqual(deps._botState._needsFullRescan, true);
  });

  it("does NOT zero in-memory lifetimeHodlAmounts/totalLifetimeDepositUsd mirrors", () => {
    /*- The pre-rebalance in-memory values are stale-but-non-null after a
     *  rebalance.  Keeping them lets the dashboard render the last-known
     *  Lifetime Deposit until the next scan refreshes them, instead of
     *  flashing to null (which triggers "Pending Re-scan…" on the UI). */
    const key = uniqKey("C");
    const deps = makeDeps(key);
    deps._botState.lifetimeHodlAmounts = { amount0: 9, amount1: 8 };
    deps._botState.totalLifetimeDepositUsd = 1234;
    deps._botState.depositUsedFallback = true;
    _applyRebalanceResult(deps, result);
    assert.deepStrictEqual(deps._botState.lifetimeHodlAmounts, {
      amount0: 9,
      amount1: 8,
    });
    assert.strictEqual(deps._botState.totalLifetimeDepositUsd, 1234);
    assert.strictEqual(deps._botState.depositUsedFallback, true);
  });

  it("sets _needsFullRescan even when no _epochKey is present", () => {
    /*- Even without an epoch key (fresh position, no tracker yet), the
     *  rebalance still needs to flag for re-scan once a tracker shows up. */
    const deps = makeDeps(uniqKey("D"));
    deps._pnlTracker = null;
    _applyRebalanceResult(deps, result);
    assert.strictEqual(deps._botState._needsFullRescan, true);
  });

  it("flips lifetimeScanComplete to false on rebalance and propagates via updateBotState", () => {
    /*- The rebalance extended the chain so the prior scan's totals are
     *  stale.  Server's `_syncStatus` reads lifetimeScanComplete on the
     *  per-position state map (via /api/status), so the rebalance path
     *  must both mutate botState in-memory AND call updateBotState so
     *  the dashboard's Syncing badge re-engages immediately. */
    const key = uniqKey("E");
    const patches = [];
    const deps = makeDeps(key);
    deps._botState.lifetimeScanComplete = true;
    deps.updateBotState = (p) => patches.push(p);
    _applyRebalanceResult(deps, result);
    assert.strictEqual(deps._botState.lifetimeScanComplete, false);
    const flipped = patches.find((p) => p.lifetimeScanComplete === false);
    assert.ok(
      flipped,
      "updateBotState must be called with lifetimeScanComplete: false",
    );
  });
});
