"use strict";

/**
 * @file test/gecko-best-pool-chain-key.test.js
 * @description A token's best GeckoTerminal pool is kept under a key that
 *   leads with the chain, so one chain's pool is never lent to another.
 *
 *   A token can sit at the same address on two chains, and PulseChain's
 *   copy of Ethereum's state means many do. The best-pool cache
 *   (`getBestPoolForToken`, src/lib/gecko-pool-cache.js) feeds the historical
 *   prices a closed period is valued at, and historical entries never
 *   expire, so a pool lent across chains would price that chain's history
 *   from the wrong token for good. The key is `cacheKey(chain, "token",
 *   address)`, the form every chain-data cache uses (see
 *   test/cache-keys-chain-scoped.test.js).
 *
 *   The cache file is the test's own, in a temporary directory, set before
 *   anything under `src/lib/` loads, and holds one entry for the active
 *   chain.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-best-pool-key-"));
process.env.GECKO_POOL_CACHE_PATH = path.join(DIR, "gecko-pool-cache.json");

const config = require("../src/lib/config");
const { cacheKey } = require("../src/lib/cache-store");
const {
  getBestPoolForToken,
  _resetForTest,
} = require("../src/lib/gecko-pool-cache");

const TOKEN = "0x00000000000000000000000000000000000AbCdE";
const POOL = {
  pool: "0x00000000000000000000000000000000000F00d1",
  side: "base",
};

let realFetch;
const asked = [];

before(() => {
  fs.writeFileSync(
    process.env.GECKO_POOL_CACHE_PATH,
    JSON.stringify({ [cacheKey(config.CHAIN_NAME, "token", TOKEN)]: POOL }),
  );
  /*-
   *  TEST-ONLY global swap: a lookup the cache cannot answer goes to
   *  GeckoTerminal through the global `fetch`, which has no seam. This
   *  one records the question and answers "not found", so no request
   *  leaves the machine.
   */
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: false, status: 404, json: async () => ({}) };
  };
});

after(() => {
  globalThis.fetch = realFetch;
  _resetForTest();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("a token's best pool", () => {
  it("is found under the chain's own key, in either letter case", async () => {
    _resetForTest();
    assert.deepEqual(await getBestPoolForToken("pulsechain", TOKEN), POOL);
    assert.deepEqual(
      await getBestPoolForToken("pulsechain", TOKEN.toLowerCase()),
      POOL,
    );
    assert.equal(asked.length, 0, "answered from the cache");
  });

  it("is not lent to another chain, which may hold another token there", async () => {
    _resetForTest();
    const chain = config.CHAIN_NAME;
    config.CHAIN_NAME = "pulsechain-testnet";
    try {
      assert.equal(await getBestPoolForToken("pulsechain", TOKEN), null);
    } finally {
      config.CHAIN_NAME = chain;
    }
    assert.equal(asked.length, 1, "asked GeckoTerminal instead");
  });
});
