"use strict";

/**
 * @file test/position-details-saved-override.test.js
 * @description An unmanaged position's figures take the price override
 *   the server keeps under the position's fully-qualified key, and never
 *   one a request carries.
 *
 *   The Price Override dialog saves to the server (`POST /api/config`,
 *   under the position's key), as it does for a managed position, so the
 *   override holds in any browser and after Clear Local Storage.
 *   `computeQuickDetails` (src/position-details-quick.js) reads it there.
 *   The pool, its prices and the token reads are stubbed; the override
 *   rule itself (`_applyPriceOverrides`) is tested in
 *   test/position-details-quick.test.js.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const config = require("../src/config");
const { compositeKey } = require("../src/bot-config-v2");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const TOKEN_ID = "777";

const _origRequire = Module.prototype.require;
let computeQuickDetails;
let key;

before(() => {
  /*-
   *  TEST-ONLY global swap: the module under test requires its chain and
   *  price reads by name and takes no stand-ins for them, so the
   *  stand-ins are served from here as it loads. Put back pristine in
   *  the `after` hook below.
   */
  Module.prototype.require = function (id) {
    if (id === "./rebalancer-pools")
      return {
        getPoolState: async () => ({
          tick: 0,
          price: 1,
          decimals0: 18,
          decimals1: 18,
        }),
      };
    if (id === "./bot-pnl-updater")
      return {
        // Token 0 has no price, so an override is what values it.
        fetchTokenPrices: async () => ({ price0: 0, price1: 2 }),
        positionValueUsd: (_pos, _ps, p0, p1) => 10 * p0 + 10 * p1,
        readUnclaimedFees: async () => ({ tokensOwed0: 0n, tokensOwed1: 0n }),
        addPoolShare: async () => {},
      };
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/position-details-quick")];
  ({ computeQuickDetails } = require("../src/position-details-quick"));
  key = compositeKey(config.CHAIN_NAME, WALLET, PM, TOKEN_ID);
});

after(() => {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/position-details-quick")];
});

/** A details request; `extra` adds what an older dashboard sent. */
const request = (extra = {}) => ({
  tokenId: TOKEN_ID,
  token0: "0x000000000000000000000000000000000000000A",
  token1: "0x000000000000000000000000000000000000000B",
  fee: 3000,
  tickLower: -600,
  tickUpper: 600,
  liquidity: "1000000000000000000",
  walletAddress: WALLET,
  contractAddress: PM,
  ...extra,
});

/** No balance in the wallet, so the residual reads come back empty. */
const ethersLib = {
  Contract: class {
    async balanceOf() {
      return 0n;
    }
  },
};

/** A saved baseline, so nothing is read from the chain for it. */
const BASELINE = {
  entryValue: 100,
  price0: 1,
  price1: 1,
  mintDate: "2026-01-01",
  hodlAmount0: 1,
  hodlAmount1: 1,
};

describe("an unmanaged position's price override", () => {
  it("is the one saved under its key", async () => {
    const diskConfig = {
      positions: { [key]: { priceOverride0: 1.5, hodlBaseline: BASELINE } },
    };
    const d = await computeQuickDetails(
      null,
      ethersLib,
      request(),
      diskConfig,
      null,
    );
    assert.equal(d.fetchedPrice0, 0);
    assert.equal(d.price0, 1.5);
  });

  it("is never one the request carries", async () => {
    const diskConfig = {
      positions: { [key]: { hodlBaseline: BASELINE } },
    };
    const d = await computeQuickDetails(
      null,
      ethersLib,
      request({ priceOverride0: 9.9, priceOverrideForce: true }),
      diskConfig,
      null,
    );
    assert.equal(d.price0, 0, "nothing saved, so token 0 stays unpriced");
    assert.equal(d.price1, 2, "and no request forces a price");
  });
});
