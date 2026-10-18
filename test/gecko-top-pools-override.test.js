"use strict";

/**
 * @file test/gecko-top-pools-override.test.js
 * @description How many of a token's pools GeckoTerminal is asked to rank
 *   comes from price-services.json, an operator's copy included, and a
 *   value outside its range in setting-bounds.json stops the app at load,
 *   naming the setting, rather than letting it run on a figure nobody
 *   chose.
 *
 *   The operator's copy is written to a temporary directory of this
 *   file's own. The loader reads `LP_RANGER_USER_CONFIG_DIR` at module
 *   load, so it is set before anything under `src/` is required, and each
 *   case loads src/gecko-pool-cache.js afresh after writing its copy.
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gecko-top-pools-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { _resetMemoForTests } = require("../src/load-merged-defaults");
const GECKO = require.resolve("../src/gecko-pool-cache");

/** Write the operator's copy of price-services.json with `topPools`. */
function override(topPools) {
  fs.writeFileSync(
    path.join(_USER_DIR, "price-services.json"),
    JSON.stringify({ geckoTerminal: { topPoolsConsidered: topPools } }),
  );
  _resetMemoForTests();
}

/** Load the module as startup does, after the operator's copy is in. */
const loadGecko = () => require(GECKO);

beforeEach(() => {
  delete require.cache[GECKO];
});

after(() => {
  delete require.cache[GECKO];
  _resetMemoForTests();
});

/** A trading pool `address` holding `liquidity` dollars. */
const pool = (address, liquidity) => ({
  address,
  name: address,
  liquidity,
  volume: 1,
  side: "base",
});

describe("geckoTerminal.topPoolsConsidered", () => {
  it("considers as many of the ranked pools as the operator's value says", () => {
    /*-
     *  The deepest pool ranks fourth. Moved off the shipped 10 to 3, the
     *  pick stops short of it.
     */
    override(3);
    const { _pickBestPool } = loadGecko();
    const ranked = [pool("0x1", 10), pool("0x2", 30), pool("0x3", 20)];
    assert.equal(_pickBestPool([...ranked, pool("0x4", 1000)]).address, "0x2");
  });

  for (const bad of [0, 2.5, "ten"]) {
    it(`stops the load on ${JSON.stringify(bad)}, naming the setting`, () => {
      override(bad);
      assert.throws(
        loadGecko,
        new RegExp(
          "price-services\\.json → geckoTerminal\\.topPoolsConsidered " +
            "must be a whole number of at least 1; it is " +
            JSON.stringify(bad).replace(/\./g, "\\."),
        ),
      );
    });
  }
});
