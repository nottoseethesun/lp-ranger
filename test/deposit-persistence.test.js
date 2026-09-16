"use strict";

/**
 * @file test/deposit-persistence.test.js
 * @description The lifetime deposit total survives a restart, so the
 *   lifetime scan can resume from its checkpoint.
 *
 *   `_scanLifetimePoolData` starts from the saved `lastNftScanBlock` only
 *   when three results are on disk: the HODL amounts, the compound total
 *   and the deposit total (`canResumeIncrementally`). The deposit total
 *   is computed by `computeDepositUsd`, which sets it on the bot state and
 *   passes it to `updateBotState` — but the save path must actually write
 *   it, and the start path must actually read it back.
 *
 *   If the save is missing, the gate never opens and every restart walks
 *   the whole rebalance chain again from the pool's creation block. If
 *   only the restore is missing, a resumed scan skips the recompute and
 *   leaves the in-memory total at zero; readiness is `total > 0`, so the
 *   Syncing badge never clears. These tests cover both directions, and
 *   drive the real save, restore and gate functions end to end.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createPerPositionBotState,
  updatePositionState,
  getAllPositionBotStates,
  PERSISTED_STATE_KEYS,
} = require("../src/server-positions");
const { readConfigValue } = require("../src/bot-config-v2");
const {
  canResumeIncrementally,
  _resolveDiskState,
} = require("../src/bot-recorder-lifetime");

const KEY =
  "pulsechain-0x4e44847675763D5540B32Bee8a713CfDcb4bE61A-" +
  "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-164418";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "deposit-persist-"));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  getAllPositionBotStates().delete(KEY);
});

/** A disk config with a managed slot, as handleManage leaves it. */
function freshConfig() {
  return { global: {}, positions: { [KEY]: { status: "running" } } };
}

/** Minimal position manager: updatePositionState only needs these. */
const mgr = { migrateKey: () => {} };

/** Bot state wired to read config the way `bot-state-init.js` wires it. */
function botStateReading(cfg) {
  return { _getConfig: (k) => readConfigValue(cfg, KEY, k) };
}

describe("PERSISTED_STATE_KEYS", () => {
  it("includes the deposit total and its fallback flag", () => {
    assert.ok(PERSISTED_STATE_KEYS.includes("totalLifetimeDepositUsd"));
    assert.ok(PERSISTED_STATE_KEYS.includes("depositUsedFallback"));
  });

  it("has no duplicates", () => {
    assert.equal(
      new Set(PERSISTED_STATE_KEYS).size,
      PERSISTED_STATE_KEYS.length,
    );
  });
});

describe("the deposit total is saved", () => {
  it("writes both fields when the bot reports them", () => {
    const cfg = freshConfig();
    updatePositionState(
      { current: KEY },
      { totalLifetimeDepositUsd: 2406.7, depositUsedFallback: true },
      cfg,
      mgr,
      dir,
    );
    assert.equal(cfg.positions[KEY].totalLifetimeDepositUsd, 2406.7);
    assert.equal(cfg.positions[KEY].depositUsedFallback, true);
  });

  it("reaches the file on disk, not just the in-memory object", () => {
    const cfg = freshConfig();
    updatePositionState(
      { current: KEY },
      { totalLifetimeDepositUsd: 1738.41, depositUsedFallback: false },
      cfg,
      mgr,
      dir,
    );
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "bot-config.json"), "utf8"),
    );
    assert.equal(onDisk.positions[KEY].totalLifetimeDepositUsd, 1738.41);
    assert.equal(onDisk.positions[KEY].depositUsedFallback, false);
  });
});

describe("the deposit total is restored on start", () => {
  it("comes back into the bot state", () => {
    const st = createPerPositionBotState(
      {},
      { totalLifetimeDepositUsd: 190.5, depositUsedFallback: true },
    );
    assert.equal(st.totalLifetimeDepositUsd, 190.5);
    assert.equal(st.depositUsedFallback, true);
  });

  it("restores a false fallback flag as false, not as absent", () => {
    /*- The flag is a boolean; `false` is a value, and dropping it would
     *  leave the field undefined rather than stating the price source. */
    const st = createPerPositionBotState({}, { depositUsedFallback: false });
    assert.equal(st.depositUsedFallback, false);
  });

  it("leaves both absent when the slot has neither", () => {
    const st = createPerPositionBotState({}, { status: "running" });
    assert.equal(st.totalLifetimeDepositUsd, undefined);
    assert.equal(st.depositUsedFallback, undefined);
  });

  it("tolerates no saved slot at all", () => {
    for (const saved of [undefined, null]) {
      const st = createPerPositionBotState({}, saved);
      assert.equal(st.totalLifetimeDepositUsd, undefined);
    }
  });

  it("round-trips every persisted key", () => {
    /*- One list drives both directions, so anything saved comes back.
     *  Pins that for the whole list, not just the deposit. */
    const saved = {};
    for (const [i, k] of PERSISTED_STATE_KEYS.entries()) saved[k] = `v${i}`;
    const st = createPerPositionBotState({}, saved);
    for (const k of PERSISTED_STATE_KEYS) assert.equal(st[k], saved[k], k);
  });
});

describe("the resume gate opens after a restart", () => {
  it("sees the deposit on disk once the bot has reported it", () => {
    /*- The regression itself. Before the save existed, this read
     *  `hasDepositData: false` forever, so `canResumeIncrementally` could
     *  never return true and every restart re-walked the chain. */
    const cfg = freshConfig();
    updatePositionState(
      { current: KEY },
      {
        compoundHistory: [{ txHash: "0x1" }],
        totalCompoundedUsd: 1111.16,
        totalLifetimeDepositUsd: 2406.7,
      },
      cfg,
      mgr,
      dir,
    );
    const disk = _resolveDiskState(botStateReading(cfg), null);
    assert.equal(disk.hasCompoundData, true);
    assert.equal(disk.hasDepositData, true);
  });

  it("opens the gate when HODL, compounds and deposit are all present", () => {
    const cfg = freshConfig();
    updatePositionState(
      { current: KEY },
      { totalCompoundedUsd: 1111.16, totalLifetimeDepositUsd: 2406.7 },
      cfg,
      mgr,
      dir,
    );
    const disk = _resolveDiskState(botStateReading(cfg), null);
    /*- The HODL amounts live in the epoch cache, not the config slot;
     *  supplied directly here so the test isolates the deposit. */
    assert.equal(
      canResumeIncrementally({ ...disk, cachedHodl: { deposits: [] } }),
      true,
    );
  });

  it("keeps the gate shut while the deposit is missing", () => {
    /*- The stomp protection must still hold: without a deposit total a
     *  resumed scan would feed a partial chain to the deposit
     *  recompute and write a smaller, wrong total. */
    const cfg = freshConfig();
    updatePositionState(
      { current: KEY },
      { totalCompoundedUsd: 1111.16 },
      cfg,
      mgr,
      dir,
    );
    const disk = _resolveDiskState(botStateReading(cfg), null);
    assert.equal(disk.hasDepositData, false);
    assert.equal(
      canResumeIncrementally({ ...disk, cachedHodl: { deposits: [] } }),
      false,
    );
  });

  it("keeps the gate shut for a zero deposit", () => {
    /*- A zero total is a failed or empty computation, not a result. */
    const cfg = freshConfig();
    updatePositionState(
      { current: KEY },
      { totalCompoundedUsd: 1, totalLifetimeDepositUsd: 0 },
      cfg,
      mgr,
      dir,
    );
    assert.equal(
      _resolveDiskState(botStateReading(cfg), null).hasDepositData,
      false,
    );
  });
});

describe("a resumed scan is still ready", () => {
  it("restored deposit makes the position ready without a recompute", () => {
    /*- Readiness is `totalLifetimeDepositUsd > 0`. A resumed scan skips
     *  `computeDepositUsd`, so the only way the total is in memory is the
     *  restore. Without it the Syncing badge would stay on forever. */
    const cfg = freshConfig();
    updatePositionState(
      { current: KEY },
      { totalLifetimeDepositUsd: 2406.7 },
      cfg,
      mgr,
      dir,
    );
    const restarted = createPerPositionBotState({}, cfg.positions[KEY]);
    assert.ok(restarted.totalLifetimeDepositUsd > 0);
  });
});
