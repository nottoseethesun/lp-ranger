"use strict";

/**
 * @file test/stop-when-all-clear.test.js
 * @description The server's held stop (src/lib/stop-when-all-clear.js),
 *   which `npm run gentle-stop` asks for: it begins at once, so nothing
 *   new starts, and the server exits only once each position's poll has
 *   ended and each scan still running has finished. Every request after
 *   the first changes nothing and answers what the stop still waits for.
 *
 *   The position manager, the alert and the exit are stood in for; the
 *   bot states are plain objects, a running scan's pass a promise the
 *   test settles.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  createStopWhenAllClear,
  underWay,
} = require("../src/lib/stop-when-all-clear");

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

/** A held stop over `states`, with each step it takes recorded. */
function heldStop(states, stopAll = async () => {}) {
  const steps = [];
  const stop = createStopWhenAllClear({
    markStopping: () => steps.push("markStopping"),
    notifyShutdown: () => steps.push("notifyShutdown"),
    stopAll: async () => {
      steps.push("stopAll");
      await stopAll();
    },
    getStates: () => states,
    exit: () => steps.push("exit"),
  });
  return { stop, steps };
}

describe("the held stop", () => {
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
