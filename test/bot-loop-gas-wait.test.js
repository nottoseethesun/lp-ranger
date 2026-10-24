"use strict";

/**
 * @file test/bot-loop-gas-wait.test.js
 * @description A rebalance that waited for gas waits `gasDeferRetrySec`
 *   before the bot looks again, not the poll interval.
 *
 *   The wait was lost once already. The scheduler copied the poll
 *   interval when the bot loop built it, and the loop went on writing a
 *   gas wait into a variable nothing read, so a deferred rebalance was
 *   looked at again on every poll while the log promised an hour. The
 *   rule now lives in one pure function, `nextCheckDelayMs`, which each
 *   poll asks with its own result. The first cases pin the rule; the last
 *   pins that the loop asks it, with the poll's own gas deferral, since no
 *   test here can start a real bot loop.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { nextCheckDelayMs } = require("../src/lib/bot-loop-scheduler");

/*-
 *  Off every shipped value (300 000, 3 600 000 and 2 000), so a delay
 *  written into the code instead of taken from these would not match.
 */
const TIMES = {
  checkIntervalMs: 120_000,
  gasDeferMs: 900_000,
  followUpMs: 1_500,
};

describe("nextCheckDelayMs", () => {
  it("waits the poll interval after an ordinary poll", () => {
    const ms = nextCheckDelayMs({
      ...TIMES,
      actionCompleted: false,
      gasDeferred: false,
    });
    assert.equal(ms, TIMES.checkIntervalMs);
  });

  it("waits the gas wait after a rebalance that waited for gas", () => {
    const ms = nextCheckDelayMs({
      ...TIMES,
      actionCompleted: false,
      gasDeferred: true,
    });
    assert.equal(ms, TIMES.gasDeferMs);
  });

  it("looks again at once after a rebalance, compound or cancel", () => {
    const ms = nextCheckDelayMs({
      ...TIMES,
      actionCompleted: true,
      gasDeferred: false,
    });
    assert.equal(ms, TIMES.followUpMs);
  });

  it("goes back to the poll interval once a poll no longer waits for gas", () => {
    const after = [true, false].map((gasDeferred) =>
      nextCheckDelayMs({ ...TIMES, actionCompleted: false, gasDeferred }),
    );
    assert.deepEqual(after, [TIMES.gasDeferMs, TIMES.checkIntervalMs]);
  });
});

describe("the bot loop's next wait", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "lib", "bot-loop.js"),
    "utf8",
  );

  it("is set by each poll's own gas deferral, at gasDeferRetrySec", () => {
    assert.match(
      src,
      /GAS_DEFER_MS = readBotConfigDefaults\(\)\.gasDeferRetrySec \* 1000/,
    );
    assert.match(src, /gasDeferred = result\.gasDeferred === true;/);
    assert.match(
      src,
      /_scheduleNext\(\s*nextCheckDelayMs\(\{[^}]*\bgasDeferred,[^}]*gasDeferMs: GAS_DEFER_MS,/,
    );
  });
});
