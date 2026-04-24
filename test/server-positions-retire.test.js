/**
 * @file test/server-positions-retire.test.js
 * @description Tests for `createOnRetire(deps)` — the server-side
 * callback fired by the bot loop when it auto-retires a drained
 * managed position.  Retirement is a pure software state flip:
 * status `running`→`stopped`, autoCompoundEnabled cleared, in-memory
 * bot-state dropped, position manager entry removed.  The NFT is
 * never burned.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const {
  createOnRetire,
  getAllPositionBotStates,
} = require("../src/server-positions");

const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const CONTRACT = "0xCC05BF51E2B8f0A457E8F15FD5E8e25F34f8b279";
const KEY = `pulsechain-${WALLET}-${CONTRACT}-999999`;

function makeDiskConfig() {
  return {
    global: {},
    positions: {
      [KEY]: {
        status: "running",
        autoCompoundEnabled: true,
        slippagePct: 0.75,
      },
    },
  };
}

function makeMgr(calls) {
  return {
    removePosition: async (k) => calls.push(["remove", k]),
  };
}

/*- saveConfig writes to <cwd>/app-config/.bot-config.json by default.
 *  To keep the test hermetic we change cwd to a tmp dir for the
 *  duration of the test and restore it after. */
function withTmpCwd(fn) {
  const original = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retire-test-"));
  process.chdir(tmp);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.chdir(original);
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    });
}

describe("createOnRetire", () => {
  it("flips status running→stopped and clears autoCompound", async () => {
    await withTmpCwd(async () => {
      const diskConfig = makeDiskConfig();
      const calls = [];
      const positionMgr = makeMgr(calls);
      const keyRef = { current: KEY };
      getAllPositionBotStates().set(KEY, { running: true });

      const onRetire = createOnRetire({ keyRef, diskConfig, positionMgr });
      await onRetire("999999");

      assert.strictEqual(diskConfig.positions[KEY].status, "stopped");
      assert.strictEqual(diskConfig.positions[KEY].autoCompoundEnabled, false);
    });
  });

  it("drops the in-memory bot state and calls positionMgr.removePosition", async () => {
    await withTmpCwd(async () => {
      const diskConfig = makeDiskConfig();
      const calls = [];
      const positionMgr = makeMgr(calls);
      const keyRef = { current: KEY };
      getAllPositionBotStates().set(KEY, { running: true });

      const onRetire = createOnRetire({ keyRef, diskConfig, positionMgr });
      await onRetire("999999");

      assert.strictEqual(getAllPositionBotStates().has(KEY), false);
      assert.deepStrictEqual(calls, [["remove", KEY]]);
    });
  });

  it("swallows positionMgr.removePosition errors (bot loop keeps stopping)", async () => {
    await withTmpCwd(async () => {
      const diskConfig = makeDiskConfig();
      const keyRef = { current: KEY };
      const positionMgr = {
        removePosition: async () => {
          throw new Error("boom");
        },
      };
      getAllPositionBotStates().set(KEY, { running: true });

      const onRetire = createOnRetire({ keyRef, diskConfig, positionMgr });
      await onRetire("999999"); // must not throw

      /*- Disk state still flipped even though cleanup throws — retirement
       *  is durable: once we've decided to stop, don't leave status
       *  dangling on 'running' just because an in-memory cleanup failed. */
      assert.strictEqual(diskConfig.positions[KEY].status, "stopped");
    });
  });

  it("uses the current (possibly-migrated) keyRef, not a snapshot", async () => {
    await withTmpCwd(async () => {
      /*- After a post-rebalance key migration the composite key in
       *  keyRef.current changes.  The retirement callback must read
       *  keyRef at call time, not capture the original key. */
      const migratedKey = `pulsechain-${WALLET}-${CONTRACT}-111111`;
      const diskConfig = {
        global: {},
        positions: {
          [migratedKey]: { status: "running", autoCompoundEnabled: true },
        },
      };
      const calls = [];
      const positionMgr = makeMgr(calls);
      const keyRef = { current: KEY };
      keyRef.current = migratedKey; // simulate migration

      const onRetire = createOnRetire({ keyRef, diskConfig, positionMgr });
      await onRetire("111111");

      assert.strictEqual(diskConfig.positions[migratedKey].status, "stopped");
      assert.deepStrictEqual(calls, [["remove", migratedKey]]);
    });
  });
});
