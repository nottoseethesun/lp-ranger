"use strict";

/**
 * @file test/runtime-flags-timer-ceiling.test.js
 * @description
 * `src/timer-bounds.js` decides whether a configured number of seconds
 * may become a `setTimeout` delay, and it is the only thing that
 * decides. Three roads lead to such a value — the shipped-defaults JSON,
 * `.env`, and `POST /api/config` — and each asks this module, because
 * three copies of the rule gave three different answers to the same
 * question.
 *
 * Out of range throws. A value silently replaced by a default leaves the
 * bot on a schedule nobody chose, and the schedule is then the last
 * thing anyone would think to check.
 *
 * Two kinds of bound. Most settings take the general one: 1000x their
 * shipped default, or 48 hours, whichever is LESSER. Lesser is what
 * keeps them clear of the runtime's own limit — a timer holds its delay
 * as a 32-bit count of milliseconds, about 24.8 days, and asked for
 * longer it fires after one instead. `txCancelSec` is why: 1000x its
 * hour is 41 days, past that limit. A setting with a sensible range of
 * its own declares it instead, and `checkIntervalSec` does: 10 to 3600.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { assertTimerSec } = require("../src/timer-bounds");
const { parseTimerSec } = require("../src/runtime-flags");

/** Shipped defaults, in seconds. */
const SPEEDUP = 120;
const CANCEL = 3600;
const POLL = 300;

describe("timer bounds: the poll interval's own range", () => {
  const poll = (sec) =>
    assertTimerSec({ sec, key: "checkIntervalSec", defaultSec: POLL });

  it("accepts 10 through 3600", () => {
    for (const good of [10, 11, 300, 3599, 3600]) {
      assert.equal(poll(good), good);
    }
  });

  it("refuses below 10 and above 3600", () => {
    assert.throws(
      () => poll(9),
      /not a whole number of seconds of at least 10/,
    );
    assert.throws(() => poll(3601), /above its maximum of 3600/);
    assert.throws(() => poll(7200), /above its maximum of 3600/);
  });

  it("takes its own range over the general rule", () => {
    /*- The general rule would give 1000x300 against 48 hours, so 172800.
     *  An hour between looks at a position is already past any use. */
    assert.throws(() => poll(172_800), /above its maximum of 3600/);
  });
});

describe("timer bounds: the general rule", () => {
  it("is a thousand times the default when that is the lesser", () => {
    const speedup = (sec) =>
      assertTimerSec({ sec, key: "txSpeedupSec", defaultSec: SPEEDUP });
    assert.equal(speedup(SPEEDUP * 1000), SPEEDUP * 1000);
    assert.throws(
      () => speedup(SPEEDUP * 1000 + 1),
      /above its maximum of 120000/,
    );
  });

  it("is 48 hours when a thousand times the default overshoots it", () => {
    /*- 1000x txCancelSec's hour is 41 days, past what a timer holds. */
    const cancel = (sec) =>
      assertTimerSec({ sec, key: "txCancelSec", defaultSec: CANCEL });
    assert.equal(cancel(172_800), 172_800);
    assert.throws(() => cancel(172_801), /above its maximum of 172800/);
  });
});

describe("timer bounds: values that are not numbers of seconds", () => {
  it("refuses zero, negatives, fractions, NaN and Infinity", () => {
    for (const bad of [0, -60, NaN, 0.5, Infinity, "300"]) {
      assert.throws(
        () =>
          assertTimerSec({ sec: bad, key: "txCancelSec", defaultSec: CANCEL }),
        /is not a whole number of seconds/,
        `${String(bad)} must be refused`,
      );
    }
  });

  it("reports a negative as what it is, not as too large", () => {
    /*- Order matters: the maximum derived from a negative default is
     *  itself negative, so checking that first would call -60 "above its
     *  maximum of -60000". */
    assert.throws(
      () => assertTimerSec({ sec: -60, key: "txCancelSec", defaultSec: -60 }),
      (err) => {
        assert.match(err.message, /resolves to -60/);
        assert.doesNotMatch(err.message, /above its maximum/);
        return true;
      },
    );
  });

  it("stays coherent when the DEFAULT itself is out of range", () => {
    /*- `txCancelSec` defaults to `deadlineSec x cancelToDeadlineMultiple`
     *  and `DEADLINE_SEC` has no bound of its own, so a large one puts
     *  the DEFAULT past the maximum — and the value refused is then one
     *  nobody typed. */
    assert.throws(
      () =>
        assertTimerSec({
          sec: 200_000,
          key: "txCancelSec",
          defaultSec: 200_000,
        }),
      /resolves to 200000 seconds, above its maximum of 172800/,
    );
  });

  it("tags the error, so a bad value is not mistaken for a bad file", () => {
    /*- `readBotConfigDefaults` falls back to shipped defaults when it
     *  cannot read its file, and must NOT do that here — falling back
     *  would discard every other override alongside the bad one. */
    try {
      assertTimerSec({ sec: 0, key: "checkIntervalSec", defaultSec: POLL });
      assert.fail("should have thrown");
    } catch (err) {
      assert.equal(err.badTimerValue, true);
    }
  });
});

describe("timer bounds: the default the maximum is derived from", () => {
  it("refuses to bound a value against a default that is not a number", () => {
    /*- The maximum is `min(defaultSec * 1000, 48h, any explicit max)`.
     *  A broken `defaultSec` does not weaken that — it removes it:
     *  `Math.min(NaN, …)` is NaN and `x > NaN` is false, so every value
     *  would pass, including past a setting's own explicit maximum.
     *
     *  Reachable: `txSpeedupSec`'s shipped default is read raw from
     *  `app-runtime.json`, so mistyping it there and setting a large
     *  `.env` override got the override accepted. */
    for (const bad of [NaN, undefined, null, "120", Infinity, {}]) {
      assert.throws(
        () =>
          assertTimerSec({
            sec: 999_999,
            key: "txSpeedupSec",
            defaultSec: bad,
          }),
        /cannot be bounded: its shipped default is/,
        `a default of ${String(bad)} must not silently remove the maximum`,
      );
    }
  });

  it("says the install is wrong, not the value the operator set", () => {
    assert.throws(
      () =>
        assertTimerSec({ sec: 300, key: "checkIntervalSec", defaultSec: NaN }),
      /The install's JSON defaults are wrong, not the value you set/,
    );
  });

  it("does not let a broken default defeat an explicit maximum", () => {
    /*- checkIntervalSec declares its own 3600. That must not evaporate
     *  because the default it sits beside is unreadable. */
    assert.throws(
      () =>
        assertTimerSec({
          sec: 999_999,
          key: "checkIntervalSec",
          defaultSec: NaN,
        }),
      /cannot be bounded/,
    );
  });
});

describe("timer bounds: a setting counted in milliseconds", () => {
  /*-
   *  A key whose name ends in "ms", either case, is counted in
   *  milliseconds, and a refusal must say so: "3000001 seconds" would
   *  send the operator looking for a value a thousand times too large.
   */
  const POLL_MS = 3000;
  /*-
   *  A setting counted in milliseconds that has no range of its own, so
   *  the general rule applies; the dashboard's poll interval, once the
   *  example here, now declares one.
   */
  const poll = (sec) =>
    assertTimerSec({
      sec,
      key: "copyFeedbackMs",
      defaultSec: POLL_MS,
    });

  it("names milliseconds when refusing a value below the minimum", () => {
    assert.throws(
      () => poll(0),
      (err) => {
        assert.match(err.message, /whole number of milliseconds of at least 1/);
        assert.doesNotMatch(err.message, /\bseconds\b/);
        return true;
      },
    );
  });

  it("names milliseconds when refusing a value above the maximum", () => {
    assert.equal(poll(POLL_MS * 1000), POLL_MS * 1000);
    assert.throws(
      () => poll(POLL_MS * 1000 + 1),
      /resolves to 3000001 milliseconds, above its maximum of 3000000\./,
    );
  });

  it("caps at 48 hours counted in milliseconds, however the key is cased", () => {
    const pause = (sec) =>
      assertTimerSec({
        sec,
        key: "rpcAllEndpointsDownPauseMS",
        defaultSec: 3_600_000,
      });
    assert.equal(pause(172_800_000), 172_800_000);
    assert.throws(
      () => pause(172_800_001),
      /resolves to 172800001 milliseconds, above its maximum of 172800000\./,
    );
  });
});

describe("timer bounds: the dashboard's poll interval", () => {
  /*-
   *  An operator can now set it, so it has a range of its own: under half
   *  a second every open tab would flood the server, and past a minute the
   *  figures go stale.
   */
  const dashPoll = (sec) =>
    assertTimerSec({ sec, key: "dashboardPollIntervalMs", defaultSec: 3000 });

  it("accepts half a second to a minute", () => {
    assert.equal(dashPoll(500), 500);
    assert.equal(dashPoll(60_000), 60_000);
  });

  it("refuses a value outside that range, in milliseconds", () => {
    assert.throws(() => dashPoll(499), /milliseconds of at least 500/);
    assert.throws(
      () => dashPoll(60_001),
      /resolves to 60001 milliseconds, above its maximum of 60000\./,
    );
  });
});

describe("timer bounds: the .env road", () => {
  /** The poll interval as read from an environment holding `text`. */
  const poll = (text) =>
    parseTimerSec("CHECK_INTERVAL_SEC", POLL, "checkIntervalSec", {
      CHECK_INTERVAL_SEC: text,
    });

  it("names the setting the way .env spells it", () => {
    assert.throws(
      () => poll("7200"),
      (err) => {
        assert.match(err.message, /^\[config\] CHECK_INTERVAL_SEC resolves to/);
        assert.match(err.message, /above its maximum of 3600/);
        assert.match(
          err.message,
          /Set CHECK_INTERVAL_SEC in \.env within range/,
        );
        return true;
      },
    );
  });

  it("refuses text that is not a whole number, naming the setting", () => {
    /*- Read by its rule in src/env-settings.js, never coerced: a comma or
     *  an exponent once read as 1 second, and a zero, a sign or a word as
     *  the default, with nothing said. */
    for (const v of ["0", "-5", "abc", "1,800", "1e3", "2.5"])
      assert.throws(() => poll(v), /CHECK_INTERVAL_SEC in \.env must be/, v);
  });

  it("leaves the default standing when the variable is unset or blank", () => {
    for (const v of ["", "  ", undefined]) assert.equal(poll(v), POLL);
  });
});
