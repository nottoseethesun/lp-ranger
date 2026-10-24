/**
 * @file test/price-overrides.test.js
 * @description The operator's token price overrides, applied to fetched
 * prices: the one rule the poll's pricing, the unmanaged details path and
 * a rebalance's Activity Log figure all use.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { applyPriceOverrides } = require("../src/price-overrides");

/** A position's saved settings, read by key as the bot reads them. */
const settings = (saved) => (key) => saved[key];

describe("applyPriceOverrides", () => {
  it("stands in for a fetched price of zero or less", () => {
    const got = applyPriceOverrides(
      { price0: 0, price1: -1 },
      settings({ priceOverride0: 1.5, priceOverride1: 2.5 }),
    );
    assert.deepEqual(got, { price0: 1.5, price1: 2.5 });
  });

  it("leaves a fetched price above zero alone, without force", () => {
    const got = applyPriceOverrides(
      { price0: 2, price1: 3 },
      settings({ priceOverride0: 10, priceOverride1: 20 }),
    );
    assert.deepEqual(got, { price0: 2, price1: 3 });
  });

  it("replaces every fetched price in force mode", () => {
    const got = applyPriceOverrides(
      { price0: 2, price1: 3 },
      settings({
        priceOverride0: 10,
        priceOverride1: 20,
        priceOverrideForce: true,
      }),
    );
    assert.deepEqual(got, { price0: 10, price1: 20 });
  });

  it("applies an override of zero to nothing, even in force mode", () => {
    const got = applyPriceOverrides(
      { price0: 2, price1: 0 },
      settings({
        priceOverride0: 0,
        priceOverride1: 0,
        priceOverrideForce: true,
      }),
    );
    assert.deepEqual(got, { price0: 2, price1: 0 });
  });

  it("applies nothing without a way to read the settings", () => {
    assert.deepEqual(applyPriceOverrides({ price0: 0, price1: 4 }), {
      price0: 0,
      price1: 4,
    });
  });

  it("does not change the prices it was given", () => {
    const fetched = { price0: 0, price1: 4 };
    applyPriceOverrides(fetched, settings({ priceOverride0: 9 }));
    assert.deepEqual(fetched, { price0: 0, price1: 4 });
  });
});
