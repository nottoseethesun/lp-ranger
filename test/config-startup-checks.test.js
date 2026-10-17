/**
 * @file test/config-startup-checks.test.js
 * @description `src/config.js` refuses to start on a setting it cannot
 * use, naming it, rather than supplying a value of its own. Covered here:
 * the names of the two swap routes and the aggregator url, everything a
 * chain's entry describes about the chain (its name, homepage and logo,
 * block time, native token symbol, wrapped native token, cache tag and
 * price-service ids), the
 * compounder's reposition window, and the dashboard poll interval, which
 * is read from the shipped file alone.
 *
 * Each case loads the real `src/config.js` against overrides in a
 * directory of its own. `LP_RANGER_USER_CONFIG_DIR` is read by
 * `src/load-merged-defaults.js` at module load, so it is set here BEFORE
 * anything under `src/` is required, and the modules that read the
 * shipped files are loaded afresh for each case. The `.env` keys that
 * would override these settings are pinned for the same reason: dotenv
 * leaves a key alone once it is set.
 */

"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*-
 *  The overrides live in the system's temporary directory, never the
 *  project's tmp/, where the operator's caches are.
 */
const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "startup-checks-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
process.env.CHAIN_NAME = "pulsechain";
process.env.AGGREGATOR_URL = "";
process.env.SWAP_ROUTER = "";

after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");
const UI_DEFAULTS = require("../app-config/app-defaults-for-user-configurable/ui-defaults.json");
const APP_RUNTIME = require("../app-config/app-defaults-for-user-configurable/app-runtime.json");
const PRICE_SERVICES = require("../app-config/app-defaults-for-user-configurable/price-services.json");
const _OVERRIDABLE = ["chains.json", "app-runtime.json", "ui-defaults.json"];

/**
 * Load `src/config.js` as startup would, with `overrides` as the
 * operator's files: `{ "chains.json": {...} }` and so on. A chains.json
 * override is given for PulseChain's entry alone.
 * @param {object} [overrides]
 * @returns {object} The loaded config.
 */
function loadConfigWith(overrides = {}) {
  for (const name of _OVERRIDABLE)
    fs.rmSync(path.join(_USER_DIR, name), { force: true });
  for (const [name, body] of Object.entries(overrides)) {
    const json = name === "chains.json" ? { pulsechain: body } : body;
    fs.writeFileSync(path.join(_USER_DIR, name), JSON.stringify(json));
  }
  for (const mod of [
    "load-merged-defaults",
    "runtime-flags",
    "cache-store",
    "config",
  ])
    delete require.cache[require.resolve(`../src/${mod}`)];
  return require("../src/config");
}

/** Load with one chains.json override, expecting startup to refuse it. */
function refuses(chainOverride, pattern) {
  assert.throws(
    () => loadConfigWith({ "chains.json": chainOverride }),
    pattern,
  );
}

describe("swap route names", () => {
  it("are the active chain's, from chains.json", () => {
    const config = loadConfigWith();
    const shipped = CHAINS.pulsechain;
    assert.equal(config.AGGREGATOR_NAME, shipped.aggregator.name);
    assert.equal(config.SWAP_ROUTER_NAME, shipped.contracts.swapRouter.name);
    assert.equal(config.SWAP_ROUTER, shipped.contracts.swapRouter.address);
    assert.equal(config.AGGREGATOR_URL, shipped.aggregator.url);
  });

  it("stop startup when the router has none, naming the setting", () => {
    refuses(
      { contracts: { swapRouter: { name: "" } } },
      /chains\.json → pulsechain\.contracts\.swapRouter\.name/,
    );
  });

  it("stop startup when an aggregator has none, naming the setting", () => {
    refuses(
      { aggregator: { name: "" } },
      /chains\.json → pulsechain\.aggregator\.name/,
    );
  });

  it("stop startup when .env points at an aggregator the chain does not name", () => {
    process.env.AGGREGATOR_URL = "https://aggregator.example";
    try {
      refuses(
        { aggregator: { url: "", name: "" } },
        /chains\.json → pulsechain\.aggregator\.name/,
      );
    } finally {
      process.env.AGGREGATOR_URL = "";
    }
  });

  it("may be empty for the aggregator of a chain that has none", () => {
    const config = loadConfigWith({
      "chains.json": { aggregator: { url: "", name: "" } },
    });
    assert.equal(config.AGGREGATOR_URL, "");
    assert.equal(config.AGGREGATOR_NAME, "");
  });
});

describe("aggregator url", () => {
  it("stops startup when the chain's entry gives none, naming the setting", () => {
    refuses(
      { aggregator: { url: null } },
      /chains\.json → pulsechain\.aggregator\.url/,
    );
  });

  it("stops startup when the entry's url is not a string", () => {
    refuses(
      { aggregator: { url: 369 } },
      /chains\.json → pulsechain\.aggregator\.url/,
    );
  });
});

describe("what a chain's entry describes", () => {
  for (const [setting, bad] of [
    ["displayName", ""],
    ["homepage", ""],
    ["logo", ""],
    ["blockTimeSec", 0],
    ["blockTimeSec", "10"],
    ["nativeCurrencySymbol", ""],
  ]) {
    it(`stops startup on ${setting} = ${JSON.stringify(bad)}, naming it`, () => {
      refuses(
        { [setting]: bad },
        new RegExp(`chains\\.json → pulsechain\\.${setting} must be`),
      );
    });
  }

  it("stops startup on a wrapped native token that is not a string, naming it", () => {
    /*-
     *  An absent one would reach gas pricing, fresh-deposit detection and
     *  the Moralis key check as undefined, and the key check would ask
     *  Moralis for the price of a token named "undefined".
     */
    refuses(
      { nativeWrappedToken: null },
      /chains\.json → pulsechain\.nativeWrappedToken must be/,
    );
  });

  it("stops startup on a price-service id that is not a string", () => {
    refuses(
      { priceServices: { moralisChain: null } },
      /chains\.json → pulsechain\.priceServices\.moralisChain must be/,
    );
  });

  it('accepts "" for a price service that does not cover the chain', () => {
    const config = loadConfigWith({
      "chains.json": { priceServices: { moralisChain: "" } },
    });
    assert.equal(config.CHAIN.priceServices.moralisChain, "");
  });

  it("stops startup on a cache tag that is not letters and digits", () => {
    refuses({ cacheTag: "pulse-chain" }, /pulsechain\.cacheTag must be/);
  });

  it("stops startup on a cache tag another chain has, naming that chain", () => {
    // Two chains with one tag would share their cache files.
    refuses(
      { cacheTag: CHAINS["pulsechain-testnet"].cacheTag },
      /also the tag of pulsechain-testnet/,
    );
  });
});

describe("how a chain's transactions are priced", () => {
  /*-
   *  Every send reads these, so a missing one would surface only as a
   *  NaN gas figure once a rebalance had already begun.
   */
  for (const setting of [
    "gasPriceMultiplier",
    "gasLimitMultiplier",
    "speedUpGasBump",
    "cancelGasBump",
  ]) {
    for (const bad of [null, 0, "2"]) {
      it(`stops startup on ${setting} = ${JSON.stringify(bad)}, naming it`, () => {
        refuses(
          { [setting]: bad },
          new RegExp(`chains\\.json → pulsechain\\.${setting} must be`),
        );
      });
    }
  }

  it("stops startup without a mint gas floor, naming it", () => {
    refuses(
      { contracts: { positionManager: { mintGasLimit: null } } },
      /pulsechain\.contracts\.positionManager\.mintGasLimit must be/,
    );
  });

  for (const bad of [null, 0, 1.5]) {
    it(`stops startup on gasLimitFloor = ${JSON.stringify(bad)}, naming it`, () => {
      // The floor under every send that names none of its own.
      refuses({ gasLimitFloor: bad }, /pulsechain\.gasLimitFloor must be/);
    });
  }

  it("stops startup on an envelope type it cannot send, naming it", () => {
    /*-
     *  Sending legacy transactions in its place would hide the typo
     *  behind transactions that still go out.
     */
    refuses(
      { transactionEnvelopeType: "eip-1559" },
      /pulsechain\.transactionEnvelopeType must be one of legacy, eip1559/,
    );
  });

  it("stops startup without a swap gas estimate, aggregator or not", () => {
    refuses(
      { aggregator: { url: "", name: "", estimatedSwapGasUnits: 0 } },
      /pulsechain\.aggregator\.estimatedSwapGasUnits must be/,
    );
  });
});

describe("the aggregator's own tunables", () => {
  for (const [setting, bad] of [
    ["gasPriceMultiplier", null],
    ["cancelGasMultiplier", 0],
    ["maxAttempts", 1.5],
    ["gasUnitsWhenQuoteOmitsGas", null],
  ]) {
    it(`stop startup on aggregator.${setting} = ${JSON.stringify(bad)}, naming it`, () => {
      refuses(
        { aggregator: { [setting]: bad } },
        new RegExp(`pulsechain\\.aggregator\\.${setting} must be`),
      );
    });
  }

  it("stop startup on a swap wait that cannot be a timer, naming it", () => {
    // No waitMs would cancel every swap a millisecond after it was sent.
    refuses(
      { aggregator: { waitMs: null } },
      /chains\.json → pulsechain\.aggregator\.waitMs/,
    );
  });

  it("are not required of a chain with no aggregator", () => {
    const config = loadConfigWith({
      "chains.json": {
        aggregator: { url: "", name: "", waitMs: null, maxAttempts: null },
      },
    });
    assert.equal(config.AGGREGATOR_URL, "");
  });
});

describe("the cancel phase's floor", () => {
  it("stops startup on a value that cannot be a timer, naming it", () => {
    assert.throws(
      () =>
        loadConfigWith({
          "app-runtime.json": { tx: { cancelPhaseFloorSec: 0 } },
        }),
      /app-runtime\.json → tx\.cancelPhaseFloorSec/,
    );
  });
});

describe("how a failed send is retried", () => {
  it("is the shipped app-runtime.json tx group", () => {
    const config = loadConfigWith();
    assert.equal(config.TX_SEND_RETRIES, APP_RUNTIME.tx.sendRetries);
    assert.equal(
      config.TX_SEND_RETRY_BASE_DELAY_MS,
      APP_RUNTIME.tx.sendRetryBaseDelayMs,
    );
  });

  it("allows no retries at all", () => {
    const config = loadConfigWith({
      "app-runtime.json": { tx: { sendRetries: 0 } },
    });
    assert.equal(config.TX_SEND_RETRIES, 0);
  });

  for (const bad of [-1, 1.5, 11, null]) {
    it(`stops startup on sendRetries = ${JSON.stringify(bad)}, naming it`, () => {
      assert.throws(
        () =>
          loadConfigWith({ "app-runtime.json": { tx: { sendRetries: bad } } }),
        /app-runtime\.json → tx\.sendRetries must be/,
      );
    });
  }

  it("stops startup on a base delay that cannot be a timer, naming it", () => {
    assert.throws(
      () =>
        loadConfigWith({
          "app-runtime.json": { tx: { sendRetryBaseDelayMs: null } },
        }),
      /app-runtime\.json → tx\.sendRetryBaseDelayMs/,
    );
  });
});

describe("how long the dashboard is given to see a change", () => {
  it("is the poll interval times the shipped pollsBeforeAssumedSeen", () => {
    const config = loadConfigWith();
    assert.equal(
      config.GUARANTEED_DASHBOARD_HAS_POLLED_MS,
      Math.round(
        UI_DEFAULTS.dashboardPollIntervalMs *
          APP_RUNTIME.dashboard.pollsBeforeAssumedSeen,
      ),
    );
  });

  for (const bad of [0.5, 101, "2", null]) {
    it(`stops startup on pollsBeforeAssumedSeen = ${JSON.stringify(bad)}, naming it`, () => {
      assert.throws(
        () =>
          loadConfigWith({
            "app-runtime.json": { dashboard: { pollsBeforeAssumedSeen: bad } },
          }),
        /app-runtime\.json → dashboard\.pollsBeforeAssumedSeen must be/,
      );
    });
  }
});

describe("price-service urls", () => {
  /**
   * Load src/price-service-urls.js as startup would, with `override` as
   * the operator's price-services.json, which is removed again after.
   * @param {object} [override]
   * @returns {object} The loaded module.
   */
  function loadUrlsWith(override) {
    const file = path.join(_USER_DIR, "price-services.json");
    if (override) fs.writeFileSync(file, JSON.stringify(override));
    try {
      for (const mod of ["load-merged-defaults", "price-service-urls"])
        delete require.cache[require.resolve(`../src/${mod}`)];
      return require("../src/price-service-urls");
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  it("are the shipped price-services.json values", () => {
    const urls = loadUrlsWith();
    assert.equal(urls.DEXSCREENER_API, PRICE_SERVICES.dexScreener.baseUrl);
    assert.equal(urls.GECKO_TERMINAL_API, PRICE_SERVICES.geckoTerminal.baseUrl);
    assert.equal(urls.MORALIS_API, PRICE_SERVICES.moralis.baseUrl);
  });

  for (const [bad, what] of [
    ["http://api.example", "not https"],
    ["https://api.example/", "ends in a slash"],
    [null, "absent"],
  ]) {
    it(`stop startup on a base url that is ${what}, naming it`, () => {
      assert.throws(
        () => loadUrlsWith({ moralis: { baseUrl: bad } }),
        /price-services\.json → moralis\.baseUrl must be/,
      );
    });
  }
});

describe("compound reposition window", () => {
  it("is the shipped app-runtime.json value", () => {
    const config = loadConfigWith();
    assert.ok(config.COMPOUND_REPOSITION_WINDOW_SEC > 0);
  });

  it("stops startup on a value that is not a positive number, naming it", () => {
    assert.throws(
      () =>
        loadConfigWith({
          "app-runtime.json": { compound: { repositionWindowSec: -1 } },
        }),
      /app-runtime\.json → compound\.repositionWindowSec/,
    );
  });
});

describe("dashboard poll interval", () => {
  it("is the shipped ui-defaults.json value, which the dashboard bundles", () => {
    /*-
     *  An override reaches the server but never the bundle, so the
     *  server reads the shipped file too, and the two cannot disagree.
     */
    const config = loadConfigWith({
      "ui-defaults.json": { dashboardPollIntervalMs: 999999 },
    });
    assert.equal(
      config.DASHBOARD_POLL_INTERVAL_MS,
      UI_DEFAULTS.dashboardPollIntervalMs,
    );
  });

  it("and the chain query's wait are whole, positive milliseconds", () => {
    for (const key of ["dashboardPollIntervalMs", "chainQueryTimeoutMs"]) {
      const ms = UI_DEFAULTS[key];
      assert.ok(Number.isInteger(ms) && ms > 0, `${key} = ${ms}`);
    }
  });
});

describe("the other settings the dashboard bundles", () => {
  /*-
   *  Nothing on the server reads these, so nothing at startup could
   *  refuse a broken one; the bundle would simply carry it. This is the
   *  check instead, on the shipped file the bundle is built from.
   */
  it("are whole, positive numbers", () => {
    for (const key of [
      "reloadMaxWaitMs",
      "pollFailuresBeforeHalted",
      "pollSkipLogEvery",
      "lastCheckJustNowSec",
      "autoCompoundSyncHoldMs",
      "activityLogMaxEntries",
      "copyFeedbackMs",
      "heapLogIntervalMs",
    ]) {
      const v = UI_DEFAULTS[key];
      assert.ok(Number.isInteger(v) && v > 0, `${key} = ${v}`);
    }
  });

  it("include a NEAR LIMIT threshold that is a percentage", () => {
    const pct = UI_DEFAULTS.throttleNearLimitPct;
    assert.ok(Number.isInteger(pct) && pct > 0 && pct <= 100, String(pct));
  });
});
