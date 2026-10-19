"use strict";

/**
 * @file test/manage-while-starting-or-stopping.test.js
 * @description A Manage request while the app is starting the positions
 *   saved as managed, or stopping for good (src/app-phase.js).
 *
 *   It is refused with 409 and the reason in the operator's words, and
 *   nothing starts: during the start-up, a saved position the start-up
 *   has yet to reach may be in the same pool, and once stopping, nothing
 *   starts. A Stop Managing starts nothing, so it goes through, and the
 *   start-up passes over the position at its turn.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createPositionRoutes,
  getAllPositionBotStates,
} = require("../src/server-positions");
const { compositeKey } = require("../src/bot-config-v2");
const appPhase = require("../src/app-phase");

const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const KEY = compositeKey("pulsechain", WALLET, PM, "222");

/**
 * The position routes over a stand-in position manager that records
 * each start and removal, with `body` as every request's body.
 */
function routesFor(body) {
  const calls = { started: [], removed: [] };
  const diskConfig = { global: {}, positions: {} };
  const routes = createPositionRoutes({
    diskConfig,
    positionMgr: {
      startPosition: async (key) => calls.started.push(key),
      removePosition: async (key) => calls.removed.push(key),
      get: () => null,
      count: () => 0,
      getSharedSigner: async () => ({}),
    },
    walletManager: { getAddress: () => WALLET },
    getPrivateKey: () => "0xpk123",
    jsonResponse: (res, status, answer) => {
      res.status = status;
      res.body = answer;
    },
    readJsonBody: async () => body,
    ethersLib: { Contract: class {} },
    readProvider: () => ({}),
  });
  return { routes, calls, diskConfig };
}

afterEach(() => {
  appPhase._resetAppPhaseForTests();
  getAllPositionBotStates().clear();
});

describe("a Manage request", () => {
  it("is refused while the start-up is under way, and starts nothing", async () => {
    appPhase.beginStartUp(3);
    appPhase.noteStartUpProgress(1);
    const { routes, calls, diskConfig } = routesFor({
      tokenId: "222",
      contract: PM,
    });
    const res = {};
    await routes["POST /api/position/manage"]({}, res);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /still starting .*\(1 of 3\)/);
    assert.deepEqual(calls.started, []);
    assert.deepEqual(diskConfig.positions, {}, "nothing saved");
  });

  it("is refused once the app is stopping", async () => {
    appPhase.markStopping();
    const { routes, calls } = routesFor({ tokenId: "222", contract: PM });
    const res = {};
    await routes["POST /api/position/manage"]({}, res);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /stopping/);
    assert.deepEqual(calls.started, []);
  });
});

describe("a Stop Managing request", () => {
  it("goes through while the start-up is under way", async () => {
    appPhase.beginStartUp(3);
    const { routes, calls, diskConfig } = routesFor({ key: KEY });
    diskConfig.positions[KEY] = { status: "running" };
    const res = {};
    await routes["DELETE /api/position/manage"]({}, res);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.removed, [KEY]);
    assert.equal(diskConfig.positions[KEY].status, "stopped");
  });
});
