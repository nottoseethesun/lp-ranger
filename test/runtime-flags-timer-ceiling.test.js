"use strict";

/**
 * @file test/runtime-flags-timer-ceiling.test.js
 * @description
 * `parseTimerSec` bounds every configured duration that becomes a
 * timer delay, and refuses an out-of-range one rather than falling back
 * to the default.
 *
 * The ceiling is a thousand times the shipped default or 48 hours,
 * whichever is LESSER. Lesser is what keeps every setting clear of the
 * runtime's own limit — a timer holds its delay as a 32-bit count of
 * milliseconds, about 24.8 days, and asked for longer it does not wait
 * longer but fires after one. Taking the greater would not: a thousand
 * times `TX_CANCEL_SEC`'s hour is 41 days, past that limit.
 *
 * The three settings that reach a timer are `TX_SPEEDUP_SEC`,
 * `TX_CANCEL_SEC` and `CHECK_INTERVAL_SEC`; their real defaults are
 * used here so the arithmetic is the arithmetic that ships.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { parseTimerSec } = require("../src/runtime-flags");

/** Shipped defaults, in seconds. */
const SPEEDUP = 120;
const CANCEL = 3600;
const POLL = 300;
/** The absolute cap, and the longest a timer can hold, both in seconds. */
const TWO_DAYS = 48 * 60 * 60;
const TIMER_LIMIT = Math.floor(2_147_483_647 / 1000);

describe("parseTimerSec", () => {
  it("takes the shipped default when nothing overrides it", () => {
    assert.equal(parseTimerSec(undefined, SPEEDUP, "TX_SPEEDUP_SEC"), SPEEDUP);
    assert.equal(parseTimerSec("", POLL, "CHECK_INTERVAL_SEC"), POLL);
    assert.equal(
      parseTimerSec("not-a-number", CANCEL, "TX_CANCEL_SEC"),
      CANCEL,
    );
  });

  it("is a thousand times the default when that is the lesser", () => {
    /*- TX_SPEEDUP_SEC: 1000x two minutes is 33 hours, inside two days. */
    assert.equal(
      parseTimerSec(String(SPEEDUP * 1000), SPEEDUP, "TX_SPEEDUP_SEC"),
      SPEEDUP * 1000,
      "exactly the ceiling is allowed",
    );
    assert.throws(
      () =>
        parseTimerSec(String(SPEEDUP * 1000 + 1), SPEEDUP, "TX_SPEEDUP_SEC"),
      /exceeds its ceiling of 120000 seconds/,
    );
  });

  it("is 48 hours when a thousand times the default overshoots it", () => {
    /*- TX_CANCEL_SEC and CHECK_INTERVAL_SEC both land here. */
    for (const [name, def] of [
      ["TX_CANCEL_SEC", CANCEL],
      ["CHECK_INTERVAL_SEC", POLL],
    ]) {
      assert.ok(def * 1000 > TWO_DAYS, `${name} is the overshooting case`);
      assert.equal(parseTimerSec(String(TWO_DAYS), def, name), TWO_DAYS);
      assert.throws(
        () => parseTimerSec(String(TWO_DAYS + 1), def, name),
        /exceeds its ceiling of 172800 seconds/,
        `${name} must stop at two days`,
      );
    }
  });

  it("puts every setting an order of magnitude inside the timer limit", () => {
    /*- The point of taking the lesser. With the greater, TX_CANCEL_SEC's
     *  ceiling would be 41 days — past the limit, where a timer stops
     *  waiting and fires at once. */
    for (const def of [SPEEDUP, CANCEL, POLL]) {
      const ceiling = Math.min(def * 1000, TWO_DAYS);
      assert.ok(
        ceiling <= TWO_DAYS && TWO_DAYS * 10 < TIMER_LIMIT,
        "no ceiling comes near what a timer can hold",
      );
    }
    assert.throws(
      () => parseTimerSec(String(TIMER_LIMIT), CANCEL, "TX_CANCEL_SEC"),
      /exceeds its ceiling/,
      "the timer limit itself is far out of range, and refused",
    );
  });

  it("refuses rather than falling back, and says what to change", () => {
    assert.throws(
      () => parseTimerSec("999999999", POLL, "CHECK_INTERVAL_SEC"),
      (err) => {
        assert.match(err.message, /CHECK_INTERVAL_SEC=999999999/);
        assert.match(err.message, /1000x the default of 300, or 48 hours/);
        assert.match(err.message, /whichever is lesser/);
        assert.match(err.message, /\.env or app-runtime\.json/);
        return true;
      },
    );
  });

  it("accepts every shipped default well inside its ceiling", () => {
    for (const [name, def] of [
      ["TX_SPEEDUP_SEC", SPEEDUP],
      ["TX_CANCEL_SEC", CANCEL],
      ["CHECK_INTERVAL_SEC", POLL],
    ]) {
      assert.equal(parseTimerSec(undefined, def, name), def);
    }
  });
});
