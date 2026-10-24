"use strict";

/**
 * @file test/dashboard-abort-reason.test.js
 * @description Why a rebalance stopped, read from the error the bot
 *   published (src/client/web/dashboard-abort-reason.js): the kind the alert
 *   dialog words its title and advice by, and the main reason the Manage
 *   tooltip names.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let reason;

before(async () => {
  reason = await import("../src/client/web/dashboard-abort-reason.js");
});

describe("abortKind", () => {
  it("tells each kind of stop apart by the error the bot wrote", () => {
    for (const [message, kind] of [
      ["Mid-rebalance failure: coins left in the wallet", "midway"],
      ["the pool liquidity is too thin to mint", "thin"],
      ["Swap aborted: price impact 3% exceeds slippage 1%", "slip"],
      ["insufficient gas for the mint", "gas"],
      ["the price moved out of the new range", "volatile"],
      ["something else", ""],
      [undefined, ""],
    ])
      assert.equal(reason.abortKind(message), kind, String(message));
  });

  it("knows the bot's own words for a rebalance the price outran", () => {
    /*- Read from the server module, so a change to its words that the
     *  dashboard would no longer recognise fails here. */
    const { priceMovedStopMessage } = require("../src/lib/price-moved-stop");
    assert.equal(reason.abortKind(priceMovedStopMessage()), "volatile");
  });
});

describe("abortReasonSummary", () => {
  it("names a recognised kind in a few words", () => {
    assert.equal(
      reason.abortReasonSummary("Swap aborted: impact 3% exceeds slippage 1%"),
      "the swap's price impact was above your Slippage setting",
    );
  });

  it("quotes any other error to its first sentence", () => {
    assert.equal(
      reason.abortReasonSummary("Nonce 9 was taken. Second sentence."),
      "Nonce 9 was taken",
    );
  });

  it("cuts a long quote short rather than filling the tooltip", () => {
    const summary = reason.abortReasonSummary("x".repeat(300));
    assert.ok(summary.length <= 120, String(summary.length));
    assert.ok(summary.endsWith("…"));
  });

  it("says so when there is no error to quote", () => {
    for (const message of [undefined, null, "", "   "])
      assert.equal(
        reason.abortReasonSummary(message),
        "an unexpected error",
        String(message),
      );
  });
});
