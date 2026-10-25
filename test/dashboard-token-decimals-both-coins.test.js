"use strict";

/**
 * @file test/dashboard-token-decimals-both-coins.test.js
 * @description Pool Details' decimals overrides: both coins are filled
 *   in when the dialog opens, and Save sends both as shown.
 *
 *   Save sends both coins, so the form must show both as the server keeps
 *   them: a coin left blank is sent as "no override", and the server
 *   deletes its override and clears its Force box.
 *   The user, 2026-10-17: "token decimals should always be pre-populated
 *   in the dialog for both coins; the app almost surely has that
 *   information already. That solves it once and for all." So each coin
 *   opens with its override saved on the server, Force box included, or
 *   else the decimals the chain gave, and Save sends the form as it
 *   stands. The two pure decisions are driven here; the dialog's own
 *   fill and save only read and write the fields around them.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../src/client/web/dashboard-token-decimals.js");
});

/** A status for a pool of two 18-decimal coins, with coin 1 forced to 8. */
const FORCED_COIN_1 = {
  decimalsOverride1: 8,
  decimalsOverrideForce1: true,
  poolState: { decimals0: 18, decimals1: 18 },
};

describe("decimalsFormValues — what the dialog opens with", () => {
  it("fills both coins: the saved override with its Force box, else the chain's", () => {
    assert.deepEqual(mod.decimalsFormValues(FORCED_COIN_1), [
      { decimals: 18, force: false },
      { decimals: 8, force: true },
    ]);
  });

  it("leaves a coin blank only when neither source has a figure", () => {
    assert.deepEqual(mod.decimalsFormValues({ poolState: { decimals0: 6 } }), [
      { decimals: 6, force: false },
      { decimals: null, force: false },
    ]);
    assert.deepEqual(mod.decimalsFormValues(null), [
      { decimals: null, force: false },
      { decimals: null, force: false },
    ]);
  });

  it("takes an override of 0 as a figure, not as missing", () => {
    const shown = mod.decimalsFormValues({
      decimalsOverride0: 0,
      poolState: { decimals0: 18 },
    });
    assert.equal(shown[0].decimals, 0);
  });
});

describe("decimalsSaveValues — what a Save sends", () => {
  it("sends both coins as the form shows them", () => {
    assert.deepEqual(
      mod.decimalsSaveValues([
        { text: "6", force: false },
        { text: "8", force: true },
      ]),
      {
        decimalsOverride0: 6,
        decimalsOverride1: 8,
        decimalsOverrideForce0: false,
        decimalsOverrideForce1: true,
      },
    );
  });

  it("keeps the other coin's saved override when one coin is saved", () => {
    /*-
     *  The reported case: coin 1 forced to 8 on the server, the operator
     *  saves a new value for coin 0. Coin 1 must go back exactly as it
     *  was saved, Force included.
     */
    const shown = mod.decimalsFormValues(FORCED_COIN_1);
    const fields = shown.map((s) => ({
      text: s.decimals === null ? "" : String(s.decimals),
      force: s.force,
    }));
    fields[0].text = "6";
    const sent = mod.decimalsSaveValues(fields);
    assert.equal(sent.decimalsOverride0, 6);
    assert.equal(sent.decimalsOverride1, 8);
    assert.equal(sent.decimalsOverrideForce1, true);
  });
});
