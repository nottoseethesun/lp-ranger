"use strict";

/**
 * @file test/shipped-config-values.test.js
 * @description Every value the app ships as a default is of the right
 *   type and inside its range.
 *
 *   The files under `app-config/app-defaults-for-user-configurable/` hold
 *   the app's own answers, used wherever an operator has not given one.
 *   A wrong one is wrong on every install at once, and some would not
 *   show until the code that reads them ran: a gas-limit multiplier below
 *   one sends transactions that run out of gas, and a Bot Settings
 *   default outside its range now stops startup.
 *
 *   So every value in every file is checked here, by exactly one of three
 *   rules. A value with a range in `setting-bounds.json`, at its own path,
 *   is held to that range, read from the same file the app reads. A value
 *   that becomes a timer delay is held to the timer rule in
 *   `src/timer-bounds.js`, under the name the app checks it by. Every
 *   other value is named in `RULES` below with the kind of value it must
 *   be: true or false, a whole number, an http address, an EIP-55 address,
 *   and so on. A few values must also agree with each other, and the last
 *   cases check those.
 *
 *   Nothing is left out by accident. A value no rule covers fails, naming
 *   its path, and so does a rule that names no value, so a value added or
 *   renamed has to be given its check here. So does a file added to the
 *   directory: it is either listed in `RULES` or named among the files
 *   that hold no defaults.
 *
 *   Only what ships is read. The override directory is pointed at an
 *   empty one of this file's own before anything under `src/` loads,
 *   because the loader reads it at load, and a developer's own overrides
 *   are not what an install receives.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-values-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { loadShippedDefaults } = require("../src/load-merged-defaults");
const { SETTING_BOUNDS } = require("../src/setting-bounds");
const { withinBound, boundText } = require("../src/range-check");
const { assertTimerSec } = require("../src/timer-bounds");
const { chainCacheTag } = require("../src/cache-store");
const { KINDS, isText, isUrl, isAddress } = require("../src/value-kinds");

const DIR = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
);
const PUBLIC = path.join(__dirname, "..", "public");
const CHAINS = loadShippedDefaults("chains.json");

// ── What a value may be ────────────────────────────────────────────────

/** Fail naming the value's place, what it must be, and what it is. */
function fail(where, v, what) {
  assert.fail(`${where} must be ${what}; it is ${JSON.stringify(v)}`);
}

/** A rule from a test of the value and a description of what passes. */
const rule = (what, ok) => (v, where) => {
  if (!ok(v)) fail(where, v, what);
};

/*-
 *  The kinds of value the app holds its own inputs to as well
 *  (src/value-kinds.js), so a shipped value is judged as an operator's
 *  or a request's is.
 */
const kindRule = (k) => rule(k.what, k.ok);
const bool = kindRule(KINDS.bool);
const text = kindRule(KINDS.text);
const textOrNone = kindRule(KINDS.textOrNone);
const count = kindRule(KINDS.count);
const ms = kindRule(KINDS.ms);
const seconds = kindRule(KINDS.seconds);
const positive = kindRule(KINDS.positive);
const usd = kindRule(KINDS.usd);
const scalesUp = kindRule(KINDS.scalesUp);
const outbids = kindRule(KINDS.outbids);
const port = kindRule(KINDS.port);
const gasUnits = kindRule(KINDS.gasUnits);
const url = kindRule(KINDS.url);
const urlOrNone = kindRule(KINDS.urlOrNone);
const addressOrNone = kindRule(KINDS.addressOrNone);
const scheme = kindRule(KINDS.scheme);
const host = kindRule(KINDS.host);
const textList = kindRule(KINDS.textList);
const lowerTextList = kindRule(KINDS.lowerTextList);
const chain = rule("the name of a chain in chains.json", (v) =>
  Object.hasOwn(CHAINS, v),
);
const chainList = rule(
  "a list of chains named in chains.json",
  (v) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((c) => Object.hasOwn(CHAINS, c)),
);
// The dashboard loads a chain's logo from public/ by this name.
const logoFile = rule("the name of an image in public/", (v) =>
  isText(v) ? fs.existsSync(path.join(PUBLIC, v)) : false,
);

/** Both rules must pass. */
const both = (a, b) => (v, where) => {
  a(v, where);
  b(v, where);
};

/** Held to another setting's range: the one this value is a default of. */
const rangeOf = (key) => (v, where) => {
  const bound = SETTING_BOUNDS[key];
  if (!withinBound(v, bound))
    fail(where, v, `${boundText(bound)}, the range of ${key}`);
};

/** Held to the timer rule under the name the app checks it by. */
const timer = (key) => (v, where) => {
  try {
    assertTimerSec({ sec: v, key, defaultSec: v, label: where });
  } catch (err) {
    assert.fail(err.message);
  }
};

/** A list of tokens the dust threshold is priced from. */
function tokenList(v, where) {
  assert.ok(Array.isArray(v) && v.length > 0, `${where} must list tokens`);
  v.forEach((t, i) => {
    const at = `${where}[${i}]`;
    for (const k of ["symbol", "name", "moralisChain", "dexScreenerChain"])
      text(t?.[k], `${at}.${k}`);
    kindRule(KINDS.address)(t?.address, `${at}.address`);
  });
}

/** The rpc endpoints a chain fails over between, as many as allowed. */
function rpcUrls(v, where) {
  rule("a list of http or https addresses", (u) =>
    Array.isArray(u) ? u.every(isUrl) : false,
  )(v, where);
  rangeOf("rpcUrlCount")(v.length, `${where} (how many)`);
}

// ── Each file, and what its values must be ─────────────────────────────

/*-
 *  Keyed by each value's path in its file; `*` stands for any one key, a
 *  chain or an LP provider. A value with a range in setting-bounds.json
 *  has no entry here, because that range is its rule.
 */
const RULES = {
  "bot-config-defaults.json": {
    checkIntervalSec: timer("checkIntervalSec"),
    gasDeferRetrySec: timer("gasDeferRetrySec"),
    globalRPCRequestRateIntervalMS: timer("globalRPCRequestRateIntervalMS"),
    rpcAllEndpointsDownPauseMS: timer("rpcAllEndpointsDownPauseMS"),
    boundedReadRetryDelayMs: timer("boundedReadRetryDelayMs"),
    moralisEnabled: bool,
    fullRangeRebalanceEnabled: bool,
    rangeOverrideEnabled: bool,
  },
  "app-runtime.json": {
    "server.port": port,
    "server.host": text,
    "shutdown.exitTimeoutMs": ms,
    "shutdown.stopKillMarginMs": ms,
    "shutdown.stopCheckIntervalMs": ms,
    "shutdown.gentleStopPollMs": ms,
    "defaults.chain": chain,
    "tx.speedupSec": timer("txSpeedupSec"),
    "tx.deadlineSec": seconds,
    "tx.cancelToDeadlineMultiple": positive,
    "tx.retrySwapLimit": count,
    "tx.cancelPhaseFloorSec": timer("cancelPhaseFloorSec"),
    "tx.sendRetryBaseDelayMs": timer("sendRetryBaseDelayMs"),
    "poll.afterActionMs": timer("afterActionMs"),
    "poll.lifetimeRescanCheckMs": timer("lifetimeRescanCheckMs"),
    "rescanPrices.timeoutMs": ms,
    "compound.minFeeUsd": usd,
    "compound.defaultThresholdUsd": both(
      usd,
      rangeOf("autoCompoundThresholdUsd"),
    ),
    "compound.repositionWindowSec": seconds,
    "log.file": text,
  },
  "chains.json": {
    "*.chainId": count,
    "*.displayName": text,
    "*.homepage": url,
    "*.logo": logoFile,
    "*.blockTimeSec": positive,
    "*.nativeCurrencySymbol": text,
    "*.cacheTag": text,
    "*.priceServices.dexScreenerChain": textOrNone,
    "*.priceServices.geckoTerminalNetwork": textOrNone,
    "*.priceServices.moralisChain": textOrNone,
    "*.nativeWrappedToken": addressOrNone,
    "*.transactionEnvelopeType": rule(
      "legacy or eip1559, the envelopes src/runtime-flags.js knows",
      (v) => v === "legacy" || v === "eip1559",
    ),
    "*.gasPriceMultiplier": scalesUp,
    "*.gasLimitMultiplier": scalesUp,
    "*.speedUpGasBump": outbids,
    "*.cancelGasBump": outbids,
    "*.gasLimitFloor": gasUnits,
    "*.estimatedRebalanceGasUnits": gasUnits,
    "*.rpc.urls": rpcUrls,
    "*.blockExplorer": url,
    "*.contracts.positionManager.address": addressOrNone,
    "*.contracts.positionManager.mintGasLimit": gasUnits,
    "*.contracts.factory": addressOrNone,
    "*.contracts.swapRouter.address": addressOrNone,
    "*.contracts.swapRouter.name": textOrNone,
    "*.aggregator.url": urlOrNone,
    "*.aggregator.name": textOrNone,
    "*.aggregator.gasPriceMultiplier": scalesUp,
    // The swap's own price times speedUpGasBump is the cancel's floor.
    "*.aggregator.cancelGasMultiplier": positive,
    "*.aggregator.waitMs": timer("aggregatorWaitMs"),
    "*.aggregator.quoteTimeoutMs": timer("aggregatorQuoteTimeoutMs"),
    "*.aggregator.maxAttempts": count,
    "*.aggregator.estimatedSwapGasUnits": gasUnits,
    "*.aggregator.gasUnitsWhenQuoteOmitsGas": gasUnits,
    "*.dexPairDetailPageUrl.blockchain": textOrNone,
    "*.chartProviders.*.name": text,
    "*.chartProviders.*.scheme": scheme,
    "*.chartProviders.*.domain": host,
    "*.chartProviders.*.blockchain": text,
    "*.chartProviders.*.pathSegments": textList,
  },
  "csrf.json": {
    tokenTtlMs: ms,
    refreshIntervalMs: ms,
  },
  "dust-threshold.json": {
    thresholdUnits: positive,
    fallbackThresholdUsd: positive,
    priceSourceTokens: tokenList,
  },
  "evm-rpc-response-codes.json": {
    "*.description": text,
    "*.ethersCodes": textList,
    "*.messageSubstrings": lowerTextList,
  },
  "logging.json": {
    enabled: bool,
    path: text,
    errorLogPath: text,
  },
  "lp-providers.json": {
    "*.displayName": text,
    "*.supportedBlockchainsByLpRangerAndLpProvider": chainList,
    "*.swapProtocolVersion": text,
    "*.dexDetailPage.name": text,
    "*.dexDetailPage.scheme": scheme,
    "*.dexDetailPage.domain": host,
    "*.dexDetailPage.pathSegments": textList,
  },
  "price-services.json": {
    "*.baseUrl": url,
  },
  "setting-labels.json": {
    "*.label": text,
    "*.unit": textOrNone,
  },
  "ui-defaults_layout.json": {
    dialogMaxHeightPx: count,
  },
  "ui-defaults_non-layout_for-server-down-scenario.json": {
    chainQueryTimeoutMs: timer("chainQueryTimeoutMs"),
    pollFailuresBeforeHalted: count,
  },
  /*-
   *  Its other settings have ranges in setting-bounds.json, which are
   *  their rule; the server holds an operator's values to the same.
   */
  "ui-defaults_non-layout_for-server-up-scenario.json": {
    copyFeedbackMs: timer("copyFeedbackMs"),
    heapLogIntervalMs: timer("heapLogIntervalMs"),
    dashboardPollIntervalMs: timer("dashboardPollIntervalMs"),
    soundsEnabled: bool,
    privacyModeEnabled: bool,
    privacyBlurWalletAddresses: bool,
    privacyBlurUsdAmounts: bool,
  },
};

/*-
 *  The JSON files in the directory that hold no default values, and so
 *  are not checked here.
 */
const NOT_DEFAULTS = {
  // The ranges themselves; test/setting-bounds.test.js checks their shape.
  "setting-bounds.json": true,
  // A format template for the encrypted api-keys.json; nothing reads it.
  "api-keys.example.json": true,
};

// ── Walking a file ─────────────────────────────────────────────────────

/** Every value in `node`, with its path; `_`-keys are notes, not values. */
function leaves(node, at = []) {
  if (node === null || typeof node !== "object" || Array.isArray(node))
    return [[at, node]];
  return Object.entries(node)
    .filter(([k]) => !k.startsWith("_"))
    .flatMap(([k, v]) => leaves(v, [...at, k]));
}

/** A range: an object whose only keys are min, max and integer. */
function isRange(v) {
  return (
    v !== null &&
    typeof v === "object" &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => ["min", "max", "integer"].includes(k))
  );
}

/** The range setting-bounds.json gives the value at `at`, if any. */
function rangeAt(at) {
  const found = at.reduce((node, k) => node?.[k], SETTING_BOUNDS);
  return isRange(found) ? found : null;
}

/** Whether a rule's path, with its `*`s, names the value at `at`. */
function matches(pattern, at) {
  const parts = pattern.split(".");
  return (
    parts.length === at.length &&
    parts.every((p, i) => p === "*" || p === at[i])
  );
}

describe("every value the app ships as a default", () => {
  it("is in a file this test checks, or one named as holding none", () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
    for (const f of files)
      assert.ok(
        Object.hasOwn(RULES, f) || Object.hasOwn(NOT_DEFAULTS, f),
        `${f} is new: give its values rules here, or name it in NOT_DEFAULTS`,
      );
    for (const f of [...Object.keys(RULES), ...Object.keys(NOT_DEFAULTS)])
      assert.ok(files.includes(f), `${f} is not in the directory any more`);
  });

  for (const [file, rules] of Object.entries(RULES)) {
    it(`${file}: each is the right type and inside its range`, () => {
      const used = new Set();
      let checked = 0;
      for (const [at, v] of leaves(loadShippedDefaults(file))) {
        const where = `${file} → ${at.join(".")}`;
        const named = Object.keys(rules).filter((p) => matches(p, at));
        const range = rangeAt(at);
        if (range) {
          assert.equal(
            named.length,
            0,
            `${where} has a range in setting-bounds.json; give it no rule here`,
          );
          for (const each of Array.isArray(v) ? v : [v])
            if (!withinBound(each, range)) fail(where, each, boundText(range));
        } else {
          assert.equal(
            named.length,
            1,
            `${where} needs exactly one rule here, or a range in ` +
              `setting-bounds.json; it has ${named.length}`,
          );
          rules[named[0]](v, where);
          used.add(named[0]);
        }
        checked++;
      }
      assert.ok(checked > 0, `${file} holds no values`);
      for (const p of Object.keys(rules))
        assert.ok(used.has(p), `${file} → ${p} names no value; remove it`);
    });
  }
});

describe("shipped values that must agree with each other", () => {
  it("cancels a stuck transaction within the timer rule", () => {
    /*-
     *  TX_CANCEL_SEC defaults to the deadline times its multiple, and the
     *  app checks the product as a timer at startup.
     */
    const { tx } = loadShippedDefaults("app-runtime.json");
    timer("txCancelSec")(
      tx.deadlineSec * tx.cancelToDeadlineMultiple,
      "app-runtime.json → tx.deadlineSec × tx.cancelToDeadlineMultiple",
    );
  });

  it("refreshes the csrf token before it expires", () => {
    const csrf = loadShippedDefaults("csrf.json");
    assert.ok(
      csrf.refreshIntervalMs < csrf.tokenTtlMs,
      `refreshIntervalMs ${csrf.refreshIntervalMs} must be below ` +
        `tokenTtlMs ${csrf.tokenTtlMs}`,
    );
  });

  it("gives every chain a cache tag of its own", () => {
    for (const name of Object.keys(CHAINS))
      if (!name.startsWith("_")) chainCacheTag(name);
  });

  it("names a chain's aggregator exactly when the chain has one", () => {
    for (const [name, c] of Object.entries(CHAINS)) {
      if (name.startsWith("_")) continue;
      assert.equal(
        isText(c.aggregator.name),
        isText(c.aggregator.url),
        `chains.json → ${name}.aggregator`,
      );
    }
  });

  it("keys each LP provider by its factory and position manager", () => {
    for (const key of Object.keys(loadShippedDefaults("lp-providers.json"))) {
      if (key.startsWith("_")) continue;
      const parts = key.split("_");
      assert.equal(parts.length, 2, key);
      for (const a of parts) assert.ok(isAddress(a), `${key}: ${a}`);
    }
  });
});
