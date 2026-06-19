/**
 * @file test/build-status-positions.test.js
 * @description Tests for src/server-positions.js `buildStatusPositions`.
 *
 * The post-auto-retire "stuck Syncing badge" bug fix lives here: a
 * position that was managed, attempted a re-open, failed, then
 * auto-retired now needs the /api/status payload to publish a
 * terminal sync state so the dashboard's syncBadge resolves to
 * "Synced" (and the closed-position Manage button re-enables for the
 * user to retry).  See server-positions.js's loop-2 comment block.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  buildStatusPositions,
  getAllPositionBotStates,
} = require("../src/server-positions");

const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const CONTRACT = "0xCC05BF51E2B8f0A457E8F15FD5E8e25F34f8b279";
const key = (tid) => `pulsechain-${WALLET}-${CONTRACT}-${tid}`;

const POS_DEFAULTS = {
  slippagePct: 0.5,
  rebalanceOutOfRangeThresholdPercent: 5,
};

const FAKE_POSITION_MGR = {
  poolKey: () => null,
  getAll: () => [],
};

const FAKE_CFG = {
  CHAIN_NAME: "pulsechain",
  POSITION_MANAGER: CONTRACT,
};

function resetBotStates() {
  const m = getAllPositionBotStates();
  for (const k of [...m.keys()]) m.delete(k);
}

describe("buildStatusPositions — sync state for stopped (disk-only) positions", () => {
  it("publishes rebalanceScanComplete=true and lifetimeScanComplete=true for status='stopped'", () => {
    resetBotStates();
    const k = key("161624");
    const diskConfig = {
      global: {},
      positions: {
        [k]: {
          status: "stopped",
          slippagePct: 9,
          hodlBaseline: { entry: 100 },
        },
      },
    };
    const out = buildStatusPositions(
      diskConfig,
      POS_DEFAULTS,
      FAKE_POSITION_MGR,
      FAKE_CFG,
    );
    assert.ok(out[k], "entry exists for the stopped key");
    assert.strictEqual(
      out[k].rebalanceScanComplete,
      true,
      "rebalanceScanComplete must be true for stopped positions so the " +
        "dashboard syncBadge resolves to Synced instead of staying stuck " +
        "on Syncing… (which would disable the closed-pos Manage button)",
    );
    assert.strictEqual(
      out[k].lifetimeScanComplete,
      true,
      "lifetimeScanComplete must also be true for symmetry — even though " +
        "the dashboard's _syncStatus only gates lifetimeScanComplete for " +
        "managed positions, publishing it consistently avoids any future " +
        "consumer reading undefined and re-introducing the same bug class",
    );
    assert.strictEqual(out[k].status, "stopped", "status surfaced for clarity");
    assert.strictEqual(
      out[k].slippagePct,
      9,
      "settings (slippagePct) still flow through to the dashboard",
    );
  });

  it("does NOT publish rebalanceScanComplete for status='running' but bot not yet started", () => {
    /*- Mid-boot scenario: disk has the position as running, but the
     *  bot-loop hasn't fired its first scan yet (e.g. it's behind a
     *  startup stagger).  We must NOT lie about the scan being done
     *  here — the dashboard's "Syncing…" indicator is correct in that
     *  window.  Bot loop will fill in the real flag once its first
     *  scan completes and the entry flips from loop-2 to loop-1. */
    resetBotStates();
    const k = key("161597");
    const diskConfig = {
      global: {},
      positions: {
        [k]: {
          status: "running",
          slippagePct: 0.75,
        },
      },
    };
    const out = buildStatusPositions(
      diskConfig,
      POS_DEFAULTS,
      FAKE_POSITION_MGR,
      FAKE_CFG,
    );
    assert.ok(out[k], "entry exists for the running-but-not-yet-started key");
    assert.strictEqual(
      out[k].rebalanceScanComplete,
      undefined,
      "must NOT publish true for running positions before bot fills in real state",
    );
    assert.strictEqual(
      out[k].lifetimeScanComplete,
      undefined,
      "must NOT publish true for running positions",
    );
  });

  it("loop-1 (live bot state) wins over loop-2 — running entries keep their real flags", () => {
    /*- The bot is alive and has updated state.  Loop 1 spreads in the
     *  real state including rebalanceScanComplete (possibly false
     *  mid-scan).  Loop 2 must skip this key entirely so our terminal-
     *  state injection doesn't clobber the live mid-scan signal. */
    resetBotStates();
    const k = key("161597");
    const m = getAllPositionBotStates();
    m.set(k, {
      rebalanceScanComplete: false,
      lifetimeScanComplete: false,
      activePosition: { tokenId: "161597" },
    });
    const diskConfig = {
      global: {},
      positions: {
        [k]: { status: "running", slippagePct: 0.75 },
      },
    };
    const out = buildStatusPositions(
      diskConfig,
      POS_DEFAULTS,
      FAKE_POSITION_MGR,
      FAKE_CFG,
    );
    resetBotStates();
    assert.strictEqual(
      out[k].rebalanceScanComplete,
      false,
      "live bot state's false value preserved — loop 2 did not overwrite",
    );
    assert.strictEqual(
      out[k].lifetimeScanComplete,
      false,
      "live bot state's false value preserved for lifetime flag too",
    );
  });

  it("user-stopped position via 'Stop Managing' also gets terminal sync state", () => {
    /*- Same shape as auto-retire: status moves to 'stopped' on disk
     *  and the bot loop is gone.  The dashboard should not show
     *  Syncing for a position the user deliberately stopped. */
    resetBotStates();
    const k = key("161500");
    const diskConfig = {
      global: {},
      positions: {
        [k]: {
          status: "stopped",
          slippagePct: 2,
          rebalanceTimeoutMin: 180,
        },
      },
    };
    const out = buildStatusPositions(
      diskConfig,
      POS_DEFAULTS,
      FAKE_POSITION_MGR,
      FAKE_CFG,
    );
    assert.strictEqual(out[k].rebalanceScanComplete, true);
    assert.strictEqual(out[k].lifetimeScanComplete, true);
    assert.strictEqual(out[k].status, "stopped");
    assert.strictEqual(out[k].rebalanceTimeoutMin, 180);
  });
});
