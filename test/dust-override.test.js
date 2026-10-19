"use strict";

/**
 * @file test/dust-override.test.js
 * @description An operator's copy of dust-threshold.json sets the dust
 *   threshold, as the file's own notes and the docs say it does.
 *
 *   The threshold decides which amounts are too small to act on: a
 *   fraction of one unit of a reference asset, priced live, with a dollar
 *   floor for when no price arrives. src/dust.js read both figures from
 *   the shipped file alone, so an operator's copy changed nothing. It now
 *   reads the shipped file with the operator's copy on top, and holds
 *   each figure to the kind the tests hold the shipped file to, a number
 *   above 0, stopping the app at load over anything else.
 *
 *   The override directory is set before anything under src/ loads,
 *   because the loader reads its path at load. Each case writes the
 *   operator's copy, clears what the loader has kept, and loads the dust
 *   module afresh. The price lookup is stubbed, so no case touches the
 *   network.
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dust-override-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;

const SHIPPED = require("../app-config/app-defaults-for-user-configurable/dust-threshold.json");
const mergedLoader = require("../src/load-merged-defaults");

let unitPriceUsd;
const _priceFetcherPath = require.resolve("../src/price-fetcher");

beforeEach(() => {
  require.cache[_priceFetcherPath] = {
    id: _priceFetcherPath,
    filename: _priceFetcherPath,
    loaded: true,
    exports: { fetchDustUnitPriceUsd: async () => unitPriceUsd },
  };
});

after(() => {
  delete require.cache[_priceFetcherPath];
  fs.rmSync(_USER_DIR, { recursive: true, force: true });
});

/** Load the dust module with `override` as the operator's copy. */
function dustWith(override) {
  fs.writeFileSync(
    path.join(_USER_DIR, "dust-threshold.json"),
    JSON.stringify(override),
  );
  mergedLoader._resetMemoForTests();
  delete require.cache[require.resolve("../src/dust")];
  return require("../src/dust");
}

describe("an operator's dust threshold", () => {
  it("replaces the shipped one", async () => {
    assert.notEqual(SHIPPED.thresholdUnits, 0.0005);
    const dust = dustWith({ thresholdUnits: 0.0005 });
    assert.equal(dust.DUST_THRESHOLD_UNITS, 0.0005);
    unitPriceUsd = 4800;
    const { thresholdUsd } = await dust.getDustThresholdUsd();
    assert.ok(Math.abs(thresholdUsd - 2.4) < 1e-9, String(thresholdUsd));
  });

  it("sets the dollar floor used when no price arrives", async () => {
    assert.notEqual(SHIPPED.fallbackThresholdUsd, 2.5);
    unitPriceUsd = 0;
    const res = await dustWith({
      fallbackThresholdUsd: 2.5,
    }).getDustThresholdUsd();
    assert.equal(res.usedFallback, true);
    assert.equal(res.thresholdUsd, 2.5);
  });

  it("stops the app when a figure is not a number above 0, naming it", () => {
    for (const bad of ["0.0002", 0, -1, null, "abc"])
      assert.throws(
        () => dustWith({ thresholdUnits: bad }),
        /thresholdUnits must be a number above 0/,
        JSON.stringify(bad),
      );
    assert.throws(
      () => dustWith({ fallbackThresholdUsd: "1" }),
      /fallbackThresholdUsd must be a number above 0/,
    );
  });
});
