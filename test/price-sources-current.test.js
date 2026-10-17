/**
 * @file test/price-sources-current.test.js
 * @description Which services a current-price lookup asks, and by what
 *   name. Each is asked by its own id for the chain, from the chain's
 *   `priceServices` in chains.json, and a service whose id is "" does not
 *   cover the chain and is not asked at all — so the cascade logs no miss
 *   for a service that was never consulted.
 *
 *   No Moralis key is held in this process, so Moralis is left out on
 *   that ground whatever its id; the cases cover the two key-free
 *   services.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { currentPriceSources } = require("../src/price-sources-current");

const TOKEN = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const names = (sources) => sources.map((s) => s.name);

describe("currentPriceSources", () => {
  it("asks each service the chain has an id for, in the app's order", () => {
    const sources = currentPriceSources(TOKEN, {
      dexScreenerChain: "somechain",
      geckoTerminalNetwork: "somenetwork",
      moralisChain: "0x1",
    });
    assert.deepEqual(names(sources), ["GeckoTerminal", "DexScreener"]);
  });

  it("leaves out a service whose id for the chain is empty", () => {
    assert.deepEqual(
      names(
        currentPriceSources(TOKEN, {
          dexScreenerChain: "somechain",
          geckoTerminalNetwork: "",
          moralisChain: "0x1",
        }),
      ),
      ["DexScreener"],
    );
    assert.deepEqual(
      names(
        currentPriceSources(TOKEN, {
          dexScreenerChain: "",
          geckoTerminalNetwork: "somenetwork",
          moralisChain: "",
        }),
      ),
      ["GeckoTerminal"],
    );
  });

  it("asks nothing on a chain no service covers", () => {
    assert.deepEqual(
      currentPriceSources(TOKEN, {
        dexScreenerChain: "",
        geckoTerminalNetwork: "",
        moralisChain: "",
      }),
      [],
    );
  });
});
