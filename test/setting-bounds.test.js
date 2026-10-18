"use strict";

/**
 * @file test/setting-bounds.test.js
 * @description `setting-bounds.json` is the one place a checked setting's
 *   range is declared, `src/setting-bounds.js` the one reader of it, and
 *   `src/range-check.js` the one rule for whether a value lies inside a
 *   range, on the server and in the dashboard alike.
 *
 *   Three things are pinned here. The rule itself: inclusive ends, either
 *   end optional, `integer` asking for a whole number, and anything that
 *   is not a finite number outside every range. The file's shape: every
 *   range well formed. And the agreement that makes one file worth having:
 *   every shipped value lies inside its own range, and every reader of a
 *   range reads this file rather than a figure of its own.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const OPENAPI = require("../docs/openapi.json");

const { SETTING_BOUNDS } = require("../src/setting-bounds");
const { withinBound, boundText } = require("../src/range-check");
const { loadShippedDefaults } = require("../src/load-merged-defaults");
const { BOUNDS } = require("../src/config-bounds");
const { assertTimerSec } = require("../src/timer-bounds");
const { GAS_FEE_PCT_MIN, GAS_FEE_PCT_MAX } = require("../src/swap-gates");

const BOT = loadShippedDefaults("bot-config-defaults.json");
const RUNTIME = loadShippedDefaults("app-runtime.json");
const SERVICES = loadShippedDefaults("price-services.json");

/** A range: an object whose only keys are min, max and integer. */
function isRange(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => ["min", "max", "integer"].includes(k))
  );
}

/** Every range in the file, with its path, groups walked. */
function ranges(node, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(node)) {
    if (isRange(v)) out.push([[...prefix, k], v]);
    else if (v && typeof v === "object") out.push(...ranges(v, [...prefix, k]));
  }
  return out;
}

describe("withinBound", () => {
  it("takes both ends as inside", () => {
    assert.equal(withinBound(1, { min: 1, max: 12 }), true);
    assert.equal(withinBound(12, { min: 1, max: 12 }), true);
    assert.equal(withinBound(0, { min: 1, max: 12 }), false);
    assert.equal(withinBound(13, { min: 1, max: 12 }), false);
  });

  it("asks for a whole number only when the range says integer", () => {
    assert.equal(withinBound(5.5, { min: 1, max: 12, integer: true }), false);
    assert.equal(withinBound(5.5, { min: 1, max: 12 }), true);
  });

  it("leaves an end that is not given open", () => {
    assert.equal(withinBound(1e15, { min: 1 }), true);
    assert.equal(withinBound(-1e15, { max: 1 }), true);
  });

  it("holds anything that is not a finite number outside every range", () => {
    for (const v of [undefined, null, "5", NaN, Infinity, -Infinity, {}])
      assert.equal(withinBound(v, { min: 0 }), false, String(v));
  });
});

describe("src/range-check.js", () => {
  it("imports nothing, so the dashboard bundle can take it whole", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "range-check.js"),
      "utf8",
    );
    assert.doesNotMatch(src, /\brequire\(|^\s*import\s/m);
  });
});

describe("boundText", () => {
  it("says what a range accepts", () => {
    assert.equal(
      boundText({ min: 0, max: 10, integer: true }),
      "a whole number from 0 to 10",
    );
    assert.equal(boundText({ min: 0.1 }), "a number of at least 0.1");
    assert.equal(boundText({ max: 9 }), "a number of at most 9");
    assert.equal(boundText({ integer: true }), "a whole number");
  });
});

describe("setting-bounds.json", () => {
  it("holds only well-formed ranges", () => {
    const all = ranges(SETTING_BOUNDS);
    assert.ok(all.length > 30, `found ${all.length} ranges`);
    for (const [where, r] of all) {
      const name = where.join(".");
      if ("min" in r) assert.equal(typeof r.min, "number", name);
      if ("max" in r) assert.equal(typeof r.max, "number", name);
      if ("integer" in r) assert.equal(r.integer, true, name);
      if ("min" in r && "max" in r) assert.ok(r.min <= r.max, name);
    }
  });

  it("holds every shipped bot-config-defaults.json value inside its range", () => {
    let checked = 0;
    for (const [where, r] of ranges(SETTING_BOUNDS)) {
      if (where[0] === "timers" || where[0] === "tx") continue;
      if (where[0] === "dashboard" || where[0] === "geckoTerminal") continue;
      const value = where.reduce((node, k) => node?.[k], BOT);
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values)
        assert.ok(withinBound(v, r), `${where.join(".")} = ${v}`);
      checked++;
    }
    assert.ok(checked > 25, `checked ${checked}`);
  });

  it("holds the shipped values of the other files inside their ranges", () => {
    assert.ok(
      withinBound(RUNTIME.tx.sendRetries, SETTING_BOUNDS.tx.sendRetries),
    );
    assert.ok(
      withinBound(
        RUNTIME.dashboard.pollsBeforeAssumedSeen,
        SETTING_BOUNDS.dashboard.pollsBeforeAssumedSeen,
      ),
    );
    assert.ok(
      withinBound(
        SERVICES.geckoTerminal.topPoolsConsidered,
        SETTING_BOUNDS.geckoTerminal.topPoolsConsidered,
      ),
    );
  });

  it("holds every shipped timer setting inside the timer rule", () => {
    /*-
     *  The settings with a timer range of their own are Bot Settings,
     *  bar the dashboard's poll interval, which the server sends the page.
     */
    const UI_UP = loadShippedDefaults(
      "ui-defaults_non-layout_for-server-up-scenario.json",
    );
    for (const key of Object.keys(SETTING_BOUNDS.timers.settings)) {
      const v = Object.hasOwn(BOT, key) ? BOT[key] : UI_UP[key];
      assert.doesNotThrow(
        () => assertTimerSec({ sec: v, key, defaultSec: v }),
        key,
      );
    }
  });
});

describe("every reader takes its range from setting-bounds.json", () => {
  it("is where a Bot Settings save is checked against", () => {
    for (const [key, bound] of Object.entries(BOUNDS)) {
      const own = key.startsWith("decimalsOverride")
        ? SETTING_BOUNDS.tokenDecimals
        : SETTING_BOUNDS[key];
      assert.equal(bound, own, key);
    }
  });

  it("is where the gas gate's percent range comes from", () => {
    assert.equal(GAS_FEE_PCT_MIN, SETTING_BOUNDS.gasFeePct.min);
    assert.equal(GAS_FEE_PCT_MAX, SETTING_BOUNDS.gasFeePct.max);
  });

  it("caps Max Rebalances Per Day where the server refuses past it", () => {
    const { max } = SETTING_BOUNDS.maxRebalancesPerDay;
    assert.equal(BOUNDS.maxRebalancesPerDay.max, max);
  });

  it("is the range the api reference publishes for each setting", () => {
    /*-
     *  docs/openapi.json states each range for the reader of the api; it
     *  must say what the server enforces.
     */
    const seen = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node.properties || {})) {
        if (!v || !("minimum" in v || "maximum" in v)) continue;
        const own = k.startsWith("decimalsOverride")
          ? SETTING_BOUNDS.tokenDecimals
          : SETTING_BOUNDS[k] || SETTING_BOUNDS.timers.settings[k];
        assert.ok(own, `${k} has a range in the api but none here`);
        assert.equal(v.minimum, own.min, `${k} minimum`);
        assert.equal(v.maximum, own.max, `${k} maximum`);
        seen.push(k);
      }
      for (const v of Object.values(node)) walk(v);
    };
    walk(OPENAPI);
    assert.ok(seen.includes("maxRebalancesPerDay"), seen.join(", "));
  });

  it("leaves no second copy of a range in bot-config-defaults.json", () => {
    for (const k of [
      "gasFeePctMin",
      "gasFeePctMax",
      "impermanentLossGuardPctMin",
      "impermanentLossGuardPctMax",
    ])
      assert.equal(k in BOT, false, k);
  });
});
