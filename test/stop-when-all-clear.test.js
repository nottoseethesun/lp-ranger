"use strict";

/**
 * @file test/stop-when-all-clear.test.js
 * @description The server's held stop (src/server/stop-when-all-clear.js),
 *   which `npm run gentle-stop` asks for: it begins at once, so nothing
 *   new starts, and the server exits only once each position's poll has
 *   ended and each scan still running has finished. Every request after
 *   the first changes nothing and answers what the stop still waits for.
 *
 *   Each case of the held stop goes through the server's own route,
 *   `_handleStopWhenAllClear` (src/server/server-routes.js), over the
 *   bot's interface, so what is under way and the wait for the scans
 *   come from the bot over the test's bot states. Those are plain
 *   objects, and a running scan's pass is a promise the test settles. The
 *   position manager and the alert are stood in for. The server's close
 *   is the exit: the stand-in records it and never calls back, and the
 *   stop's exit timeout runs on mock time, so the process stays.
 */

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { createRouteHandlers } = require("./_bot-route-adapters");
const { makeDeps, makeRes } = require("./helpers/route-handler-deps");
const appPhase = require("../src/bot/app-phase");
const { underWay } = require("../src/bot/under-way");

/** A promise with its resolver. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every queued promise callback run. */
const settle = () => new Promise((r) => setImmediate(r));

const KEY = "pulsechain-0xW-0xPM-7";
const POSITION = {
  activePosition: { tokenId: "7", token0Symbol: "A", token1Symbol: "B" },
};

/**
 * The server's held stop over `states`, as gentle-stop reaches it, with
 * each step it takes recorded: the app marked stopping (as the alert
 * goes), the alert, the positions' stop, and the exit.
 */
function heldStop(states, stopAll = async () => {}) {
  const steps = [];
  const base = makeDeps();
  const h = createRouteHandlers(
    makeDeps({
      getAllPositionBotStates: () => states,
      notifyShutdown: () => {
        if (appPhase.isStopping()) steps.push("markStopping");
        steps.push("notifyShutdown");
      },
      positionMgr: {
        ...base.positionMgr,
        stopAll: async () => {
          steps.push("stopAll");
          await stopAll();
        },
      },
    }),
  );
  const srv = { close: () => steps.push("exit") };
  const stop = {
    request: () => {
      const res = makeRes();
      h._handleStopWhenAllClear({}, res, srv);
      return { waitingFor: res._body.waitingFor };
    },
  };
  return { stop, steps };
}

describe("the held stop", () => {
  /*-
   *  TEST-ONLY global swap: the route's exit starts a real timer that
   *  ends the process (`setTimeout(() => process.exit(0), exitTimeoutMs)`,
   *  src/server/server-routes.js), and the route takes no seam for it:
   *  the timer is part of what is under test. On mock time it never
   *  fires. Restored pristine after each case, by `mock.timers.reset()`.
   */
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => {
    mock.timers.reset();
    appPhase._resetAppPhaseForTests();
  });

  it("starts at once and exits once nothing is under way", async () => {
    const { stop, steps } = heldStop(new Map([[KEY, { ...POSITION }]]));
    assert.deepEqual(stop.request(), { waitingFor: [] });
    await settle();
    assert.deepEqual(steps, [
      "markStopping",
      "notifyShutdown",
      "stopAll",
      "exit",
    ]);
  });

  it("waits for a scan still running once every position has stopped", async () => {
    const pass = deferred();
    const st = { ...POSITION, _scanRunning: true, _scanDone: pass.promise };
    const { stop, steps } = heldStop(new Map([[KEY, st]]));
    stop.request();
    await settle();
    assert.equal(steps.includes("exit"), false, "the scan holds the exit");
    assert.deepEqual(stop.request(), {
      waitingFor: [{ position: "A/B NFT #7", activity: "scan" }],
    });
    st._scanRunning = false;
    pass.resolve();
    await settle();
    assert.equal(steps.at(-1), "exit");
    assert.equal(
      steps.filter((s) => s === "markStopping").length,
      1,
      "a second request changes nothing",
    );
  });

  it("waits for a scan that starts while the positions stop", async () => {
    /*-
     *  A rebalance under way at the request finishes during `stopAll`,
     *  and the scan that follows it starts then.
     */
    const pass = deferred();
    const st = { ...POSITION, rebalanceInProgress: true };
    const { stop, steps } = heldStop(new Map([[KEY, st]]), async () => {
      await null;
      st.rebalanceInProgress = false;
      st._scanRunning = true;
      st._scanDone = pass.promise;
    });
    assert.deepEqual(stop.request().waitingFor, [
      { position: "A/B NFT #7", activity: "rebalance" },
    ]);
    await settle();
    assert.equal(steps.includes("exit"), false);
    st._scanRunning = false;
    pass.resolve();
    await settle();
    assert.equal(steps.at(-1), "exit");
  });

  it("exits even when stopping the positions fails", async () => {
    const { stop, steps } = heldStop(new Map(), async () => {
      throw new Error("stop failed");
    });
    stop.request();
    await settle();
    assert.equal(steps.at(-1), "exit");
  });
});

describe("underWay", () => {
  it("names moves until every poll has ended, and scans while they run", () => {
    const states = new Map([
      [KEY, { ...POSITION, rebalanceInProgress: true }],
      [
        "pulsechain-0xW-0xPM-8",
        { compoundInProgress: true, _scanRunning: true },
      ],
    ]);
    assert.deepEqual(underWay(states, false), [
      { position: "A/B NFT #7", activity: "rebalance" },
      { position: "NFT #8", activity: "compound" },
      { position: "NFT #8", activity: "scan" },
    ]);
    assert.deepEqual(underWay(states, true), [
      { position: "NFT #8", activity: "scan" },
    ]);
  });
});
