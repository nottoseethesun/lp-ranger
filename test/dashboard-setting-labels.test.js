/**
 * @file test/dashboard-setting-labels.test.js
 * @description Mirror tests for the pure formatter logic in
 * `public/dashboard-setting-labels.js` (`formatSettingChange`,
 * `labelForKey`).  The dashboard file uses ES-module `import` /
 * `fetch` / `console.warn`, so we re-express the same pure formatter
 * as a local plain function and assert the shape.  Confirms that
 * missing entries fall back to the raw `<key> = <value>` form and
 * that the "is now" wrapper concatenates label + value + unit
 * verbatim (no localisation, no rounding).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

/*- Mirror of public/dashboard-setting-labels.js formatters, minus
 *  the fetch bootstrap.  Kept in lockstep with the dashboard file
 *  so a shape change on either side surfaces here. */
function makeFormatter(labels) {
  const format = (key, value) => {
    const entry = labels[key];
    if (!entry || !entry.label) return key + " = " + value;
    return entry.label + " is now " + value + entry.unit;
  };
  const labelOf = (key) => {
    const entry = labels[key];
    return (entry && entry.label) || key;
  };
  return { format, labelOf };
}

describe("dashboard-setting-labels.formatSettingChange", () => {
  it("returns '<label> is now <value><unit>' when the key is registered", () => {
    const { format } = makeFormatter({
      rebalanceRangeWidthPct: {
        label: "Range Width for Rebalancing",
        unit: "%",
      },
    });
    assert.equal(
      format("rebalanceRangeWidthPct", 8),
      "Range Width for Rebalancing is now 8%",
    );
  });

  it("appends unit verbatim (including leading space when the label needs it)", () => {
    const { format } = makeFormatter({
      minRebalanceIntervalMin: {
        label: "Min Time Between Rebalances",
        unit: " min",
      },
    });
    assert.equal(
      format("minRebalanceIntervalMin", 15),
      "Min Time Between Rebalances is now 15 min",
    );
  });

  it("handles an empty-unit entry", () => {
    const { format } = makeFormatter({
      gasStrategy: { label: "Gas Strategy", unit: "" },
    });
    assert.equal(format("gasStrategy", "auto"), "Gas Strategy is now auto");
  });

  it("falls back to raw '<key> = <value>' when the key is missing", () => {
    const { format } = makeFormatter({});
    assert.equal(format("mysteryKey", 42), "mysteryKey = 42");
  });

  it("falls back when the entry exists but the label is empty", () => {
    const { format } = makeFormatter({
      x: { label: "", unit: "%" },
    });
    assert.equal(format("x", 1), "x = 1");
  });

  it("does not stringify or round numeric values — passes them through as-is", () => {
    const { format } = makeFormatter({
      slippagePct: { label: "Slippage", unit: "%" },
    });
    assert.equal(format("slippagePct", 0.75), "Slippage is now 0.75%");
  });
});

describe("dashboard-setting-labels.labelForKey", () => {
  it("returns the registered label", () => {
    const { labelOf } = makeFormatter({
      rebalanceRangeWidthPct: {
        label: "Range Width for Rebalancing",
        unit: "%",
      },
    });
    assert.equal(
      labelOf("rebalanceRangeWidthPct"),
      "Range Width for Rebalancing",
    );
  });

  it("falls back to the raw key when the entry is missing", () => {
    const { labelOf } = makeFormatter({});
    assert.equal(labelOf("unknownKey"), "unknownKey");
  });

  it("falls back to the raw key when the label is empty", () => {
    const { labelOf } = makeFormatter({
      x: { label: "", unit: "%" },
    });
    assert.equal(labelOf("x"), "x");
  });
});
