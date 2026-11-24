"use strict";

/**
 * @file test/manage-while-starting-or-stopping.test.js
 * @description A Manage request while the app is starting the positions
 *   saved as managed, importing a wallet, or stopping for good
 *   (src/bot/app-phase.js).
 *
 *   It is refused with 409 and the reason in the operator's words, and
 *   nothing starts: during the start-up, a saved position the start-up
 *   has yet to reach may be in the same pool; during an import, the
 *   wallet and its key are being swapped; once stopping, nothing starts.
 *   A Manage already under way when an import begins is refused after
 *   whichever of its two waits (the pool check, the shared signer) the
 *   import overlapped, and leaves nothing behind. A Stop Managing starts
 *   nothing, so it goes through, and the start-up passes over the
 *   position at its turn.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { getAllPositionBotStates } = require("../src/bot/position-states");
const { createPositionRoutes } = require("./_bot-route-adapters");
const { compositeKey } = require("../src/lib/bot-config-v2");
const appPhase = require("../src/bot/app-phase");
const { poolReadStandIn } = require("./helpers/pool-read-stand-in");

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

/**
 * The position routes with a pool check Manage passes, each NFT open
 * and alone in its pool (test/helpers/pool-read-stand-in.js). `onRead`
 * runs inside the pool check's chain read and `onSigner` inside the wait
 * for the shared signer, the two waits before a loop starts; `keys` holds
 * the key the bot has at each ask, so a test can swap it meanwhile.
 */
function routesThroughPoolCheck({ onRead, onSigner, keys }) {
  const calls = { started: [], signers: 0 };
  const diskConfig = { global: {}, positions: {} };
  const standIn = poolReadStandIn();
  const routes = createPositionRoutes({
    diskConfig,
    positionMgr: {
      startPosition: async (key) => calls.started.push(key),
      get: () => null,
      count: () => 0,
      runningCount: () => 0,
      poolKey: (...parts) => parts.join("-").toLowerCase(),
      getRebalanceLock: () => ({ acquire: async () => () => {} }),
      getScanLock: () => ({ acquire: async () => () => {} }),
      canRebalancePool: () => true,
      recordPoolRebalance: () => {},
      getSharedSigner: async () => {
        calls.signers++;
        if (onSigner) onSigner();
        return {};
      },
    },
    walletManager: { getAddress: () => WALLET },
    getPrivateKey: () => keys.current,
    jsonResponse: (res, status, answer) => {
      res.status = status;
      res.body = answer;
    },
    readJsonBody: async () => ({ tokenId: "222", contract: PM }),
    ethersLib: {
      Contract: class extends standIn.ethersLib.Contract {
        async positions(id) {
          if (onRead) onRead();
          return super.positions(id);
        }
      },
    },
    readProvider: standIn.readProvider,
  });
  return { routes, calls, diskConfig };
}

/** One Manage request through `routes`, its answer returned. */
async function manage(routes) {
  const res = {};
  await routes["POST /api/position/manage"]({}, res);
  return res;
}

describe("a Manage request and a wallet import", () => {
  it("is refused while an import is under way, and starts nothing", async () => {
    appPhase.beginWalletImport();
    const { routes, calls, diskConfig } = routesFor({
      tokenId: "222",
      contract: PM,
    });
    const res = await manage(routes);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /importing a wallet/);
    assert.deepEqual(calls.started, []);
    assert.deepEqual(diskConfig.positions, {}, "nothing saved");
  });

  it("is refused when an import begins during its pool check, and frees the pool", async () => {
    let once = true;
    const keys = { current: "0xpk123" };
    const t = routesThroughPoolCheck({
      keys,
      onRead: () => {
        if (once) appPhase.beginWalletImport();
        once = false;
      },
    });
    const res = await manage(t.routes);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /importing a wallet/);
    assert.equal(res.body.positionKey, KEY);
    assert.equal(t.calls.signers, 0, "no signer asked for");
    assert.deepEqual(t.calls.started, []);
    assert.equal(getAllPositionBotStates().has(KEY), false);
    appPhase.endWalletImport();
    const again = await manage(t.routes);
    assert.equal(again.status, 200, "the pool was freed for a retry");
    assert.deepEqual(t.calls.started, [KEY]);
  });

  it("is refused when an import began and ended during its pool check", async () => {
    const keys = { current: "0xpk123" };
    const t = routesThroughPoolCheck({
      keys,
      onRead: () => {
        keys.current = "0xpk456";
      },
    });
    const res = await manage(t.routes);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /wallet was imported while this Manage/);
    assert.equal(t.calls.signers, 0);
    assert.deepEqual(t.calls.started, []);
  });

  it("is refused when an import begins while it waits for the signer, leaving nothing behind", async () => {
    const keys = { current: "0xpk123" };
    const t = routesThroughPoolCheck({
      keys,
      onSigner: () => appPhase.beginWalletImport(),
    });
    const res = await manage(t.routes);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /importing a wallet/);
    assert.deepEqual(t.calls.started, [], "no loop started");
    assert.deepEqual(t.diskConfig.positions, {}, "no slot left");
    assert.equal(getAllPositionBotStates().has(KEY), false);
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
