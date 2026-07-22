"use strict";

/**
 * @file test/dashboard-setting-labels.test.js
 * @description Tests for `formatSettingChange` and `labelForKey` in
 *   `public/dashboard-setting-labels.js`.  Uses jsdom (via
 *   `global-jsdom/register`) to populate `document` + `fetch`, then
 *   imports the real browser module.  The module's private `_LABELS`
 *   map is (re-)populated per test by stubbing `fetch("/api/setting-labels")`
 *   and awaiting `loadSettingLabels()`.
 *
 *   Pins: the friendly `<label> is now <value><unit>` form on registered
 *   keys, the raw `<key> = <value>` fallback on missing / empty-label
 *   entries, and `labelForKey`'s parallel fallback contract.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;

/*- Populate the module's private `_LABELS` by stubbing fetch to return
 *  the given map, then awaiting `loadSettingLabels()`. */
async function _installLabels(labels) {
  globalThis.fetch = async (url) => {
    if (url === "/api/setting-labels") {
      return { ok: true, json: async () => labels };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  await mod.loadSettingLabels();
}

before(async () => {
  mod = await import("../public/dashboard-setting-labels.js");
});

beforeEach(async () => {
  // Reset to empty map before each test — subsequent tests set up their
  // own fixtures via `_installLabels`.
  await _installLabels({});
});

describe("formatSettingChange()", () => {
  it("returns '<label> is now <value><unit>' when the key is registered", async () => {
    await _installLabels({
      rebalanceRangeWidthPct: {
        label: "Range Width for Rebalancing",
        unit: "%",
      },
    });
    assert.equal(
      mod.formatSettingChange("rebalanceRangeWidthPct", 8),
      "Range Width for Rebalancing is now 8%",
    );
  });

  it("appends unit verbatim (including leading space when the label needs it)", async () => {
    await _installLabels({
      minRebalanceIntervalMin: {
        label: "Min Time Between Rebalances",
        unit: " min",
      },
    });
    assert.equal(
      mod.formatSettingChange("minRebalanceIntervalMin", 15),
      "Min Time Between Rebalances is now 15 min",
    );
  });

  it("handles an empty-unit entry", async () => {
    await _installLabels({
      gasStrategy: { label: "Gas Strategy", unit: "" },
    });
    assert.equal(
      mod.formatSettingChange("gasStrategy", "auto"),
      "Gas Strategy is now auto",
    );
  });

  it("falls back to raw '<key> = <value>' when the key is missing", () => {
    // beforeEach already installed an empty map.
    assert.equal(mod.formatSettingChange("mysteryKey", 42), "mysteryKey = 42");
  });

  it("falls back when the entry exists but the label is empty", async () => {
    await _installLabels({
      x: { label: "", unit: "%" },
    });
    assert.equal(mod.formatSettingChange("x", 1), "x = 1");
  });

  it("does not stringify or round numeric values — passes them through as-is", async () => {
    await _installLabels({
      slippagePct: { label: "Slippage", unit: "%" },
    });
    assert.equal(
      mod.formatSettingChange("slippagePct", 0.75),
      "Slippage is now 0.75%",
    );
  });
});

describe("labelForKey()", () => {
  it("returns the registered label", async () => {
    await _installLabels({
      rebalanceRangeWidthPct: {
        label: "Range Width for Rebalancing",
        unit: "%",
      },
    });
    assert.equal(
      mod.labelForKey("rebalanceRangeWidthPct"),
      "Range Width for Rebalancing",
    );
  });

  it("falls back to the raw key when the entry is missing", () => {
    // beforeEach already installed an empty map.
    assert.equal(mod.labelForKey("unknownKey"), "unknownKey");
  });

  it("falls back to the raw key when the label is empty", async () => {
    await _installLabels({
      x: { label: "", unit: "%" },
    });
    assert.equal(mod.labelForKey("x"), "x");
  });
});
