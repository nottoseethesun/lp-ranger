/**
 * @file test/rebalance-lock.test.js
 * @description Tests for the async rebalance mutex.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createRebalanceLock } = require("../src/lib/rebalance-lock");

describe("rebalance-lock", () => {
  it("grants lock immediately when idle", async () => {
    const lock = createRebalanceLock();
    const release = await lock.acquire();
    assert.equal(typeof release, "function");
    release();
  });

  it("serializes two concurrent acquires", async () => {
    const lock = createRebalanceLock();
    const order = [];

    const release1 = await lock.acquire();
    order.push("acquired-1");

    // Second acquire should not resolve until first releases
    const p2 = lock.acquire().then((rel) => {
      order.push("acquired-2");
      return rel;
    });

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["acquired-1"]);

    release1();
    const release2 = await p2;
    assert.deepEqual(order, ["acquired-1", "acquired-2"]);
    release2();
  });

  it("serializes three concurrent acquires in FIFO order", async () => {
    const lock = createRebalanceLock();
    const order = [];

    const release1 = await lock.acquire();
    order.push(1);

    const p2 = lock.acquire().then((rel) => {
      order.push(2);
      return rel;
    });
    const p3 = lock.acquire().then((rel) => {
      order.push(3);
      return rel;
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, [1]);

    release1();
    const release2 = await p2;
    assert.deepEqual(order, [1, 2]);

    release2();
    const release3 = await p3;
    assert.deepEqual(order, [1, 2, 3]);
    release3();
  });

  it("pending() reports waiting callers", async () => {
    const lock = createRebalanceLock();
    assert.equal(lock.pending(), 0);

    const release1 = await lock.acquire();
    assert.equal(lock.pending(), 0); // holder doesn't count as pending

    const p2 = lock.acquire();
    const p3 = lock.acquire();
    // Give microtasks time
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lock.pending(), 2);

    release1();
    const release2 = await p2;
    assert.equal(lock.pending(), 1);

    release2();
    const release3 = await p3;
    assert.equal(lock.pending(), 0);
    release3();
  });

  it("works after release-and-reacquire cycle", async () => {
    const lock = createRebalanceLock();

    const r1 = await lock.acquire();
    r1();

    const r2 = await lock.acquire();
    r2();

    const r3 = await lock.acquire();
    r3();
    // No assertions needed — if it doesn't hang, it works
  });
});
