/**
 * @file test/config-env-ranges.test.js
 * @description The five Bot Settings `.env` can set are held to their
 *   ranges in setting-bounds.json at startup, as a save from the dashboard
 *   is, and so is DEADLINE_SEC, the transaction deadline, to the range of
 *   app-runtime.json's `tx.deadlineSec`.
 *
 *   A value inside the range is used. A value outside it, a fraction for
 *   a whole-number setting, or text stops startup with a message naming
 *   the variable and its range. Taken any other way, such a value would
 *   either run the bot on a figure the dashboard refuses, or be quietly
 *   replaced or cut short, leaving the bot on a setting nobody chose. A
 *   variable left unset, or set to nothing, leaves the shipped default
 *   standing.
 *
 *   Each case loads the real `src/config.js` afresh, as
 *   `test/config-startup-checks.test.js` does. The five variables are
 *   pinned to nothing BEFORE anything under `src/` is required, because
 *   dotenv leaves a variable alone once it is set, so the operator's own
 *   `.env` cannot reach these cases. Operator overrides are read from a
 *   directory of the test's own, whose bot-config-defaults.json moves
 *   each of the five defaults off its shipped value, so a default written
 *   into the code fails.
 */

"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS = [
  ["REBALANCE_OOR_THRESHOLD_PCT", "rebalanceOutOfRangeThresholdPercent"],
  ["REBALANCE_TIMEOUT_MIN", "rebalanceTimeoutMin"],
  ["MIN_REBALANCE_INTERVAL_MIN", "minRebalanceIntervalMin"],
  ["MAX_REBALANCES_PER_DAY", "maxRebalancesPerDay"],
  ["IMPERMANENT_LOSS_GUARD_PCT", "impermanentLossGuardPct"],
];

// Each of the five defaults, moved off its shipped value.
const DEFAULTS = {
  rebalanceOutOfRangeThresholdPercent: 7,
  rebalanceTimeoutMin: 150,
  minRebalanceIntervalMin: 12,
  maxRebalancesPerDay: 6,
  impermanentLossGuardPct: 25,
};

// The deadline, moved off its shipped value too.
const DEADLINE_SEC = 1200;

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "env-ranges-"));
fs.writeFileSync(
  path.join(_USER_DIR, "bot-config-defaults.json"),
  JSON.stringify(DEFAULTS),
);
fs.writeFileSync(
  path.join(_USER_DIR, "app-runtime.json"),
  JSON.stringify({ tx: { deadlineSec: DEADLINE_SEC } }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
for (const [envName] of SETTINGS) process.env[envName] = "";
process.env.DEADLINE_SEC = "";

after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const BOUNDS = require("../app-config/app-defaults-for-user-configurable/setting-bounds.json");
const { boundText } = require("../src/range-check");

/** Load `src/config.js` as startup would, with `envName` set to `value`. */
function loadWith(envName, value) {
  process.env[envName] = value;
  try {
    for (const mod of [
      "load-merged-defaults",
      "runtime-flags",
      "cache-store",
      "config",
    ])
      delete require.cache[require.resolve(`../src/${mod}`)];
    return require("../src/config");
  } finally {
    process.env[envName] = "";
  }
}

/** Expect startup to refuse `value` for `envName`, naming both. */
function refuses(envName, key, value) {
  const expected = `${envName} in .env must be ${boundText(BOUNDS[key])}; it is "${value}"`;
  assert.throws(
    () => loadWith(envName, value),
    (err) => err.message.includes(expected),
  );
}

for (const [envName, key] of SETTINGS) {
  const bound = BOUNDS[key];
  describe(`${envName} in .env`, () => {
    it("is used when it lies inside its range", () => {
      assert.equal(loadWith(envName, String(bound.max))[envName], bound.max);
    });

    it("leaves the default standing when set to nothing", () => {
      assert.equal(loadWith(envName, "")[envName], DEFAULTS[key]);
    });

    it("stops startup when above its range, naming the variable and the range", () => {
      refuses(envName, key, String(bound.max + 1));
    });

    it("stops startup when below its range", () => {
      refuses(envName, key, String(bound.min - 1));
    });

    it("stops startup on text, rather than falling back to the default", () => {
      refuses(envName, key, "abc");
    });

    if (bound.integer === true)
      it("stops startup on a fraction, rather than cutting it short", () => {
        refuses(envName, key, `${bound.max - 1}.5`);
      });
  });
}

describe("REBALANCE_TIMEOUT_MIN in .env", () => {
  it("takes 0, which turns the out-of-range timeout off", () => {
    assert.equal(
      loadWith("REBALANCE_TIMEOUT_MIN", "0").REBALANCE_TIMEOUT_MIN,
      0,
    );
  });
});

describe("DEADLINE_SEC in .env", () => {
  const bound = BOUNDS.tx.deadlineSec;
  /*-
   *  Past the range's end, a deadline could carry the cancel timer
   *  derived from it, the deadline times its multiple, past 48 hours.
   */
  const refusesDeadline = (value) =>
    assert.throws(
      () => loadWith("DEADLINE_SEC", value),
      (err) =>
        err.message.includes(
          `DEADLINE_SEC in .env must be ${boundText(bound)}; it is "${value}"`,
        ),
    );

  it("is used when it lies inside its range", () => {
    assert.equal(
      loadWith("DEADLINE_SEC", String(bound.max)).DEADLINE_SEC,
      bound.max,
    );
  });

  it("leaves app-runtime.json's deadline standing when set to nothing", () => {
    assert.equal(loadWith("DEADLINE_SEC", "").DEADLINE_SEC, DEADLINE_SEC);
  });

  it("stops startup outside its range, naming the variable and the range", () => {
    refusesDeadline(String(bound.max + 1));
    refusesDeadline(String(bound.min - 1));
  });
});
