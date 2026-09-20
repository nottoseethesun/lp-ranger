/**
 * @file test/rpc-failover-wraps-after-pause.test.js
 * @description
 * Failing the LAST endpoint must pause all RPC traffic and then resume
 * from the FIRST endpoint, not sit on the dead one.
 *
 * The production failure this pins: `failoverToNextRPC` returned `false`
 * and left `_activeIdx` on the last endpoint. `src/rpc-read-retry.js`
 * ignores that return — its comment says `false` "is a reason to come
 * back round to the first one rather than to give up" — so its unbounded
 * loop re-asked the same dead endpoint forever. Observed pinned to the
 * third endpoint on a repeating 502.
 *
 * The wrap is immediate — selection returns to the first endpoint as the
 * pause begins, not as it ends. Nothing is sent while the pause runs, so
 * the endpoint chosen at the start is simply the one the first released
 * request uses, and choosing it up front is what makes `retryRead`
 * correct: it advances BEFORE each attempt, so a wrap deferred to the
 * end of the pause would have it spend that first call on the endpoint
 * that just failed and step from there to the second, skipping the
 * preferred endpoint on every lap.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");
const rpcQueue = require("../src/rpc-request-manager");

const URLS = [
  "https://rpc-one.example",
  "https://rpc-two.example",
  "https://rpc-three.example",
];

class StubProvider {
  constructor(url) {
    this._url = url;
  }
  async send() {
    return "0x1";
  }
}
const LIB = { JsonRpcProvider: StubProvider };

/** Walk failover until the list is exhausted; returns each return value. */
function exhaust() {
  const results = [];
  for (let i = 0; i < URLS.length; i++)
    results.push(sendTx.failoverToNextRPC());
  return results;
}

/**
 * Run `fn` with the clock frozen at a movable instant.
 *
 * The pause is an hour long and is read from config, so reaching the
 * far side of it means owning the clock. `Date.now` is restored however
 * the body exits.
 * @param {(clock: {advance: (ms: number) => void}) => void} fn
 */
function withClock(fn) {
  const realNow = Date.now;
  let at = realNow();
  try {
    Date.now = () => at;
    fn({
      advance: (ms) => {
        at += ms;
      },
    });
  } finally {
    Date.now = realNow;
  }
}

describe("failover wraps to the first endpoint after the pause", () => {
  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    sendTx.init({ urls: URLS }, LIB);
  });

  afterEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("walks the list in order before exhausting it", () => {
    assert.equal(sendTx.getCurrentRPC()._url, URLS[0], "starts at the first");
    sendTx.failoverToNextRPC();
    assert.equal(sendTx.getCurrentRPC()._url, URLS[1]);
    sendTx.failoverToNextRPC();
    assert.equal(sendTx.getCurrentRPC()._url, URLS[2], "the last endpoint");
  });

  it("pauses all RPC traffic when the last endpoint fails", () => {
    assert.equal(rpcQueue.haltRemainingMs(), 0, "not paused to begin with");
    exhaust();
    assert.ok(
      rpcQueue.haltRemainingMs() > 0,
      "exhausting the list must pause the queue, or the retry loop spins on a dead endpoint",
    );
  });

  it("reports the move rather than refusing it", () => {
    /*- `rpc-read-retry` ignores this value, but it must not claim
     *  "nowhere to go" now that exhaustion goes somewhere. */
    const results = exhaust();
    assert.ok(
      results.every((r) => r === true),
      `every step should report a move, got ${JSON.stringify(results)}`,
    );
  });

  it("selects the first endpoint at once, so the first request after the pause uses it", () => {
    /*- The wrap is immediate, not deferred to the end of the pause.
     *  Nothing is sent meanwhile — the queue is halted — so the endpoint
     *  chosen here is precisely the one the first released request will
     *  use.  Deferring it instead would leave `retryRead`, which
     *  advances BEFORE each attempt, spending that first call on the
     *  endpoint that just failed and stepping from there to the second,
     *  skipping the preferred endpoint on every lap. */
    exhaust();
    assert.ok(rpcQueue.haltRemainingMs() > 0, "still held");
    assert.equal(
      sendTx.getCurrentRPC()._url,
      URLS[0],
      "selection must be back at the first endpoint while the pause runs",
    );
  });

  it("moves nothing while the pause runs", () => {
    exhaust();
    assert.equal(
      sendTx.failoverToNextRPC(),
      false,
      "a failure reported during the pause is the outage that started it",
    );
    assert.equal(
      sendTx.getCurrentRPC()._url,
      URLS[0],
      "and must not walk the list forward again while nothing can be sent",
    );
  });

  it("walks the same order again once the pause lifts", () => {
    withClock((clock) => {
      exhaust();
      assert.equal(sendTx.getCurrentRPC()._url, URLS[0], "back at the start");
      clock.advance(rpcQueue.haltRemainingMs());
      sendTx.failoverToNextRPC();
      assert.equal(
        sendTx.getCurrentRPC()._url,
        URLS[1],
        "later failovers must repeat the original order, not resume from the dead end",
      );
      sendTx.failoverToNextRPC();
      assert.equal(sendTx.getCurrentRPC()._url, URLS[2], "and on to the last");
    });
  });

  it("does not pause on a single-endpoint chain", () => {
    /*- The testnet ships one endpoint. There is nothing to fail over to
     *  and nothing an outage-wide pause would achieve. */
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    sendTx.init({ urls: [URLS[0]] }, LIB);
    assert.equal(sendTx.failoverToNextRPC(), false, "nowhere to move");
    assert.equal(
      rpcQueue.haltRemainingMs(),
      0,
      "a one-endpoint chain must not pause itself",
    );
  });
});
