"use strict";

/**
 * @file test/cancel-window-survives-outage.test.js
 * @description Regression guard: an RPC outage must not consume a
 *   transaction's confirm-or-cancel budget.
 *
 * **The bug.** A pending transaction gets `TX_SPEEDUP_SEC` to confirm,
 * then a same-nonce replacement at higher gas, then the remainder of
 * `TX_CANCEL_SEC` for either to land. Past that the bot cancels the
 * nonce with a 0-PLS self-transfer.
 *
 * When failover runs out of endpoints, `src/rpc-request-manager.js`
 * holds EVERY JSON-RPC request for `rpcAllEndpointsDownPauseMS` — one
 * hour by default. `tx.wait()` polls the chain through that same
 * queue, and `sendTransaction` for the speed-up goes through it too,
 * so the hour elapsed inside the wait. Phase 3 computed its remaining
 * budget as `TX_CANCEL_SEC - (now - startTime)`, which had gone
 * negative, and `Math.max(10_000, …)` turned that into ten seconds.
 *
 * So: the chain comes back, and ten seconds later the bot spends gas
 * cancelling a transaction that was never given the hour it was
 * promised — and the log said nothing about why.
 *
 * The budget is time the CHAIN had, not time the clock ran. This pins
 * that distinction.
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");

const rpcRequestManager = require("../src/rpc-request-manager");
const { _cancelWindowMs } = require("../src/rebalancer-pools");
const config = require("../src/config");

const CANCEL_MS = config.TX_CANCEL_SEC * 1000;
const SPEEDUP_MS = config.TX_SPEEDUP_SEC * 1000;
const FLOOR_MS = 10_000;

beforeEach(() => rpcRequestManager._resetForTests());
after(() => rpcRequestManager._resetForTests());

describe("the cancel window is measured in chain time", () => {
  it("gives nearly the whole budget when no outage happened", () => {
    /*- The ordinary path: phase 1 used its speed-up timeout, phase 2
     *  sent a replacement, and the rest of the hour remains. */
    const startTime = Date.now() - SPEEDUP_MS;
    const window = _cancelWindowMs(startTime, 0, "multicall");
    assert.ok(
      window > CANCEL_MS - SPEEDUP_MS - 5_000,
      `expected most of the budget, got ${Math.round(window / 1000)}s`,
    );
    assert.notEqual(window, FLOOR_MS);
  });

  it("does not charge an outage hold to the transaction", () => {
    /*- An hour of hold, served while this transaction waited. Without
     *  the subtraction the window collapses to the floor; with it, the
     *  transaction still has the chain time it was promised.
     *
     *  `haltedAtStart` is the reading taken when the wait began, so an
     *  hour banked since then is an hour this transaction is not
     *  charged for. */
    const pauseMs = 60 * 60 * 1000;
    const startTime = Date.now() - SPEEDUP_MS - pauseMs;
    const haltedAtStart = rpcRequestManager.totalHaltedMs();

    const naive = Math.max(FLOOR_MS, CANCEL_MS - (Date.now() - startTime));
    assert.equal(
      naive,
      FLOOR_MS,
      "the scenario must be one where the old arithmetic collapsed",
    );

    const window = _cancelWindowMs(startTime, haltedAtStart - pauseMs, "swap");
    assert.ok(
      window > CANCEL_MS - SPEEDUP_MS - 5_000,
      `outage time was charged to the budget: ${Math.round(window / 1000)}s`,
    );
  });

  it("still floors a budget genuinely spent on the chain", () => {
    /*- The floor is not the bug and does not go away. A transaction
     *  that really did have its whole hour still gets a last short
     *  window rather than a negative one. */
    const startTime = Date.now() - CANCEL_MS - 60_000;
    assert.equal(_cancelWindowMs(startTime, 0, "mint"), FLOOR_MS);
  });
});

describe("the queue reports how long it held everything", () => {
  it("starts at zero and accrues while a halt runs", async () => {
    assert.equal(rpcRequestManager.totalHaltedMs(), 0);
    rpcRequestManager.halt(60_000);
    await new Promise((r) => setTimeout(r, 25));
    const served = rpcRequestManager.totalHaltedMs();
    assert.ok(served > 0, "a running halt must accrue");
    assert.ok(served < 60_000, "and must not report more than it has served");
  });

  it("never reports more than the halt actually lasted", async () => {
    /*- Capped at the halt's own end: a halt that finished must stop
     *  accruing, or every later deadline would be credited time no
     *  outage took. */
    rpcRequestManager.halt(20);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(rpcRequestManager.totalHaltedMs() <= 20);
  });

  it("accumulates across separate outages", async () => {
    rpcRequestManager.halt(15);
    await new Promise((r) => setTimeout(r, 40));
    const afterFirst = rpcRequestManager.totalHaltedMs();
    rpcRequestManager.halt(15);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(
      rpcRequestManager.totalHaltedMs() > afterFirst,
      "a second outage must add to the first, not replace it",
    );
  });

  it("is cleared by the test reset", () => {
    rpcRequestManager.halt(50_000);
    rpcRequestManager._resetForTests();
    assert.equal(rpcRequestManager.totalHaltedMs(), 0);
  });
});
