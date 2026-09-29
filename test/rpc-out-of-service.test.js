/**
 * @file test/rpc-out-of-service.test.js
 * @description
 * The decider that replaced "one error retires an endpoint".
 *
 * Reporting a failure and deciding one are now separate acts: every RPC
 * outcome in the process is reported, and an endpoint moves only when
 * the share of failures inside the window exceeds the configured
 * percentage. These cases pin both halves of that — a single refusal
 * costs nothing, a sustained one costs the endpoint — plus the two
 * rules the rate depends on: successes count toward the denominator,
 * and samples age out of the window.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  noteRpcResult,
  decideIfCurrentRPCIsOutOfService,
  clearRpcSamples,
  _MAX_SECONDS_KEPT,
  _secondsKept,
  _resetForTests,
} = require("../src/rpc-out-of-service");
const { readBotConfigDefaults } = require("../src/bot-config-defaults");

const URL_A = "http://a.test";
const URL_B = "http://b.test";

/** Shipped defaults, so these cases follow the JSON rather than repeat it. */
const PCT = readBotConfigDefaults().rpcFailoverRatePercentage;
const WINDOW_MIN = readBotConfigDefaults().rpcFailoverRateDurationMinutes;

/** Report `n` outcomes of one kind. */
function report(url, ok, n) {
  for (let i = 0; i < n; i++) noteRpcResult(url, ok);
}

describe("an endpoint is out of service by rate, not by one error", () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it("shipped defaults are a rate over minutes", () => {
    /*- The two settings this whole file depends on.  Asserted rather
     *  than assumed, so a change to the JSON fails here and not in
     *  something subtler downstream. */
    assert.equal(PCT, 50);
    assert.equal(WINDOW_MIN, 5);
  });

  it("says no before anything has been reported", () => {
    /*- An endpoint nobody has asked has not been shown to be anything.
     *  Answering yes here would retire endpoints for being idle. */
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), false);
  });

  it("does not retire an endpoint for a single refusal", () => {
    /*- The production defect, stated as its cause: one 502 used to be
     *  sufficient, and three of them an hour apart froze the bot. */
    report(URL_A, true, 20);
    noteRpcResult(URL_A, false);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), false);
  });

  it("retires an endpoint failing more than the configured share", () => {
    report(URL_A, false, 7);
    report(URL_A, true, 3);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), true);
  });

  it("does not retire one failing exactly the configured share", () => {
    /*- The threshold is "exceeds", not "reaches".  Half failing is the
     *  boundary and must not move an endpoint on its own. */
    report(URL_A, false, 5);
    report(URL_A, true, 5);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), false);
  });

  it("counts successes, so volume changes the answer", () => {
    /*- Ten failures mean one thing among twelve requests and another
     *  among a thousand.  Without the denominator the rate is a count
     *  wearing a percent sign. */
    report(URL_A, false, 10);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), true);
    report(URL_A, true, 90);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), false);
  });

  it("forgets samples older than the window", () => {
    /*- What made the production freeze possible: a failure from an hour
     *  ago counted exactly as much as one from a second ago. */
    /*- TEST-ONLY global swap: ageing a tally out of the window needs
     *  the clock, and there is no seam for it. Restored pristine in the
     *  `finally` below, immediately after the calls that needed it. */
    const realNow = Date.now;
    let nowMs = realNow();
    Date.now = () => nowMs;
    try {
      report(URL_A, false, 10);
      assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), true);
      nowMs += (WINDOW_MIN + 1) * 60_000;
      assert.equal(
        decideIfCurrentRPCIsOutOfService(URL_A),
        false,
        "an endpoint is judged on the window, not on its history",
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("judges each endpoint on its own samples", () => {
    report(URL_A, false, 10);
    report(URL_B, true, 10);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), true);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_B), false);
  });

  it("clears an endpoint's record once selection leaves it", () => {
    /*- Coming back to an endpoint later must judge it on what it does
     *  then, not on the window that retired it. */
    report(URL_A, false, 10);
    clearRpcSamples(URL_A);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), false);
  });

  it("holds no more than the window it is judging on", () => {
    /*- The store keeps one tally per second per endpoint, so the
     *  window's length is its size.  A minute of traffic at any rate
     *  is sixty seconds of tallies, not one per request. */
    /*- TEST-ONLY global swap: a minute has to pass to count a minute of
     *  seconds, and there is no seam for the clock. Restored pristine in
     *  the `finally` below, immediately after the calls that needed it. */
    const realNow = Date.now;
    let nowMs = realNow();
    Date.now = () => nowMs;
    try {
      for (let s = 0; s < 60; s++) {
        report(URL_A, true, 500);
        nowMs += 1000;
      }
      assert.equal(_secondsKept(URL_A), 60, "sixty seconds, 30000 requests");
    } finally {
      Date.now = realNow;
    }
  });

  it("caps the seconds kept, so a jumping clock cannot grow the store", () => {
    /*- A system clock that jumps forward writes a tally at a second a
     *  window ending at the present never reaches, so it would survive
     *  every prune.  One jump costs one second; the cap is what bounds
     *  the store if it keeps happening. */
    /*- TEST-ONLY global swap: a clock that jumps is the thing under
     *  test, so it has to be the clock. Restored pristine in the
     *  `finally` below, immediately after the calls that needed it. */
    const realNow = Date.now;
    const start = realNow();
    let nowMs = start;
    Date.now = () => nowMs;
    try {
      for (let i = 0; i < _MAX_SECONDS_KEPT + 500; i++) {
        nowMs += 1000;
        noteRpcResult(URL_A, false);
      }
      /*- Back to where we began: every tally above is now in the
       *  future, and none of them ages out. */
      nowMs = start;
      noteRpcResult(URL_A, false);
      assert.ok(
        _secondsKept(URL_A) <= _MAX_SECONDS_KEPT,
        `held ${_secondsKept(URL_A)} seconds, cap is ${_MAX_SECONDS_KEPT}`,
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("forgets an endpoint entirely once its window empties", () => {
    /*- An endpoint dropped from the operator's list is never asked
     *  again, so nothing would touch it to prune it.  Rebuilding the
     *  whole store rather than deleting keys is what drops it. */
    /*- TEST-ONLY global swap: emptying a window needs the window to
     *  pass, and there is no seam for the clock. Restored pristine in
     *  the `finally` below, immediately after the calls that needed it. */
    const realNow = Date.now;
    let nowMs = realNow();
    Date.now = () => nowMs;
    try {
      report(URL_A, false, 5);
      report(URL_B, true, 5);
      nowMs += (WINDOW_MIN + 1) * 60_000;
      noteRpcResult(URL_B, true);
      assert.equal(_secondsKept(URL_A), 0, "the quiet endpoint is gone");
    } finally {
      Date.now = realNow;
    }
  });

  it("ignores a report with no endpoint named", () => {
    /*- A caller that could not say which endpoint it used has nothing
     *  to contribute, and must not become a sample against whichever
     *  one happens to be selected. */
    noteRpcResult(undefined, false);
    noteRpcResult(null, false);
    noteRpcResult("", false);
    assert.equal(decideIfCurrentRPCIsOutOfService(URL_A), false);
  });
});
