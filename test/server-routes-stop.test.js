/**
 * @file test/server-routes-stop.test.js
 * @description The held stop's route in src/lib/server-routes.js,
 *   `_handleStopWhenAllClear` (`POST /api/stop-when-all-clear`, which
 *   `npm run gentle-stop` sends): it answers at once, starts the stop in
 *   the background, and closes the server only once every position has
 *   stopped. What the stop waits for, scans included, is
 *   test/stop-when-all-clear.test.js.
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("assert");
const { createRouteHandlers } = require("../src/lib/server-routes");
const { compositeKey, managedKeys } = require("../src/lib/bot-config-v2");
const { CHAIN_NAME } = require("../src/lib/config");
const appPhase = require("../src/lib/app-phase");
const { createPositionManager } = require("../src/lib/position-manager");
const { updatePositionState } = require("../src/lib/server-positions");
const { makeDeps, makeRes } = require("./helpers/route-handler-deps");

const WALLET_0X = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const PM_0X = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

/*-
 *  The handler answers at once and stops in the background: let the
 *  stop's steps run. The server stand-ins' `close` never calls its
 *  callback, which would end the process.
 */
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

describe("_handleStopWhenAllClear", () => {
  afterEach(() => appPhase._resetAppPhaseForTests());

  it("marks the app stopping before it stops the positions", async () => {
    // So no position starts, and no move begins, while they stop.
    let stoppingAtStop = null;
    const base = makeDeps();
    const h = createRouteHandlers(
      makeDeps({
        positionMgr: {
          ...base.positionMgr,
          stopAll: async () => {
            stoppingAtStop = appPhase.isStopping();
          },
        },
      }),
    );
    h._handleStopWhenAllClear({}, makeRes(), { close: () => {} });
    await settle();
    assert.strictEqual(stoppingAtStop, true);
  });

  it("leaves the positions saved as managed for the next launch", async () => {
    /*-
     *  Each loop's stop reports itself no longer running, as the bot
     *  loop's own stop does. The saved list is the one the next launch
     *  starts, so the stop may not take anything off it.
     */
    const deps = makeDeps();
    const key = compositeKey(CHAIN_NAME, WALLET_0X, PM_0X, "157");
    deps.diskConfig.positions[key] = { status: "running" };
    const mgr = createPositionManager({ rebalanceLock: {} });
    const keyRef = { current: key };
    await mgr.startPosition(key, {
      tokenId: "157",
      startLoop: async () => ({
        stop: async () =>
          updatePositionState(keyRef, { running: false }, deps.diskConfig, mgr),
      }),
    });
    const h = createRouteHandlers({ ...deps, positionMgr: mgr });
    h._handleStopWhenAllClear({}, makeRes(), { close: () => {} });
    await settle();
    assert.deepStrictEqual(managedKeys(deps.diskConfig), [key]);
  });

  it("responds with ok, what it waits for, and stops all positions", async () => {
    let stopped = false;
    let closed = false;
    const deps = makeDeps({
      positionMgr: {
        ...makeDeps().positionMgr,
        stopAll: async () => {
          stopped = true;
        },
      },
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    const srv = {
      close: () => {
        closed = true;
      },
    };
    h._handleStopWhenAllClear({}, res, srv);
    assert.strictEqual(res._status, 200);
    assert.deepStrictEqual(res._body, {
      ok: true,
      stopping: true,
      waitingFor: [],
    });
    await settle();
    assert.ok(stopped);
    assert.ok(closed);
  });

  it("sends the shutdown alert once, however often it is asked", async () => {
    // `npm run gentle-stop` stops the server through here, and repeats.
    let alerts = 0;
    const h = createRouteHandlers(
      makeDeps({
        notifyShutdown: () => {
          alerts++;
        },
      }),
    );
    h._handleStopWhenAllClear({}, makeRes(), { close: () => {} });
    h._handleStopWhenAllClear({}, makeRes(), { close: () => {} });
    await settle();
    assert.strictEqual(alerts, 1);
  });

  it("closes the server only once every position has stopped", async () => {
    /*-
     *  Stopping a position waits for a rebalance or compound under way,
     *  so `npm run gentle-stop`, which asks this route, cuts none off.
     */
    let release;
    const stopping = new Promise((resolve) => {
      release = resolve;
    });
    let closed = false;
    const deps = makeDeps({
      positionMgr: { ...makeDeps().positionMgr, stopAll: () => stopping },
    });
    const h = createRouteHandlers(deps);
    h._handleStopWhenAllClear({}, makeRes(), {
      close: () => {
        closed = true;
      },
    });
    await settle();
    assert.strictEqual(closed, false, "not while a position is stopping");
    release();
    await settle();
    assert.strictEqual(closed, true);
  });
});
