"use strict";

/**
 * @file test/price-moved-stop.test.js
 * @description A rebalance the price outran (src/price-moved-stop.js):
 *   the price left the new range before the mint, with the old position
 *   already emptied. The bot holds the position for the owner at once,
 *   with the advice on the dashboard and by Telegram, the user's ruling
 *   (2026-10-23).
 *
 *   The drained-position retire is set to 45 minutes, off its shipped 30,
 *   so a typed figure in the advice cannot pass.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const SETTINGS_DIR = makeTestTempFolder("price-moved-stop-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "app-runtime.json"),
  JSON.stringify({ retire: { drainedAfterMs: 2700000 } }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  holdAfterPriceMove,
  priceMovedStopMessage,
} = require("../src/price-moved-stop");
const tg = require("../src/telegram-notifications/telegram");
const {
  EVENT_DEFAULTS,
} = require("../src/telegram-notifications/telegram-events");

describe("holdAfterPriceMove", () => {
  it("ends the rebalance and holds the position for the owner, with the advice", () => {
    /*-
     *  The user's ruling, 2026-10-23: the bot does not try again on its
     *  own; the owner weighs the impermanent loss and, if it is
     *  acceptable, clicks Rebalance Now.
     */
    const state = { rebalanceInProgress: true };
    let emitted = null;
    holdAfterPriceMove(state, (p) => (emitted = p));
    assert.strictEqual(state.rebalanceInProgress, false);
    assert.strictEqual(state.rebalancePaused, true);
    assert.strictEqual(state.rebalanceError, priceMovedStopMessage());
    assert.match(state.rebalanceError, /impermanent loss/);
    assert.match(state.rebalanceError, /click Rebalance Now/);
    assert.match(state.rebalanceError, /in 45 minutes/);
    assert.deepStrictEqual(emitted, {
      rebalancePaused: true,
      rebalanceError: state.rebalanceError,
    });
  });

  it("holds the position with no dashboard to publish to", () => {
    const state = {};
    holdAfterPriceMove(state, null);
    assert.strictEqual(state.rebalancePaused, true);
    assert.strictEqual(state.rebalanceError, priceMovedStopMessage());
  });

  describe("the Telegram alert", () => {
    const realFetch = globalThis.fetch;
    let sent;
    beforeEach(() => {
      sent = [];
      /*-
       *  TEST-ONLY global swap: the telegram module sends through the
       *  global fetch and takes none of its own. The original is put back
       *  pristine after each case.
       */
      globalThis.fetch = async (_url, opts) => {
        sent.push(JSON.parse(opts.body).text);
        return { ok: true, json: async () => ({ ok: true }) };
      };
      tg.setBotToken("tok");
      tg.setChatId("123");
      tg.setEnabledEvents(EVENT_DEFAULTS);
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      tg.setBotToken(null);
      tg.setChatId(null);
    });

    it("goes out as Rebalance Failed, on by default, with the dashboard's words", async () => {
      holdAfterPriceMove({}, null, {
        tokenId: "7",
        token0Symbol: "HEX",
        token1Symbol: "WPLS",
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(sent.length, 1);
      assert.match(sent[0], /Rebalance Failed/);
      assert.ok(
        sent[0].replace(/\\/g, "").includes("click Rebalance Now"),
        sent[0],
      );
    });
  });
});
