/**
 * @file test/position-history-refresh-forwarding.test.js
 * @description The link between `getPositionHistory`'s `refreshPrices`
 *   option and the price call that has to honour it.
 *
 *   Everything either side of this link is already covered:
 *   `_needsPriceFill` and `_needsExitFromChain` are driven directly, and
 *   the reconstructor's end of the chain is pinned by
 *   `rescan-prices-refresh-reaches-sources.test.js` — which reaches the
 *   module boundary and stops, because it replaces this whole module
 *   with a stub.
 *
 *   That leaves the forwarding itself untested, and it is one `opts.`
 *   property away from being silently dropped. With it dropped the
 *   Re-scan Prices opt-in still rebuilds every epoch, still reports
 *   success, and still reads every price out of the cache the operator
 *   asked it to bypass.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const fs = require("node:fs");
const path = require("node:path");

let getPositionHistory;
let priceCalls;
let _tmpDir;
let _origLogFile;

const _origRequire = Module.prototype.require;
const config = require("../src/config");

const POSITION = Object.freeze({
  token0: "0x" + "1".repeat(40),
  token1: "0x" + "2".repeat(40),
  fee: 3000,
});

/*-
 *  A record that already carries prices at both ends, which is the case
 *  the flag exists for: nothing is missing, so the ordinary gate asks
 *  for no fetch at all.
 */
const EVENTS = [
  {
    oldTokenId: "100",
    newTokenId: "200",
    loggedAt: "2026-01-15T10:00:00Z",
    entryValueUsd: 1000,
    token0UsdPrice: 0.5,
    token1UsdPrice: 1,
  },
  {
    oldTokenId: "200",
    newTokenId: "300",
    loggedAt: "2026-02-20T14:30:00Z",
    exitValueUsd: 1100,
    token0UsdPrice: 0.55,
    token1UsdPrice: 1.1,
    feesEarnedUsd: 30,
    gasCostWei: "600000",
  },
];

before(() => {
  /*-
   *  The mint and close dates come off the rebalance log, and without
   *  them there is no moment to price, so the gate asks for nothing
   *  either way and the test could not tell the flag from its absence.
   *
   *  `_readRebalanceLog` joins the configured path onto `process.cwd()`,
   *  so the path has to be project-relative. A uniquely named file under
   *  `tmp/` keeps it clear of the operator's own log, and it is removed
   *  again in `after`.
   */
  _tmpDir = path.join("tmp", "test-history-refresh-" + process.pid);
  fs.mkdirSync(_tmpDir, { recursive: true });
  const logPath = path.join(_tmpDir, "rebalance-log.json");
  fs.writeFileSync(logPath, JSON.stringify(EVENTS), "utf8");
  _origLogFile = config.LOG_FILE;
  config.LOG_FILE = logPath;

  Module.prototype.require = function (id) {
    if (id === "./price-fetcher") {
      return {
        fetchHistoricalPriceGecko: async (_pool, _ts, _net, opts) => {
          priceCalls.push(opts);
          return { price0: 0, price1: 0 };
        },
        fetchTokenPriceUsd: async () => 0,
      };
    }
    if (id === "./send-transaction") {
      return { getManagedReadProvider: () => ({}) };
    }
    if (id === "ethers") {
      /*-
       *  The pool address is resolved through a factory `getPool` call.
       *  Only that answer matters here, so the contract is faked rather
       *  than a provider built to satisfy the real one.
       */
      return {
        Contract: class {
          async getPool() {
            return "0x" + "9".repeat(40);
          }
        },
        Interface: class {
          parseLog() {
            return null;
          }
        },
        ZeroAddress: "0x" + "0".repeat(40),
      };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/position-history")];
  ({ getPositionHistory } = require("../src/position-history"));
});

after(() => {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/position-history")];
  config.LOG_FILE = _origLogFile;
  fs.rmSync(_tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  priceCalls = [];
});

/** Run the history read for the mid-chain NFT. */
function read(opts) {
  return getPositionHistory("200", {
    rebalanceEvents: EVENTS,
    activePosition: POSITION,
    collectAndDrain: { collectEvents: [], dlEvents: [] },
    ...opts,
  });
}

describe("getPositionHistory — forwarding refreshPrices", () => {
  it("asks for no price when every end is already priced", async () => {
    /*-
     *  The baseline the flag has to overturn. Without it this record
     *  needs nothing, so no call is made and a dropped flag would look
     *  exactly like this.
     */
    await read({});
    assert.equal(priceCalls.length, 0);
  });

  it("re-reads both ends when the option is set", async () => {
    await read({ refreshPrices: true });
    assert.ok(
      priceCalls.length > 0,
      "the opt-in must reach the price source at all",
    );
    for (const opts of priceCalls)
      assert.equal(
        opts.refresh,
        true,
        "reaching the source without `refresh` reads the cache it is meant to bypass",
      );
  });

  it("does not forward a value that merely looks true", async () => {
    /*-
     *  The option crosses a JSON boundary on its way here. Only a real
     *  boolean should commit to re-fetching every price in a chain.
     */
    await read({ refreshPrices: "yes" });
    assert.equal(priceCalls.length, 0);
  });
});
