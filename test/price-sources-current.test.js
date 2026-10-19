/**
 * @file test/price-sources-current.test.js
 * @description Which services a current-price lookup asks, and by what
 *   name. Each is asked by its own id for the chain, from the chain's
 *   `priceServices` in chains.json, and a service whose id is "" does not
 *   cover the chain and is not asked at all — so the cascade logs no miss
 *   for a service that was never consulted.
 *
 *   Moralis is asked only while a key is held and turned on. The first
 *   cases hold none, so they cover the two key-free services; the last
 *   group stores a key and answers Moralis's requests itself.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  currentPriceSources,
  _fetchMoralisCurrent,
} = require("../src/price-sources-current");
const { setApiKey, setServiceEnabled } = require("../src/api-key-holder");

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

describe("currentPriceSources — Moralis, with a key held", () => {
  let savedFetch;
  // No shipped chain's Moralis id, so a request naming one outright fails.
  const SERVICES = {
    dexScreenerChain: "somechain",
    geckoTerminalNetwork: "somenetwork",
    moralisChain: "0x9a",
  };
  const moralisOf = (sources) => sources.find((s) => s.name === "Moralis");

  beforeEach(() => {
    /*-
     *  TEST-ONLY global swap: each case below replaces `fetch`, because
     *  the Moralis source asks through the global one and offers no seam
     *  for another. The original is captured here and put back pristine
     *  after every case.
     */
    savedFetch = globalThis.fetch;
    setApiKey("moralis", "a-stored-key");
    setServiceEnabled("moralis", true);
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    setApiKey("moralis", null);
  });

  it("asks Moralis first, by the chain's own id and with the key", async () => {
    const asked = [];
    globalThis.fetch = async (url, opts) => {
      asked.push({ url, key: opts.headers["X-API-Key"] });
      return { ok: true, json: async () => ({ usdPrice: 1.25 }) };
    };
    const sources = currentPriceSources(TOKEN, SERVICES);
    assert.deepEqual(names(sources), [
      "Moralis",
      "GeckoTerminal",
      "DexScreener",
    ]);
    assert.equal(await moralisOf(sources).fn(), 1.25);
    assert.equal(asked.length, 1);
    assert.match(asked[0].url, /\/erc20\/0xAbCdEf.*\/price\?chain=0x9a&/);
    assert.equal(asked[0].key, "a-stored-key");
  });

  it("answers zero for a refusal, a price that is no price, and an error", async () => {
    const answers = [
      async () => ({ ok: false, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => ({ usdPrice: "n/a" }) }),
      async () => {
        throw new Error("socket hang up");
      },
    ];
    for (const answer of answers) {
      globalThis.fetch = answer;
      assert.equal(
        await moralisOf(currentPriceSources(TOKEN, SERVICES)).fn(),
        0,
      );
    }
  });

  it("answers zero without asking for a chain Moralis does not cover", async () => {
    /*-
     *  The cascades never ask for such a chain, but the verify-compound-usd
     *  diagnostic asks every source it holds a key for, testnet included.
     */
    let asked = 0;
    globalThis.fetch = async () => {
      asked++;
      return { ok: true, json: async () => ({ usdPrice: 1.25 }) };
    };
    assert.equal(await _fetchMoralisCurrent(TOKEN, ""), 0);
    assert.equal(asked, 0);
  });

  it("leaves Moralis out once it is turned off, though the key is kept", () => {
    setServiceEnabled("moralis", false);
    assert.deepEqual(names(currentPriceSources(TOKEN, SERVICES)), [
      "GeckoTerminal",
      "DexScreener",
    ]);
    setServiceEnabled("moralis", true);
  });
});
