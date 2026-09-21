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
      /above its ceiling of 120000 \(1000x its default of 120\)/,
      "and the message names the bound that produced that ceiling",
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
        /above its ceiling of 172800 \(48 hours\)/,
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
      /above its ceiling/,
      "the timer limit itself is far out of range, and refused",
    );
  });

  it("refuses rather than falling back, and says what to change", () => {
    assert.throws(
      () => parseTimerSec("999999999", POLL, "CHECK_INTERVAL_SEC"),
      (err) => {
        assert.match(err.message, /CHECK_INTERVAL_SEC resolves to 999999999/);
        assert.match(err.message, /above its ceiling of 172800 \(48 hours\)/);
        assert.match(err.message, /Set CHECK_INTERVAL_SEC lower in \.env/);
        assert.match(err.message, /app-runtime\.json values it defaults from/);
        return true;
      },
    );
  });

  it("stays coherent when the DEFAULT itself is above the ceiling", () => {
    /*- `TX_CANCEL_SEC` defaults to `DEADLINE_SEC x
     *  cancelToDeadlineMultiple`, and `DEADLINE_SEC` has no ceiling of
     *  its own. A large one therefore puts the DEFAULT out of range, and
     *  the value refused is then one nobody set — so the message must
     *  not tell the operator to lower a setting they never touched, and
     *  must not claim a ceiling of 172800 is "1000x a default of
     *  200000", which is what naming the wrong bound would say. */
    const derived = 50_000 * 4;
    assert.throws(
      () => parseTimerSec(undefined, derived, "TX_CANCEL_SEC"),
      (err) => {
        assert.match(err.message, /TX_CANCEL_SEC resolves to 200000 seconds/);
        assert.match(err.message, /above its ceiling of 172800 \(48 hours\)/);
        assert.doesNotMatch(
          err.message,
          /1000x/,
          "48 hours is what bound it, so 1000x must not be named",
        );
        assert.match(
          err.message,
          /correct the app-runtime\.json values it defaults from/,
          "and the operator is pointed at the setting that actually moves it",
        );
        return true;
      },
    );
  });

  it("refuses a default that is not a whole number of seconds", () => {
    /*- `parsePositiveInt` vets the override and passes the fallback
     *  through untouched, so a bad default arrives intact.
     *  `TX_CANCEL_SEC` is where that is reachable: it defaults to
     *  `deadlineSec x cancelToDeadlineMultiple`, so a zero multiplier
     *  gives 0 and a non-numeric one gives NaN.
     *
     *  Both are worse than they look — `setTimeout` treats NaN as 1 ms,
     *  and the cancel phase's 10-second floor cannot catch it either,
     *  since `Math.max(10000, NaN)` is NaN. Every transaction would
     *  have its nonce cancelled about a millisecond after the speed-up. */
    for (const bad of [0, -60, NaN, 0.5, Infinity]) {
      assert.throws(
        () => parseTimerSec(undefined, bad, "TX_CANCEL_SEC"),
        /is not a whole number of seconds of at least 1/,
        `a default of ${String(bad)} must be refused`,
      );
    }
  });

  it("reports a negative as what it is, not as too large", () => {
    /*- Order matters: the ceiling of a negative default is itself
     *  negative, so checking the ceiling first would call -60 "above
     *  its ceiling of -60000". */
    assert.throws(
      () => parseTimerSec(undefined, -60, "TX_CANCEL_SEC"),
      (err) => {
        assert.match(err.message, /resolves to -60/);
        assert.doesNotMatch(err.message, /above its ceiling/);
        return true;
      },
    );
  });

  it("still falls back when only the OVERRIDE is unusable", () => {
    /*- A zero or negative override is not a configuration error — it is
     *  no override at all, and the shipped default stands. */
    assert.equal(parseTimerSec("0", POLL, "CHECK_INTERVAL_SEC"), POLL);
    assert.equal(parseTimerSec("-5", POLL, "CHECK_INTERVAL_SEC"), POLL);
    assert.equal(parseTimerSec("abc", POLL, "CHECK_INTERVAL_SEC"), POLL);
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
