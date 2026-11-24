"use strict";

/**
 * @file test/manage-key-migration.test.js
 * @description Manage marks the position it started as managed under the
 *   key the position holds once its loop is up, not the key the request
 *   named (`_start`, src/bot/position-lifecycle.js). A re-open's first
 *   poll can rebalance at once, minting a new NFT and moving the
 *   position's key (`updatePositionState`, src/bot/position-states.js)
 *   before the start returns. Marked under the old key, the position
 *   would leave behind a slot holding only `status: "running"`, which the
 *   dashboard reads as a managed position that never runs.
 *
 *   Driven through the real Manage, with the bot loop stood in for: its
 *   first poll reports the new NFT, as a rebalance does.
 *   test/server-positions-stale-key-races.test.js tests the migration's
 *   own steps.
 */

const { it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

const NEW_TOKEN = "161616";

/*-
 *  TEST-ONLY global swap: Manage takes `startBotLoop` from
 *  src/bot/bot-loop.js as it loads, and offers no seam for it, so the
 *  loop is stood in for through the require that loads it. Restored
 *  pristine in the `finally` below, immediately after the modules under
 *  test load.
 */
const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const inLifecycle =
    path.basename(this.filename || "") === "position-lifecycle.js";
  if (id === "./bot-loop" && inLifecycle)
    return {
      startBotLoop: async (opts) => {
        opts.updateBotState({ activePositionId: NEW_TOKEN });
        return { stop: async () => {} };
      },
    };
  return _origRequire.apply(this, arguments);
};
let createPositionRoutes;
try {
  ({ createPositionRoutes } = require("./_bot-route-adapters"));
} finally {
  Module.prototype.require = _origRequire;
}
const config = require("../src/lib/config");
const { compositeKey } = require("../src/lib/bot-config-v2");
const { getAllPositionBotStates } = require("../src/bot/position-states");
const { poolReadStandIn } = require("./helpers/pool-read-stand-in");

const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const OLD_TOKEN = "159175";

it("marks the position managed under the key its first rebalance moved it to", async () => {
  const oldKey = compositeKey(config.CHAIN_NAME, WALLET, PM, OLD_TOKEN);
  const newKey = compositeKey(config.CHAIN_NAME, WALLET, PM, NEW_TOKEN);
  const diskConfig = { global: {}, positions: {} };
  const routes = createPositionRoutes({
    diskConfig,
    positionMgr: {
      startPosition: async (_key, { startLoop }) => {
        await startLoop();
      },
      migrateKey: () => {},
      get: () => null,
      count: () => 0,
      runningCount: () => 1,
      poolKey: (...parts) => parts.join("-").toLowerCase(),
      getRebalanceLock: () => ({ acquire: async () => () => {} }),
      getScanLock: () => ({ acquire: async () => () => {} }),
      canRebalancePool: () => true,
      recordPoolRebalance: () => {},
      getSharedSigner: async () => ({}),
    },
    walletManager: { getAddress: () => WALLET },
    getPrivateKey: () => "0xpk123",
    jsonResponse: (res, status, answer) => {
      res.status = status;
      res.body = answer;
    },
    readJsonBody: async () => ({ tokenId: OLD_TOKEN, contract: PM }),
    ...poolReadStandIn(),
  });
  const res = {};
  await routes["POST /api/position/manage"]({}, res);
  getAllPositionBotStates().clear();
  assert.equal(res.status, 200);
  assert.equal(diskConfig.positions[newKey].status, "running");
  assert.equal(
    diskConfig.positions[oldKey],
    undefined,
    "no slot is left under the old key",
  );
});
