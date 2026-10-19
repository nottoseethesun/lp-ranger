"use strict";

/**
 * @file test/position-manager-start-under-way.test.js
 * @description A position whose start is under way, in the position
 *   manager (src/position-manager.js).
 *
 *   A bot loop runs its first check of the pool before its start hands
 *   back the handle that stops it, and that check can take minutes and
 *   rebalance. So the manager records the position before that check,
 *   where a stop of every position waits for the start and then stops the
 *   loop, a rebalance in the check moves its key, a Stop Managing or a
 *   retire meanwhile has the start stop its own loop, and a second start
 *   of the same position does nothing. Once the app is stopping for good,
 *   no start begins.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createPositionManager } = require("../src/position-manager");
const { createRebalanceLock } = require("../src/rebalance-lock");
const appPhase = require("../src/app-phase");

const makeMgr = () =>
  createPositionManager({ rebalanceLock: createRebalanceLock() });

/** A loop start, held at its first check until `finish` is called. */
function heldStart() {
  let finish;
  const ended = new Promise((resolve) => {
    finish = resolve;
  });
  const held = { stops: 0, finish: () => finish() };
  held.handle = {
    stop() {
      held.stops += 1;
      return Promise.resolve();
    },
  };
  held.startLoop = () => ended.then(() => held.handle);
  return held;
}

describe("a position whose start is under way", () => {
  it("is stopped by a stop of every position, which waits for its start", async () => {
    const mgr = makeMgr();
    const held = heldStart();
    const starting = mgr.startPosition("key-1", {
      tokenId: "100",
      startLoop: held.startLoop,
    });
    let done = false;
    const all = mgr.stopAll().then(() => {
      done = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, "not while its first check runs");
    held.finish();
    await starting;
    await all;
    assert.equal(held.stops, 1, "the loop its start recorded is stopped");
    assert.equal(mgr.runningCount(), 0);
  });

  it("is found under its new key when its first check rebalances", async () => {
    /*-
     *  A rebalance mints a new NFT and moves the position's key. Found
     *  only under the old key, the loop would be out of reach of the
     *  Stop Managing the dashboard sends under the new one.
     */
    const mgr = makeMgr();
    const held = heldStart();
    const starting = mgr.startPosition("key-1", {
      tokenId: "100",
      startLoop: held.startLoop,
    });
    mgr.migrateKey("key-1", "key-2", "200");
    held.finish();
    await starting;
    assert.equal(mgr.get("key-1"), undefined);
    assert.equal(mgr.get("key-2").handle, held.handle);
    await mgr.removePosition("key-2");
    assert.equal(held.stops, 1, "Stop Managing under the new key stops it");
  });

  it("stops the loop it started when the position was removed meanwhile", async () => {
    // A Stop Managing, or a retire in its first check.
    const mgr = makeMgr();
    const held = heldStart();
    const starting = mgr.startPosition("key-1", {
      tokenId: "100",
      startLoop: held.startLoop,
    });
    await mgr.removePosition("key-1");
    held.finish();
    await assert.rejects(starting, /removed while it started/);
    assert.equal(held.stops, 1);
    assert.equal(mgr.get("key-1"), undefined);
  });

  it("is not started a second time", async () => {
    const mgr = makeMgr();
    const held = heldStart();
    let starts = 0;
    const startLoop = () => {
      starts += 1;
      return held.startLoop();
    };
    const first = mgr.startPosition("key-1", { tokenId: "100", startLoop });
    const second = mgr.startPosition("key-1", { tokenId: "100", startLoop });
    held.finish();
    await Promise.all([first, second]);
    assert.equal(starts, 1, "one bot loop for one position");
  });

  it("keeps running a position whose start began while every position stopped", async () => {
    /*-
     *  Marked stopped with its loop running, the position would be out of
     *  reach of every stop, and a second Manage would start a second loop.
     */
    const mgr = makeMgr();
    let release;
    const stopping = new Promise((resolve) => {
      release = resolve;
    });
    await mgr.startPosition("key-1", {
      tokenId: "100",
      startLoop: async () => ({ stop: () => stopping }),
    });
    const all = mgr.stopAll();
    const later = { stop: () => Promise.resolve() };
    await mgr.startPosition("key-2", {
      tokenId: "200",
      startLoop: async () => later,
    });
    release();
    await all;
    assert.equal(mgr.get("key-1").status, "stopped");
    assert.equal(mgr.get("key-2").status, "running");
    assert.equal(mgr.get("key-2").handle, later);
  });

  it("leaves no record when its loop fails to start", async () => {
    const mgr = makeMgr();
    await assert.rejects(
      mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: async () => {
          throw new Error("pool unavailable");
        },
      }),
      /pool unavailable/,
    );
    assert.equal(mgr.get("key-1"), undefined);
    assert.equal(mgr.count(), 0);
  });
});

describe("once the app is stopping", () => {
  afterEach(() => appPhase._resetAppPhaseForTests());

  it("starts no position", async () => {
    const mgr = makeMgr();
    appPhase.markStopping();
    let started = false;
    await assert.rejects(
      mgr.startPosition("key-1", {
        tokenId: "100",
        startLoop: async () => {
          started = true;
          return { stop: () => Promise.resolve() };
        },
      }),
      /stopping/,
    );
    assert.equal(started, false, "its loop never starts");
    assert.equal(mgr.get("key-1"), undefined);
  });
});
