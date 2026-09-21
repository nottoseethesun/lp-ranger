"use strict";

/**
 * @file test/runtime-flags-timer-ceiling.test.js
 * @description
 * `src/timer-bounds.js` holds the range for every setting that becomes a
 * `setTimeout` delay, and is the only thing that checks against them.
 * Three roads lead to such a value — the shipped-defaults JSON, `.env`,
 * and `POST /api/config` — and each asks this module.
 *
 * Out of range throws. A value silently replaced by a default leaves the
 * bot on a schedule nobody chose.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { assertTimerSec } = require("../src/timer-bounds");
const { parseTimerSec } = require("../src/runtime-flags");

const POLL = 300;

describe("timer bounds", () => {
  const at = (key) => (sec) => assertTimerSec({ sec, key });

  it("accepts a whole number of seconds inside the setting's range", () => {
    assert.equal(at("checkIntervalSec")(10), 10);
    assert.equal(at("checkIntervalSec")(3600), 3600);
    assert.equal(at("txSpeedupSec")(1), 1);
    assert.equal(at("txSpeedupSec")(3600), 3600);
    assert.equal(at("txCancelSec")(172_800), 172_800);
  });

  it("refuses one past either end", () => {
    assert.throws(() => at("checkIntervalSec")(9), /from 10 to 3600/);
    assert.throws(() => at("checkIntervalSec")(3601), /from 10 to 3600/);
    assert.throws(() => at("txSpeedupSec")(0), /from 1 to 3600/);
    assert.throws(() => at("txSpeedupSec")(3601), /from 1 to 3600/);
    assert.throws(() => at("txCancelSec")(172_801), /from 1 to 172800/);
  });

  it("refuses anything that is not a whole number of seconds", () => {
    for (const bad of [NaN, Infinity, 0.5, -60, "300", null, undefined]) {
      assert.throws(
        () => at("checkIntervalSec")(bad),
        /It must be a whole number of seconds/,
        `${String(bad)} must be refused`,
      );
    }
  });

  it("names the setting and its range, so the message is actionable", () => {
    assert.throws(
      () => at("checkIntervalSec")(7200),
      /checkIntervalSec resolves to 7200\. It must be a whole number of seconds from 10 to 3600\./,
    );
  });

  it("tags the error, so a bad value is not mistaken for a bad file", () => {
    /*- `readBotConfigDefaults` falls back to shipped defaults when it
     *  cannot read its file, and must not do that for a value it
     *  refuses — that would discard every other override with it. */
    try {
      at("checkIntervalSec")(0);
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.badTimerValue, true);
    }
  });

  it("refuses a setting with no declared range, rather than passing it", () => {
    assert.throws(
      () => assertTimerSec({ sec: 300, key: "notASetting" }),
      /no declared range/,
    );
  });
});

describe("timer bounds: the .env road", () => {
  it("names the setting the way .env spells it", () => {
    assert.throws(
      () =>
        parseTimerSec("7200", POLL, "CHECK_INTERVAL_SEC", "checkIntervalSec"),
      (err) => {
        assert.match(err.message, /^\[config\] CHECK_INTERVAL_SEC resolves to/);
        assert.match(err.message, /from 10 to 3600/);
        assert.match(
          err.message,
          /Set CHECK_INTERVAL_SEC in \.env within range/,
        );
        return true;
      },
    );
  });

  it("falls back to the default when only the OVERRIDE is unusable", () => {
    /*- A zero or unparseable override is not a configuration error — it
     *  is no override, and the shipped default stands. */
    for (const v of ["0", "-5", "abc", "", undefined]) {
      assert.equal(
        parseTimerSec(v, POLL, "CHECK_INTERVAL_SEC", "checkIntervalSec"),
        POLL,
      );
    }
  });
});
