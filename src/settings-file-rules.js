"use strict";

/**
 * @file src/settings-file-rules.js
 * @module settings-file-rules
 * @description
 * What every value in the JSON settings files may be, as one JSON Schema
 * for each file, and the values that must agree with each other.
 *
 * Each file's schema (draft 2020-12) is built here, as the module loads,
 * from the pieces in src/settings-schema-parts.js, and checked by Ajv,
 * the JSON Schema validator (`AJV`, src/value-kinds.js). A group's
 * schema names every key it takes and
 * refuses any other, so a setting misspelled, or put in a file that does
 * not read it, is reported rather than ignored, and a value of the wrong
 * type, such as a list where one number belongs, is refused by its
 * schema's `type`. A value's schema is one of three:
 *
 *   - its range in setting-bounds.json, found by its path in its own
 *     file (`ranged`);
 *   - the timer rule of src/timer-bounds.js, for a value that becomes a
 *     timer delay, its ceiling set by the value as shipped (`timer`);
 *   - a kind of value from src/value-kinds.js.
 *
 * Each schema carries, as its `description`, the words a refusal uses:
 * "app-runtime.json → tx.deadlineSec must be a whole number from 300 to
 * 3600; it is 50". What a schema cannot say, code says after it: values
 * that must agree with each other, within a file or across files
 * (`agreementProblems`).
 *
 * The test suite holds the files that ship to these schemas
 * (test/shipped-config-values.test.js). The settings check holds an
 * install's own values to them, its copies over the shipped files
 * included (src/settings-check.js), for the
 * `validate-config-values-with-any-user-overrides` diagnostic and for the
 * server's and the bot's startup. So a value is judged one way, wherever
 * it comes from.
 */

const { loadShippedDefaults } = require("./load-merged-defaults");
const { boundAt } = require("./setting-bounds");
const { assertTimerSec } = require("./timer-bounds");
const { cacheTagProblem } = require("./cache-store");
const { AJV, isText } = require("./value-kinds");
const { GLOBAL_KEYS, SETTING_POSITION_KEYS } = require("./bot-config-keys");
const {
  K,
  group,
  named,
  ranged,
  rangedEach,
  timer,
  listOf,
  problemsFromErrors,
} = require("./settings-schema-parts");

// ── Each file's schema ─────────────────────────────────────────────────

function _botConfigDefaults(shipped) {
  const t = (key) => timer(key, shipped[key]);
  return group({
    ...rangedEach([
      "approvalMultiple",
      "gasFeePct",
      "rebalanceGasDeferPct",
      "getLogsChunkSize",
      "rpcFailoverRatePercentage",
      "rpcFailoverRateDurationMinutes",
      "rpcMax429PenaltyMs",
      "rpcFailoverStickyMs",
      "boundedReadAttemptsPerEndpoint",
      "feeDataLogIntervalMs",
      "historyLookbackYears",
      "eventCacheTtlMs",
      "poolScanReuseMs",
      "rebalancePairingWindowSec",
      "priceCacheTtlMs",
      "dustUnitPriceCacheMultiplier",
      "moveCacheTtlMs",
      "pricePauseExceptionPollWindowMultiple",
      "positionBalancedBandPct",
      "positionBalancedCooldownMs",
      "rescanPricesRecentWindowDays",
      "impermanentLossGuardPct",
      "rebalanceOutOfRangeThresholdPercent",
      "rebalanceTimeoutMin",
      "slippagePct",
      "swapChunkCount",
      "minSwapAmountRaw",
      "slippageSuggestionMarginPct",
      "correctiveSwapMaxRounds",
      "minRebalanceIntervalMin",
      "maxRebalancesPerDay",
      "offsetToken0Pct",
      "rebalanceRangeWidthPct",
    ]),
    // Each delay in the list is held to the range alone.
    rpcRetryOn429DelaysMs: {
      type: "array",
      items: ranged("rpcRetryOn429DelaysMs"),
      description: "a list of delays in milliseconds",
    },
    gasDeferRetrySec: t("gasDeferRetrySec"),
    globalRPCRequestRateIntervalMS: t("globalRPCRequestRateIntervalMS"),
    rpcAllEndpointsDownPauseMS: t("rpcAllEndpointsDownPauseMS"),
    boundedReadRetryDelayMs: t("boundedReadRetryDelayMs"),
    checkIntervalSec: t("checkIntervalSec"),
    moralisEnabled: K.bool,
    fullRangeRebalanceEnabled: K.bool,
    rangeOverrideEnabled: K.bool,
    throttleDoubling: group(
      rangedEach(
        ["triggerCount", "triggerWindowMultiple", "quietWindowMultiple"],
        "throttleDoubling.",
      ),
    ),
    lowGasThresholds: group(
      rangedEach(
        ["worstCaseGasFactor", "safetyMultiplier", "standardSendGas"],
        "lowGasThresholds.",
      ),
    ),
    ilGuardRetry: group(rangedEach(["baseMs", "maxMs"], "ilGuardRetry.")),
    residualCleanup: group(
      rangedEach(["delayMs", "thresholdPct"], "residualCleanup."),
    ),
  });
}

/*-
 *  The auto-compound threshold a position starts with: dollars, inside
 *  the range a threshold saved from the dashboard is held to.
 */
function _defaultThreshold() {
  const bound = boundAt("autoCompoundThresholdUsd");
  const min = Math.max(K.usd.minimum, bound.min ?? -Infinity);
  return {
    type: "number",
    minimum: min,
    maximum: bound.max,
    description: `a number of dollars from ${min} to ${bound.max}`,
  };
}

function _appRuntime(shipped) {
  const { shutdown, tx, poll } = shipped;
  return group({
    server: group({ port: K.port, host: K.text }),
    shutdown: group({
      exitTimeoutMs: timer("exitTimeoutMs", shutdown.exitTimeoutMs),
      stopKillMarginMs: timer("stopKillMarginMs", shutdown.stopKillMarginMs),
      stopCheckIntervalMs: timer(
        "stopCheckIntervalMs",
        shutdown.stopCheckIntervalMs,
      ),
      gentleStopPollMs: timer("gentleStopPollMs", shutdown.gentleStopPollMs),
    }),
    // Which chain it names is checked against chains.json, below.
    defaults: group({ chain: K.text }),
    tx: group({
      ...rangedEach(
        [
          "deadlineSec",
          "swapBackoffBaseMs",
          "swapBackoffMaxMs",
          "midwayRetryLimit",
          "sendRetries",
        ],
        "tx.",
      ),
      speedupSec: timer("txSpeedupSec", tx.speedupSec),
      cancelPhaseFloorSec: timer("cancelPhaseFloorSec", tx.cancelPhaseFloorSec),
      sendRetryBaseDelayMs: timer(
        "sendRetryBaseDelayMs",
        tx.sendRetryBaseDelayMs,
      ),
      cancelToDeadlineMultiple: K.positive,
      retrySwapLimit: K.count,
    }),
    dashboard: group(rangedEach(["pollsBeforeAssumedSeen"], "dashboard.")),
    poll: group({
      afterActionMs: timer("afterActionMs", poll.afterActionMs),
      lifetimeRescanCheckMs: timer(
        "lifetimeRescanCheckMs",
        poll.lifetimeRescanCheckMs,
      ),
    }),
    retire: group(rangedEach(["drainedAfterMs"], "retire.")),
    rescanPrices: group({ timeoutMs: K.ms }),
    compound: group({
      ...rangedEach(["autoSpacingPolls", "autoSpacingFloorSec"], "compound."),
      minFeeUsd: K.usd,
      defaultThresholdUsd: _defaultThreshold(),
      repositionWindowSec: K.seconds,
    }),
    log: group({ file: K.text }),
  });
}

/** The endpoints a chain fails over between, as many as allowed. */
function _rpcUrls() {
  const count = boundAt("rpcUrlCount");
  return {
    type: "array",
    minItems: count.min,
    maxItems: count.max,
    items: K.url,
    description: `a list of ${count.min} to ${count.max} http or https addresses`,
  };
}

/** One chain's settings; `shipped` is the chain as shipped, if it is. */
function _chain(shipped) {
  const aggregator = shipped?.aggregator;
  return group({
    chainId: K.count,
    displayName: K.text,
    homepage: K.url,
    logo: K.image,
    tokenList: group({ url: K.urlOrNone }),
    blockTimeSec: K.positive,
    nativeCurrencySymbol: K.text,
    cacheTag: K.text,
    priceServices: group({
      dexScreenerChain: K.textOrNone,
      geckoTerminalNetwork: K.textOrNone,
      moralisChain: K.textOrNone,
    }),
    nativeWrappedToken: K.addressOrNone,
    transactionEnvelopeType: {
      enum: ["legacy", "eip1559"],
      description:
        "legacy or eip1559, the envelopes src/runtime-flags.js knows",
    },
    gasPriceMultiplier: K.scalesUp,
    gasLimitMultiplier: K.scalesUp,
    speedUpGasBump: K.outbids,
    cancelGasBump: K.outbids,
    gasLimitFloor: K.gasUnits,
    estimatedRebalanceGasUnits: K.gasUnits,
    rpc: group({ urls: _rpcUrls() }),
    blockExplorer: K.url,
    contracts: group({
      positionManager: group({
        address: K.addressOrNone,
        mintGasLimit: K.gasUnits,
      }),
      factory: K.addressOrNone,
      swapRouter: group({ address: K.addressOrNone, name: K.textOrNone }),
    }),
    aggregator: group({
      url: K.urlOrNone,
      name: K.textOrNone,
      gasPriceMultiplier: K.scalesUp,
      // The swap's own price times speedUpGasBump is the cancel's floor.
      cancelGasMultiplier: K.positive,
      waitMs: timer("aggregatorWaitMs", aggregator?.waitMs),
      quoteTimeoutMs: timer(
        "aggregatorQuoteTimeoutMs",
        aggregator?.quoteTimeoutMs,
      ),
      maxAttempts: K.count,
      estimatedSwapGasUnits: K.gasUnits,
      gasUnitsWhenQuoteOmitsGas: K.gasUnits,
    }),
    dexPairDetailPageUrl: group({ blockchain: K.textOrNone }),
    chartProviders: named(
      group({
        name: K.text,
        scheme: K.scheme,
        domain: K.host,
        blockchain: K.text,
        pathSegments: K.textList,
      }),
    ),
  });
}

/*-
 *  Each chain as shipped, whose timers' ceilings its own values set, and
 *  any chain an operator adds.
 */
function _chains(shipped) {
  return {
    ...named(_chain(undefined)),
    properties: Object.fromEntries(
      Object.entries(shipped).map(([name, c]) => [name, _chain(c)]),
    ),
  };
}

function _rpcResponseCodes() {
  const withCodes = group({
    description: K.text,
    ethersCodes: K.textList,
    messageSubstrings: K.lowerTextList,
  });
  // Buckets the classifier matches by message alone.
  const byMessage = group({
    description: K.text,
    messageSubstrings: K.lowerTextList,
  });
  return group({
    blockRangeCap: byMessage,
    transient: withCodes,
    terminalNonceUnused: withCodes,
    terminalNonceConsumed: withCodes,
    alreadyKnown: byMessage,
  });
}

function _lpProviders() {
  return named(
    group({
      displayName: K.text,
      // Which chains each names is checked against chains.json, below.
      supportedBlockchainsByLpRangerAndLpProvider: listOf(
        K.text,
        "a list of chains named in chains.json",
      ),
      swapProtocolVersion: K.text,
      dexDetailPage: group({
        name: K.text,
        scheme: K.scheme,
        domain: K.host,
        pathSegments: K.textList,
      }),
    }),
    {
      type: "string",
      format: "lp-provider-key",
      description:
        "a pool factory's and a position manager's EIP-55 addresses, " +
        "joined by _",
    },
  );
}

/** Every file's schema, built from the files as shipped. */
function _schemas() {
  const s = (file) => loadShippedDefaults(file);
  const serverDown = s("ui-defaults_non-layout_for-server-down-scenario.json");
  const serverUp = s("ui-defaults_non-layout_for-server-up-scenario.json");
  return {
    "bot-config-defaults.json": _botConfigDefaults(
      s("bot-config-defaults.json"),
    ),
    "app-runtime.json": _appRuntime(s("app-runtime.json")),
    "chains.json": _chains(s("chains.json")),
    "csrf.json": group({ tokenTtlMs: K.ms, refreshIntervalMs: K.ms }),
    "dust-threshold.json": group({
      thresholdUnits: K.positive,
      fallbackThresholdUsd: K.positive,
      priceSourceTokens: listOf(
        group({
          symbol: K.text,
          name: K.text,
          moralisChain: K.text,
          dexScreenerChain: K.text,
          address: K.address,
        }),
        "a list of tokens, not empty",
      ),
    }),
    "evm-rpc-response-codes.json": _rpcResponseCodes(),
    "logging.json": group({
      enabled: K.bool,
      path: K.text,
      errorLogPath: K.text,
    }),
    "lp-providers.json": _lpProviders(),
    "price-services.json": group({
      dexScreener: group({ baseUrl: K.baseUrl }),
      geckoTerminal: group({
        baseUrl: K.baseUrl,
        ...rangedEach(["topPoolsConsidered"], "geckoTerminal."),
      }),
      moralis: group({ baseUrl: K.baseUrl }),
    }),
    "setting-labels.json": named(group({ label: K.text, unit: K.textOrNone }), {
      enum: [...GLOBAL_KEYS, ...SETTING_POSITION_KEYS],
      description: "the name of a setting the dashboard saves",
    }),
    "ui-defaults_layout.json": group({ dialogMaxHeightPx: K.count }),
    "ui-defaults_non-layout_for-server-down-scenario.json": group({
      chainQueryTimeoutMs: timer(
        "chainQueryTimeoutMs",
        serverDown.chainQueryTimeoutMs,
      ),
      pollFailuresBeforeHalted: K.count,
    }),
    "ui-defaults_non-layout_for-server-up-scenario.json": group({
      ...rangedEach([
        "reloadMaxWaitMs",
        "pollSkipLogEvery",
        "lastCheckJustNowSec",
        "autoCompoundSyncHoldMs",
        "slippageConfirmAbovePct",
        "slippageTypedConfirmFromPct",
        "throttleNearLimitPct",
        "activityLogMaxEntries",
        "privacyUsdAmountThreshold",
      ]),
      ...Object.fromEntries(
        [
          "copyFeedbackMs",
          "heapLogIntervalMs",
          "dashboardPollIntervalMs",
          "staleDataCheckIntervalMs",
        ].map((key) => [key, timer(key, serverUp[key])]),
      ),
      soundsEnabled: K.bool,
      privacyModeEnabled: K.bool,
      privacyBlurWalletAddresses: K.bool,
      privacyBlurUsdAmounts: K.bool,
    }),
  };
}

/** Each settings file's schema, by the file's name. */
const SETTINGS_FILE_SCHEMAS = Object.freeze(_schemas());

// Each schema compiled once, as the module loads.
const _VALIDATE = Object.fromEntries(
  Object.entries(SETTINGS_FILE_SCHEMAS).map(([f, s]) => [f, AJV.compile(s)]),
);

/*-
 *  The JSON files in the shipped directory that hold no settings, and so
 *  have no schema here.
 */
const NOT_SETTINGS_FILES = Object.freeze({
  // The ranges themselves; test/setting-bounds.test.js checks their shape.
  "setting-bounds.json": true,
  // A format template for the encrypted api-keys.json; nothing reads it.
  "api-keys.example.json": true,
});

/*-
 *  The settings file the app never reads an operator's copy of: built
 *  into the page as shipped, for the minutes the server is unreachable.
 */
const NEVER_OVERRIDDEN = Object.freeze({
  "ui-defaults_non-layout_for-server-down-scenario.json": true,
});

// ── Each file checked ──────────────────────────────────────────────────

/**
 * Every problem with the values of one settings file: a value of the
 * wrong type or outside its range, a key its schema does not name, which
 * is not a setting LP Ranger reads, and a setting missing.
 *
 * @param {string} file    The file's name, a key of `SETTINGS_FILE_SCHEMAS`.
 * @param {object} values  Its values: as shipped, or as an install
 *   resolves them, its own copy over the shipped file; doc keys, those
 *   starting `_`, removed.
 * @returns {string[]}
 */
function settingsFileProblems(file, values) {
  const validate = _VALIDATE[file];
  return validate(values) ? [] : problemsFromErrors(file, validate.errors);
}

// ── Values that must agree ─────────────────────────────────────────────

/**
 * A group of settings, or an empty one in place of anything else, which
 * its file's schema has already reported.
 */
const _group = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};

/** Every problem with a chain's name the settings give, against chains.json. */
function _chainNameProblems(read, chains) {
  const problems = [];
  const chain = _group(_group(read("app-runtime.json")).defaults).chain;
  if (isText(chain) && !Object.hasOwn(chains, chain))
    problems.push(
      "app-runtime.json → defaults.chain must be the name of a chain in " +
        `chains.json; it is ${JSON.stringify(chain)}`,
    );
  for (const [key, p] of Object.entries(_group(read("lp-providers.json")))) {
    const list = _group(p).supportedBlockchainsByLpRangerAndLpProvider;
    for (const c of Array.isArray(list) ? list : [])
      if (isText(c) && !Object.hasOwn(chains, c))
        problems.push(
          `lp-providers.json → ${key}.supportedBlockchainsByLpRangerAndLpProvider ` +
            `names ${JSON.stringify(c)}, which is not a chain in chains.json`,
        );
  }
  return problems;
}

/**
 * Every problem with values that must agree with each other, across the
 * files `read` answers for.
 *
 * @param {(file: string) => object} read  A settings file's values.
 * @returns {string[]}
 */
function agreementProblems(read) {
  const problems = [];
  /*-
   *  TX_CANCEL_SEC defaults to the deadline times its multiple, and the
   *  app checks the product as a timer at startup.
   */
  const tx = _group(_group(read("app-runtime.json")).tx);
  const cancel = tx.deadlineSec * tx.cancelToDeadlineMultiple;
  // A deadline or multiple that is no number, its schema has reported.
  if (Number.isFinite(cancel))
    try {
      assertTimerSec({
        sec: cancel,
        key: "txCancelSec",
        defaultSec: cancel,
        label:
          "app-runtime.json → tx.deadlineSec × tx.cancelToDeadlineMultiple",
      });
    } catch (err) {
      problems.push(err.message);
    }
  const csrf = _group(read("csrf.json"));
  if (!(csrf.refreshIntervalMs < csrf.tokenTtlMs))
    problems.push(
      `csrf.json → refreshIntervalMs (${csrf.refreshIntervalMs}) must be ` +
        `below tokenTtlMs (${csrf.tokenTtlMs}), so the token is refreshed ` +
        "before it expires",
    );
  const chains = _group(read("chains.json"));
  for (const [name, c] of Object.entries(chains)) {
    // A cache tag missing, or not text, its schema has reported.
    const tag = isText(c?.cacheTag) ? cacheTagProblem(chains, name) : null;
    if (tag !== null) problems.push(tag);
    if (isText(c?.aggregator?.name) !== isText(c?.aggregator?.url))
      problems.push(
        `chains.json → ${name}.aggregator must name an aggregator exactly ` +
          "when it gives one's url",
      );
  }
  problems.push(..._chainNameProblems(read, chains));
  return problems;
}

module.exports = {
  SETTINGS_FILE_SCHEMAS,
  NOT_SETTINGS_FILES,
  NEVER_OVERRIDDEN,
  settingsFileProblems,
  agreementProblems,
};
