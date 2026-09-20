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
 * Selection does not move during the pause — the app sits on the
 * endpoint it was on, since nothing can be sent anyway. The list returns
 * to its first endpoint when the wait is up, through the same sticky
 * snapback `getCurrentRPC` already runs: no second timer, and nothing
 * else changes.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");

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

/*- Matches an ANSI colour escape.  Built from the ESC char code because
 *  `no-control-regex` rejects a literal one inside a pattern. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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

  it("stays on the current endpoint while the pause runs", () => {
    exhaust();
    assert.ok(rpcQueue.haltRemainingMs() > 0, "still held");
    assert.equal(
      sendTx.getCurrentRPC()._url,
      URLS[URLS.length - 1],
      "nothing can be sent, so there is nothing to move for",
    );
  });

  it("announces the pause in capitals, on Road Sign Yellow, in hours", () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a);
    try {
      exhaust();
    } finally {
      console.warn = origWarn;
    }
    /*- Render the way the terminal does: the `%s` values carry the
     *  endpoint and the wait, so the raw format string shows neither. */
    const banner = warns
      .map((a) => format(...a))
      .find((s) => s.includes("ENDPOINT(S) FAILED"));
    assert.ok(
      banner,
      `no exhaustion banner logged, got ${JSON.stringify(warns)}`,
    );
    /*- Bold black on #FFCC00 = 255;204;0, 24-bit background escape. */
    assert.ok(
      banner.includes("48;2;255;204;0"),
      "the line must carry the Road Sign Yellow background",
    );
    assert.ok(
      banner.includes("HOUR(S)"),
      `the wait must be stated in hours, got: ${banner}`,
    );
    /*- Text only — the colour escapes are not letters, and the log's own
     *  timestamp prefix is not part of this line's wording. */
    const words = banner
      .replace(ANSI, "")
      .replace(/\[\d{4}-\d\d-\d\d [\d:]+\]/, "");
    assert.equal(words, words.toUpperCase(), "the line must be all capitals");
  });

  it("walks the same order again once the pause lifts", () => {
    withClock((clock) => {
      sendTx.failoverToNextRPC(); // first → second
      sendTx.failoverToNextRPC(); // second → last
      /*- Endpoints fail one at a time, not all in the same millisecond.
       *  This gap is what separates the wait's own deadline from the
       *  ordinary failover window that last move opened — both are an
       *  hour by default, so without a gap nothing can tell which of
       *  them released the endpoint. It must be the wait's. */
      clock.advance(30 * 60_000);
      sendTx.failoverToNextRPC(); // last → exhausted
      const waitLeft = rpcQueue.haltRemainingMs();

      clock.advance(waitLeft - 1);
      assert.equal(
        sendTx.getCurrentRPC()._url,
        URLS[URLS.length - 1],
        "a millisecond before the wait is up, still on the endpoint it was on",
      );
      clock.advance(1);
      assert.equal(
        sendTx.getCurrentRPC()._url,
        URLS[0],
        "the wait is up, so the list starts over at the first endpoint",
      );
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
