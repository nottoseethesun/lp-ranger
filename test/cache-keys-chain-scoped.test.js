"use strict";

/**
 * @file test/cache-keys-chain-scoped.test.js
 * @description Every cache of chain data leads its keys with the chain.
 *
 *   A token or a pool can sit at the same address on two chains, and
 *   PulseChain's copy of Ethereum's state means many do. A cache keyed by
 *   address alone would hand one chain's answer to the other the first
 *   time the server ran on a different `CHAIN_NAME`. The canonical key is
 *   `cacheKey(chain, ...parts)` in `src/cache-store.js`: the chain's key
 *   in chains.json, then what identifies the entry, dash-joined and
 *   lower-cased.
 *
 *   Each case switches the active chain and asks again: the other chain
 *   must not get the first chain's answer, and the first chain must find
 *   its own answer kept. Nothing here writes a cache file.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const { cacheKey } = require("../src/cache-store");
const {
  getTokenSymbol,
  setTokenSymbol,
  _resetSymbolCache,
} = require("../src/token-symbol-cache");

const TOKEN = "0x00000000000000000000000000000000000AbCdE";

/** Run `fn` with another chain active, then put the first one back. */
function onOtherChain(fn) {
  const chain = config.CHAIN_NAME;
  config.CHAIN_NAME = "pulsechain-testnet";
  try {
    return fn();
  } finally {
    config.CHAIN_NAME = chain;
  }
}

describe("cacheKey", () => {
  it("leads with the chain and lower-cases every part", () => {
    assert.equal(
      cacheKey("pulsechain", "0xAbC", "0xDeF", 3000),
      "pulsechain-0xabc-0xdef-3000",
    );
  });

  it("gives the same key for an address in either letter case", () => {
    assert.equal(
      cacheKey("pulsechain", TOKEN),
      cacheKey("pulsechain", TOKEN.toLowerCase()),
    );
  });
});

describe("token symbols", () => {
  beforeEach(() => _resetSymbolCache());

  it("are found in either letter case on the chain that saw them", () => {
    setTokenSymbol(TOKEN, "ABC");
    assert.equal(getTokenSymbol(TOKEN.toLowerCase()), "ABC");
    assert.equal(
      getTokenSymbol(TOKEN.toUpperCase().replace("0X", "0x")),
      "ABC",
    );
  });

  it("are not lent to another chain, which may hold another token there", () => {
    setTokenSymbol(TOKEN, "ABC");
    onOtherChain(() => assert.equal(getTokenSymbol(TOKEN), null));
    assert.equal(getTokenSymbol(TOKEN), "ABC", "the first chain's is kept");
  });

  it("answer null for no address at all", () => {
    assert.equal(getTokenSymbol(null), null);
    assert.equal(getTokenSymbol(""), null);
  });
});
