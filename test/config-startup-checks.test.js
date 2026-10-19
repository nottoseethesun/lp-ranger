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
const SERVER_DOWN = require("../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-down-scenario.json");
const APP_RUNTIME = require("../app-config/app-defaults-for-user-configurable/app-runtime.json");
const SETTING_BOUNDS = require("../app-config/app-defaults-for-user-configurable/setting-bounds.json");
const _UI_SERVER_UP = "ui-defaults_non-layout_for-server-up-scenario.json";
const _OVERRIDABLE = [
  "chains.json",
  "app-runtime.json",
  _UI_SERVER_UP,
  "bot-config-defaults.json",
];

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
    "bot-config-defaults",
    "ui-defaults",
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
    // Each moved off what ships, so one written into the code fails.
    const router = "0x" + "44".repeat(20);
    const config = loadConfigWith({
      "chains.json": {
        aggregator: {
          url: "https://aggregator.example/api/369",
          name: "An Aggregator of the Test's Own",
        },
        contracts: {
          swapRouter: { address: router, name: "A Router of the Test's Own" },
        },
      },
    });
    assert.equal(config.AGGREGATOR_NAME, "An Aggregator of the Test's Own");
    assert.equal(config.SWAP_ROUTER_NAME, "A Router of the Test's Own");
    assert.equal(config.SWAP_ROUTER, router);
    assert.equal(config.AGGREGATOR_URL, "https://aggregator.example/api/369");
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

  for (const bad of [null, 0, 1.5]) {
    it(`stops startup on estimatedRebalanceGasUnits = ${JSON.stringify(bad)}, naming it`, () => {
      // The gas a whole rebalance is priced at before it starts.
      refuses(
        { estimatedRebalanceGasUnits: bad },
        /pulsechain\.estimatedRebalanceGasUnits must be/,
      );
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

describe("how far apart automatic compounds are", () => {
  it("is the shipped app-runtime.json compound group", () => {
    const config = loadConfigWith();
    assert.equal(
      config.COMPOUND_AUTO_SPACING_POLLS,
      APP_RUNTIME.compound.autoSpacingPolls,
    );
    assert.equal(
      config.COMPOUND_AUTO_SPACING_FLOOR_SEC,
      APP_RUNTIME.compound.autoSpacingFloorSec,
    );
  });

  for (const [key, bad] of [
    ["autoSpacingPolls", 0],
    ["autoSpacingPolls", 2.5],
    ["autoSpacingFloorSec", 86401],
    ["autoSpacingFloorSec", null],
  ])
    it(`stops startup on ${key} = ${JSON.stringify(bad)}, naming it`, () => {
      assert.throws(
        () =>
          loadConfigWith({ "app-runtime.json": { compound: { [key]: bad } } }),
        new RegExp(`app-runtime\\.json → compound\\.${key} must be`),
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

describe("the bot's retry, follow-up and retire timings", () => {
  it("are app-runtime.json's, an override included", () => {
    const config = loadConfigWith({
      "app-runtime.json": {
        tx: {
          swapBackoffBaseMs: 7000,
          swapBackoffMaxMs: 90000,
          midwayRetryLimit: 6,
        },
        poll: { afterActionMs: 3000, lifetimeRescanCheckMs: 900000 },
        retire: { drainedAfterMs: 3600000 },
      },
    });
    assert.equal(config.SWAP_BACKOFF_BASE_MS, 7000);
    assert.equal(config.SWAP_BACKOFF_MAX_MS, 90000);
    assert.equal(config.MIDWAY_RETRY_LIMIT, 6);
    assert.equal(config.POLL_AFTER_ACTION_MS, 3000);
    assert.equal(config.LIFETIME_RESCAN_CHECK_MS, 900000);
    assert.equal(config.DRAINED_RETIRE_MS, 3600000);
  });

  for (const [group, key, bad] of [
    ["tx", "swapBackoffBaseMs", 999],
    ["tx", "swapBackoffMaxMs", 86400001],
    ["tx", "midwayRetryLimit", 0],
    ["tx", "midwayRetryLimit", 1.5],
    ["retire", "drainedAfterMs", 59999],
    ["retire", "drainedAfterMs", null],
  ])
    it(`stops startup on ${group}.${key} = ${JSON.stringify(bad)}, naming it`, () => {
      assert.throws(
        () =>
          loadConfigWith({ "app-runtime.json": { [group]: { [key]: bad } } }),
        new RegExp(`app-runtime\\.json → ${group}\\.${key} must be`),
      );
    });

  for (const key of ["afterActionMs", "lifetimeRescanCheckMs"])
    it(`stops startup on a poll.${key} that cannot be a timer, naming it`, () => {
      assert.throws(
        () => loadConfigWith({ "app-runtime.json": { poll: { [key]: 0 } } }),
        new RegExp(`app-runtime\\.json → poll\\.${key}`),
      );
    });
});

describe("how long the dashboard is given to see a change", () => {
  it("is the poll interval in force times pollsBeforeAssumedSeen, each an override", () => {
    const config = loadConfigWith({
      [_UI_SERVER_UP]: { dashboardPollIntervalMs: 4000 },
      "app-runtime.json": { dashboard: { pollsBeforeAssumedSeen: 3.5 } },
    });
    assert.equal(config.GUARANTEED_DASHBOARD_HAS_POLLED_MS, 14000);
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

  it("are price-services.json's, an override included", () => {
    const urls = loadUrlsWith({
      dexScreener: { baseUrl: "https://dex.example.org" },
      geckoTerminal: { baseUrl: "https://gecko.example.org/api/v9" },
      moralis: { baseUrl: "https://moralis.example.org/api/v9" },
    });
    assert.equal(urls.DEXSCREENER_API, "https://dex.example.org");
    assert.equal(urls.GECKO_TERMINAL_API, "https://gecko.example.org/api/v9");
    assert.equal(urls.MORALIS_API, "https://moralis.example.org/api/v9");
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
  it("is app-runtime.json's, an override included", () => {
    const config = loadConfigWith({
      "app-runtime.json": { compound: { repositionWindowSec: 777 } },
    });
    assert.equal(config.COMPOUND_REPOSITION_WINDOW_SEC, 777);
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

describe("the dashboard settings the server sends", () => {
  it("give the server the poll interval the page is sent, override applied", () => {
    /*-
     *  The page is sent the operator's value, so the server's own copy,
     *  which times "the dashboard has had a chance to poll", must be the
     *  same one.
     */
    const config = loadConfigWith({
      [_UI_SERVER_UP]: { dashboardPollIntervalMs: 5000 },
    });
    assert.equal(config.DASHBOARD_POLL_INTERVAL_MS, 5000);
  });

  it("stop startup when an override breaks its rule, naming each one", () => {
    assert.throws(
      () =>
        loadConfigWith({
          [_UI_SERVER_UP]: {
            dashboardPollIntervalMs: 100,
            throttleNearLimitPct: 150,
            soundsEnabled: "yes",
          },
        }),
      (err) => {
        assert.match(err.message, new RegExp(_UI_SERVER_UP));
        assert.match(err.message, /dashboardPollIntervalMs/);
        assert.match(err.message, /throttleNearLimitPct must be .*150/);
        assert.match(err.message, /soundsEnabled must be true or false/);
        return true;
      },
    );
  });
});

describe("the settings built into the page for when the server is down", () => {
  /*-
   *  Nothing on the server reads these, so nothing at startup could
   *  refuse a broken one; the bundle would simply carry it. This is the
   *  check instead, on the shipped file the bundle is built from.
   */
  it("are whole, positive numbers", () => {
    for (const key of ["chainQueryTimeoutMs", "pollFailuresBeforeHalted"]) {
      const v = SERVER_DOWN[key];
      assert.ok(Number.isInteger(v) && v > 0, `${key} = ${v}`);
    }
  });
});

describe("Bot Settings defaults the operator overrides", () => {
  /*-
   *  A value outside its range in setting-bounds.json stops startup,
   *  naming the setting, rather than leaving the shipped default in its
   *  place unannounced.
   */
  it("stop startup when out of range, naming each one", () => {
    const cap = SETTING_BOUNDS.maxRebalancesPerDay.max;
    assert.throws(
      () =>
        loadConfigWith({
          "bot-config-defaults.json": {
            maxRebalancesPerDay: cap + 1,
            residualCleanup: { delayMs: 0 },
          },
        }),
      (err) => {
        assert.match(
          err.message,
          new RegExp(`maxRebalancesPerDay must be .*; it is ${cap + 1}\\.`),
        );
        assert.match(
          err.message,
          /residualCleanup\.delayMs must be .*; it is 0\./,
        );
        return true;
      },
    );
  });

  it("start normally inside their ranges", () => {
    // Pinned empty, so a developer's .env cannot stand in for the file.
    const saved = process.env.MAX_REBALANCES_PER_DAY;
    process.env.MAX_REBALANCES_PER_DAY = "";
    try {
      const cap = SETTING_BOUNDS.maxRebalancesPerDay.max;
      const config = loadConfigWith({
        "bot-config-defaults.json": { maxRebalancesPerDay: cap },
      });
      assert.equal(config.MAX_REBALANCES_PER_DAY, cap);
    } finally {
      if (saved === undefined) delete process.env.MAX_REBALANCES_PER_DAY;
      else process.env.MAX_REBALANCES_PER_DAY = saved;
    }
  });
});
