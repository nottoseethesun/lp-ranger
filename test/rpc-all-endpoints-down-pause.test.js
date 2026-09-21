/**
 * @file test/rpc-all-endpoints-down-pause.test.js
 * @description
 * When RPC failover has tried every endpoint and none answered, the app
 * holds ALL JSON-RPC traffic for a configured pause, then starts again
 * from the first endpoint.
 *
 * The hold is what makes that safe to retry into. `src/rpc-read-retry.js`
 * ignores whether failover moved and loops with no exit condition, so
 * with every endpoint refusing, the only thing bounding how fast it
 * re-asks them is this queue.
 *
 * The pause is deliberately ABSOLUTE: a rebalance or compound waits it
 * out like every other request. An exemption would be a hole the pause
 * escapes through, and the request that matters most during an outage is
 * the one least likely to succeed.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const rpcQueue = require("../src/rpc-request-manager");

/** Let pending timers and microtasks run. */
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe("the queue holds everything while paused", () => {
  beforeEach(() => rpcQueue._resetForTests());
  afterEach(() => rpcQueue._resetForTests());

  it("reports the remaining pause, and zero when not paused", () => {
    assert.equal(rpcQueue.haltRemainingMs(), 0, "not paused to begin with");
    rpcQueue.halt(50_000);
    const left = rpcQueue.haltRemainingMs();
    assert.ok(left > 40_000 && left <= 50_000, `got ${left}`);
  });

  it("extends a pause but never shortens one", () => {
    rpcQueue.halt(60_000);
    const long = rpcQueue.haltRemainingMs();
    rpcQueue.halt(1_000);
    assert.ok(
      rpcQueue.haltRemainingMs() >= long - 50,
      "a second report of the same outage must not cut the first one's wait",
    );
    rpcQueue.halt(120_000);
    assert.ok(rpcQueue.haltRemainingMs() > long, "a longer pause extends it");
  });

  it("ignores a pause length that is not a positive number", () => {
    for (const bad of [0, -1, NaN, Infinity, undefined, null, "60000"]) {
      rpcQueue._resetForTests();
      rpcQueue.halt(bad);
      assert.equal(
        rpcQueue.haltRemainingMs(),
        0,
        `halt(${String(bad)}) must not pause — a misread config cannot wedge the process`,
      );
    }
  });

  it("holds a request that arrives during the pause", async () => {
    rpcQueue.halt(10_000);
    let released = false;
    rpcQueue.acquire().then(() => {
      released = true;
    });
    await tick(30);
    assert.equal(released, false, "must not be released while paused");
    assert.equal(rpcQueue.queueLength(), 1, "it is waiting in the queue");
  });

  /*- The first `acquire` after a reset takes the idle fast path and
   *  resolves synchronously — correctly, since no pause exists yet. Tests
   *  that care about queued callers consume it first so they are
   *  measuring the queue rather than that one free pass. */
  async function consumeFastPath() {
    await rpcQueue.acquire();
  }

  /** Long enough for `n` releases at the configured pace, plus slack. */
  function drainMs(n) {
    return Math.max(rpcQueue.getIntervalMs(), 1) * (n + 1) + 400;
  }

  it("holds requests that were already queued when the pause began", async () => {
    /*- The backlog is the case that matters: releasing it would drain
     *  straight into the endpoints the pause exists to stop calling. */
    await consumeFastPath();
    const released = [];
    for (let i = 0; i < 3; i++) rpcQueue.acquire().then(() => released.push(i));
    rpcQueue.halt(10_000);
    await tick(drainMs(3));
    assert.equal(
      released.length,
      0,
      `nothing may be released once paused, got ${released.length}`,
    );
  });

  it("releases in arrival order once the pause lifts", async () => {
    await consumeFastPath();
    const released = [];
    for (let i = 0; i < 4; i++) rpcQueue.acquire().then(() => released.push(i));
    rpcQueue.halt(40);
    await tick(drainMs(4));
    assert.deepEqual(
      released,
      [0, 1, 2, 3],
      `FIFO must survive a pause, got ${JSON.stringify(released)}`,
    );
  });

  it("leaves exactly one timer in play when a pause lands mid-queue", async () => {
    /*- A second timer would double-drain: two callers released per
     *  interval, at twice the configured request rate. Repeated halts
     *  are the way to provoke one, since each could schedule its own. */
    await consumeFastPath();
    for (let i = 0; i < 3; i++) rpcQueue.acquire();
    rpcQueue.halt(30);
    rpcQueue.halt(30);
    rpcQueue.halt(30);
    await tick(drainMs(3));
    assert.equal(rpcQueue.queueLength(), 0, "everything drained");
  });

  it("still paces after the pause rather than dumping the backlog", async () => {
    const interval = rpcQueue.getIntervalMs();
    if (interval <= 0) return; // pacing disabled in this config
    await consumeFastPath();
    const at = [];
    for (let i = 0; i < 3; i++)
      rpcQueue.acquire().then(() => at.push(Date.now()));
    rpcQueue.halt(40);
    await tick(drainMs(3));
    assert.equal(at.length, 3, "all three released");
    for (let i = 1; i < at.length; i++) {
      const gap = at[i] - at[i - 1];
      assert.ok(
        gap >= interval - 25,
        `release ${i} came ${gap}ms after the last; pacing must survive the pause`,
      );
    }
  });
});
