"use strict";

/**
 * @file test/bot-recorder-lifetime-price-overrides.test.js
 * @description The prices the Lifetime scan values a rebuilt compound
 *   list at (`_scanLifetimePoolData`, src/bot-recorder-lifetime.js): the
 *   fetched current prices, with the operator's price overrides applied
 *   by the rule the poll applies to the panels' figures
 *   (`applyPriceOverrides`, src/price-overrides.js). A Compound entry's
 *   dollar amount after Re-scan Prices or Reload Current Position is
 *   worked out at these prices, so a coin no price service has, which
 *   the operator priced by hand, counts at the operator's price, as it
 *   does in the amount the bot records when the compound happens.
 *
 *   Driven through the scan with the shared harness's stand-ins for the
 *   price fetch and the classifier, which records the prices it is given.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  state,
  resetState,
  installMocks,
  restoreMocks,
  makePosition,
  makeBotState,
} = require("./helpers/bot-recorder-lifetime-mocks");

describe("_scanLifetimePoolData — the prices a rebuilt compound list is valued at", () => {
  let _scanLifetimePoolData;

  beforeEach(() => {
    resetState();
    installMocks();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /** Run a scan that classifies; the prices the classifier was given. */
  async function pricesClassifiedAt(settings) {
    await _scanLifetimePoolData(
      makePosition(),
      makeBotState(settings),
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(state.classifyCalled, true, "the scan classifies");
    const { price0, price1 } = state.classifyOpts;
    return { price0, price1 };
  }

  it("puts an override in place of a coin the price services have no price for", async () => {
    state.currentPrices = { price0: 0, price1: 1.5 };
    assert.deepEqual(await pricesClassifiedAt({ priceOverride0: 5 }), {
      price0: 5,
      price1: 1.5,
    });
  });

  it("puts a forced override in place of a fetched price", async () => {
    state.currentPrices = { price0: 2, price1: 1.5 };
    const settings = { priceOverride1: 7, priceOverrideForce: true };
    assert.deepEqual(await pricesClassifiedAt(settings), {
      price0: 2,
      price1: 7,
    });
  });

  it("keeps the fetched prices where no override is set", async () => {
    state.currentPrices = { price0: 0, price1: 1.5 };
    assert.deepEqual(await pricesClassifiedAt({}), { price0: 0, price1: 1.5 });
  });
});
