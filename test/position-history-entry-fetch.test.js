"use strict";

/**
 * @file test/position-history-entry-fetch.test.js
 * @description `needsEntryFromChain` — the decision that controls
 *   whether the mint receipt is read for a position's deposited token
 *   amounts.
 *
 *   Those amounts (`entryAmount0/1`) are what per-epoch impermanent
 *   loss is measured against, and the condition must ask about them
 *   directly rather than about the USD value. A position this bot
 *   rebalanced itself already has its value in `rebalance_log.json`, so
 *   a value-only test skips the receipt, leaves the amounts unset, and
 *   IL comes out as the whole position value instead of a loss.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { needsEntryFromChain } = require("../src/position-history");

/** A result with everything the fetch requires, plus overrides. */
const result = (over = {}) => ({
  entryValueUsd: null,
  entryAmount0: null,
  mintTxHash: "0xabc",
  token0UsdPriceAtOpen: 0.001,
  ...over,
});

describe("needsEntryFromChain", () => {
  it("fetches when nothing is known yet", () => {
    assert.equal(needsEntryFromChain(result()), true);
  });

  it("fetches when the value is known but the amounts are not", () => {
    /*- The regression. `entryValueUsd` from the rebalance log used to
     *  suppress this, leaving hodlAmount0/1 at zero. */
    assert.equal(
      needsEntryFromChain(result({ entryValueUsd: 1671.0 })),
      true,
      "a known USD value must not suppress the amounts lookup",
    );
  });

  it("skips once both the value and the amounts are present", () => {
    assert.equal(
      needsEntryFromChain(
        result({ entryValueUsd: 1671.0, entryAmount0: 497587.29 }),
      ),
      false,
    );
  });

  it("treats an undefined amount as missing, not as present", () => {
    assert.equal(
      needsEntryFromChain(
        result({ entryValueUsd: 1671.0, entryAmount0: undefined }),
      ),
      true,
    );
  });

  it("accepts a legitimate zero amount as present", () => {
    /*- A single-sided mint really can deposit zero of one token, so
     *  zero must not read as "missing" and re-fetch forever. */
    assert.equal(
      needsEntryFromChain(result({ entryValueUsd: 1671.0, entryAmount0: 0 })),
      false,
    );
  });

  it("cannot fetch without a mint transaction to read", () => {
    assert.equal(needsEntryFromChain(result({ mintTxHash: null })), false);
  });

  it("cannot fetch without an opening price to value it with", () => {
    assert.equal(
      needsEntryFromChain(result({ token0UsdPriceAtOpen: null })),
      false,
    );
  });
});
