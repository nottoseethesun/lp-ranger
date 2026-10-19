"use strict";

/**
 * @file src/settings-file-rules.js
 * @module settings-file-rules
 * @description
 * What every value in the JSON settings files may be, and the values that
 * must agree with each other.
 *
 * Every value in a file is checked by exactly one of three rules. A value
 * with a range in `setting-bounds.json`, at its own path, is held to that
 * range. A value that becomes a timer delay is held to the timer rule in
 * `src/timer-bounds.js`, under the name the app checks it by, its ceiling
 * set by the shipped value. Every other value is named in
 * `SETTINGS_FILE_RULES` with the kind of value it must be
 * (src/value-kinds.js). A value no rule covers is not a setting LP Ranger
 * reads.
 *
 * The test suite holds the files that ship to these rules
 * (test/shipped-config-values.test.js). The settings check holds an
 * install's own values to them, its copies over the shipped files
 * included (src/settings-check.js), for the
 * `validate-config-values-with-any-user-overrides` diagnostic and for the
 * server's and the bot's startup. So a value is judged one way, wherever
 * it comes from.
 *
 * A rule answers the problem with a value, in words that name where the
 * value is and what it must be, or null when there is none.
 */

const fs = require("fs");
const path = require("path");
const { SETTING_BOUNDS } = require("./setting-bounds");
const { withinBound, boundText } = require("./range-check");
const { assertTimerSec } = require("./timer-bounds");
const { cacheTagProblem } = require("./cache-store");
const { KINDS, isText, isUrl, isAddress } = require("./value-kinds");

const _PUBLIC = path.join(__dirname, "..", "public");

// ── What a value may be ────────────────────────────────────────────────

/** Words for a value that fails: where it is, what it must be, what it is. */
function _problem(where, v, what) {
  return `${where} must be ${what}; it is ${JSON.stringify(v)}`;
}

/** A rule from a test of the value and a description of what passes. */
const rule = (what, ok) => (v, where) =>
  ok(v) ? null : _problem(where, v, what);

/**
 * A rule from a kind of value the app holds its own inputs to as well,
 * so a file's value is judged as a request's is.
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

/** A chain named in the chains.json the values are judged against. */
const chain = (v, where, ctx) =>
  typeof v === "string" && Object.hasOwn(ctx.chains, v)
    ? null
    : _problem(where, v, "the name of a chain in chains.json");

/** A list of chains named in that chains.json. */
const chainList = (v, where, ctx) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((c) => typeof c === "string" && Object.hasOwn(ctx.chains, c))
    ? null
    : _problem(where, v, "a list of chains named in chains.json");

// The dashboard loads a chain's logo from public/ by this name.
const logoFile = rule("the name of an image in public/", (v) =>
  isText(v) ? fs.existsSync(path.join(_PUBLIC, v)) : false,
);

/** Both rules must pass. */
const both = (a, b) => (v, where, ctx) => a(v, where, ctx) ?? b(v, where, ctx);

/** Held to another setting's range: the one this value is a default of. */
const rangeOf = (key) => (v, where) => {
  const bound = SETTING_BOUNDS[key];
  return withinBound(v, bound)
    ? null
    : _problem(where, v, `${boundText(bound)}, the range of ${key}`);
};

/**
 * Held to the timer rule under the name the app checks it by. The
 * shipped value at the same place (`ctx.shipped`) is the default whose
 * multiple bounds it, as it is when the app reads the setting; without
 * one, the value bounds itself.
 */
const timer = (key) => (v, where, ctx) => {
  const shipped = ctx?.shipped;
  try {
    assertTimerSec({
      sec: v,
      key,
      defaultSec: typeof shipped === "number" ? shipped : v,
      label: where,
    });
    return null;
  } catch (err) {
    return err.message;
  }
};

/** A list of tokens the dust threshold is priced from. */
function tokenList(v, where) {
  if (!Array.isArray(v) || v.length === 0) return `${where} must list tokens`;
  for (const [i, t] of v.entries()) {
    const at = `${where}[${i}]`;
    for (const k of ["symbol", "name", "moralisChain", "dexScreenerChain"]) {
      const problem = text(t?.[k], `${at}.${k}`);
      if (problem !== null) return problem;
    }
    const problem = kindRule(KINDS.address)(t?.address, `${at}.address`);
    if (problem !== null) return problem;
  }
  return null;
}

/** The rpc endpoints a chain fails over between, as many as allowed. */
function rpcUrls(v, where) {
  const problem = rule("a list of http or https addresses", (u) =>
    Array.isArray(u) ? u.every(isUrl) : false,
  )(v, where);
  return problem ?? rangeOf("rpcUrlCount")(v.length, `${where} (how many)`);
}

// ── Each file, and what its values must be ─────────────────────────────

/*-
 *  Keyed by each value's path in its file; `*` stands for any one key, a
 *  chain or an LP provider. A value with a range in setting-bounds.json
 *  has no entry here, because that range is its rule.
 */
const SETTINGS_FILE_RULES = Object.freeze({
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
   *  their rule.
   */
  "ui-defaults_non-layout_for-server-up-scenario.json": {
    copyFeedbackMs: timer("copyFeedbackMs"),
    heapLogIntervalMs: timer("heapLogIntervalMs"),
    dashboardPollIntervalMs: timer("dashboardPollIntervalMs"),
    staleDataCheckIntervalMs: timer("staleDataCheckIntervalMs"),
    soundsEnabled: bool,
    privacyModeEnabled: bool,
    privacyBlurWalletAddresses: bool,
    privacyBlurUsdAmounts: bool,
  },
});

/*-
 *  The JSON files in the shipped directory that hold no settings, and so
 *  are not checked here.
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
function _isRange(v) {
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
  return _isRange(found) ? found : null;
}

/** Whether a rule's path, with its `*`s, names the value at `at`. */
function matches(pattern, at) {
  const parts = pattern.split(".");
  return (
    parts.length === at.length &&
    parts.every((p, i) => p === "*" || p === at[i])
  );
}

/** Whether `at` is a group some rule's path runs through. */
function _isGroup(rules, at) {
  return Object.keys(rules).some((pattern) => {
    const parts = pattern.split(".");
    return (
      parts.length > at.length &&
      at.every((k, i) => parts[i] === "*" || parts[i] === k)
    );
  });
}

/** The value at path `at` in `node`, or undefined. */
const _valueAt = (node, at) => at.reduce((n, k) => n?.[k], node);

/**
 * Every problem with the values of one settings file: a value of the
 * wrong kind, outside its range, or that no rule names, which is not a
 * setting LP Ranger reads.
 *
 * @param {string} file    The file's name, a key of `SETTINGS_FILE_RULES`.
 * @param {object} values  Its values: as shipped, or as an install
 *   resolves them, its own copy over the shipped file.
 * @param {object} ctx
 * @param {object} ctx.chains   The chains.json the values are judged
 *   against, an install's copy included.
 * @param {object} ctx.shipped  The file as shipped, whose timers set each
 *   timer's ceiling.
 * @returns {string[]}
 */
function settingsFileProblems(file, values, ctx) {
  const rules = SETTINGS_FILE_RULES[file];
  const problems = [];
  for (const [at, v] of leaves(values)) {
    const where = `${file} → ${at.join(".")}`;
    const range = rangeAt(at);
    if (range !== null) {
      for (const each of Array.isArray(v) ? v : [v])
        if (!withinBound(each, range))
          problems.push(_problem(where, each, boundText(range)));
      continue;
    }
    const named = Object.keys(rules).find((p) => matches(p, at));
    if (named === undefined) {
      problems.push(
        _isGroup(rules, at)
          ? `${where} must be a group of settings, as shipped`
          : `${where} is not a setting LP Ranger reads`,
      );
      continue;
    }
    const problem = rules[named](v, where, {
      chains: ctx.chains,
      shipped: _valueAt(ctx.shipped, at),
    });
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

// ── Values that must agree ─────────────────────────────────────────────

/**
 * A group of settings, or an empty one in place of anything else, which
 * the walk over its file has already reported.
 */
const _group = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};

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
  const cancel = timer("txCancelSec")(
    tx.deadlineSec * tx.cancelToDeadlineMultiple,
    "app-runtime.json → tx.deadlineSec × tx.cancelToDeadlineMultiple",
  );
  if (cancel !== null) problems.push(cancel);
  const csrf = _group(read("csrf.json"));
  if (!(csrf.refreshIntervalMs < csrf.tokenTtlMs))
    problems.push(
      `csrf.json → refreshIntervalMs (${csrf.refreshIntervalMs}) must be ` +
        `below tokenTtlMs (${csrf.tokenTtlMs}), so the token is refreshed ` +
        "before it expires",
    );
  const chains = _group(read("chains.json"));
  for (const [name, c] of Object.entries(chains)) {
    const tag = cacheTagProblem(chains, name);
    if (tag !== null) problems.push(tag);
    if (isText(c?.aggregator?.name) !== isText(c?.aggregator?.url))
      problems.push(
        `chains.json → ${name}.aggregator must name an aggregator exactly ` +
          "when it gives one's url",
      );
  }
  for (const key of Object.keys(_group(read("lp-providers.json")))) {
    const parts = key.split("_");
    if (parts.length !== 2 || !parts.every(isAddress))
      problems.push(
        `lp-providers.json → ${key} must be a pool factory's and a ` +
          "position manager's EIP-55 addresses, joined by _",
      );
  }
  return problems;
}

module.exports = {
  SETTINGS_FILE_RULES,
  NOT_SETTINGS_FILES,
  NEVER_OVERRIDDEN,
  settingsFileProblems,
  agreementProblems,
  leaves,
  rangeAt,
  matches,
};
