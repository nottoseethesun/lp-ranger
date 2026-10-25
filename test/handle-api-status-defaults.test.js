/**
 * @file test/handle-api-status-defaults.test.js
 * @description
 * Guards the shipped-default publication contract of `GET /api/status`.
 *
 * The dashboard is not allowed to hold its own copy of a shipped
 * default (feedback-one-literal-per-shipped-default). The only way it
 * can honour that is if the server actually publishes the value — so
 * the publication itself needs a test, or a client falls back to a
 * degraded path with nothing failing.
 */

"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*-
 *  An operator's logging.json of this file's own, moving the error log
 *  away from its default, so a status that named the default could not
 *  pass for one that names the configured path. Set before anything
 *  under src/lib/ loads, because the loader reads the override directory's
 *  path at load. Nothing else is overridden.
 */
const _MOVED_ERROR_LOG = "logs/elsewhere/errors.log";
const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "status-defaults-"));
fs.writeFileSync(
  path.join(_USER_DIR, "logging.json"),
  JSON.stringify({ errorLogPath: _MOVED_ERROR_LOG }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { createApiStatusHandler } = require("../src/server/handle-api-status");
const { primaryRouteLabel } = require("../src/lib/rebalancer-swap");
const { moralisEnabledIn } = require("../src/lib/server-moralis");
const config = require("../src/lib/config");
const { configuredErrorLogPath } = require("../src/lib/error-log");
const logFile = require("../src/lib/log-file");

/** Drive the real handler with the smallest viable dependency set. */
async function statusPayload(overrides = {}) {
  let captured = null;
  const handler = createApiStatusHandler({
    config,
    diskConfig: { global: {}, positions: {} },
    /*- The full contract the handler exercises — enumerated from the
     *  source, not guessed: getAll, getPoolDailyCounts, runningCount. */
    positionMgr: {
      runningCount: () => 0,
      getAll: () => [],
      getPoolDailyCounts: () => ({}),
    },
    walletManager: { getAddress: () => "0xW" },
    routeHandlers: { getPositionScanStatus: () => null },
    buildStatusPositions: () => ({}),
    buildGasStatusPayload: async () => ({}),
    actualGasCostUsd: async () => 0,
    getLpProviderDisplayName: () => "9mm v3",
    managedKeys: () => [],
    primaryRouteLabel,
    moralisEnabledIn,
    jsonResponse: (_res, _code, body) => {
      captured = body;
    },
    ...overrides,
  });
  await handler({}, {});
  return captured;
}

test("/api/status names the aggregator as the route on PulseChain", async () => {
  const body = await statusPayload();
  assert.equal(body.global.swapRouteLabel, "Watergun Aggregator");
});

test("/api/status names the V3 router on a chain with no aggregator", async () => {
  /*-
   *  A chain whose `aggregator.url` is empty — the testnet, today — swaps
   *  only through the V3 router, so the badge must not claim otherwise.
   */
  const saved = config.AGGREGATOR_URL;
  config.AGGREGATOR_URL = "";
  try {
    const body = await statusPayload();
    assert.equal(body.global.swapRouteLabel, "9mm V3 Router");
  } finally {
    config.AGGREGATOR_URL = saved;
  }
});

test("/api/status publishes the position defaults in `global`", async () => {
  /*-
   *  They reach `global` through the `...posDefaults` spread; if that
   *  spread ever moves, this catches it.
   */
  const body = await statusPayload();
  assert.ok(body, "handler must respond");
  assert.equal(body.global.maxRebalancesPerDay, config.MAX_REBALANCES_PER_DAY);
  assert.equal(
    body.global.impermanentLossGuardPct,
    config.IMPERMANENT_LOSS_GUARD_PCT,
  );
});

test("/api/status names the error log as logging.json sets it", async () => {
  /*-
   *  The Reload Current Position dialog tells the operator where a
   *  failure's details go; the user ruled it must name the configured
   *  path, as written, rather than the default.
   */
  const body = await statusPayload();
  assert.equal(configuredErrorLogPath(), _MOVED_ERROR_LOG);
  assert.equal(body.global.errorLogPath, _MOVED_ERROR_LOG);
});

test("/api/status no longer publishes the removed settings", async () => {
  /*-
   *  `SLIPPAGE_PCT` and Gas Strategy are gone, and so are the status
   *  fields they fed, which nothing on the page read.
   */
  const body = await statusPayload();
  for (const k of ["slippagePct", "defaultSlippagePct", "gasStrategy"])
    assert.equal(Object.hasOwn(body.global, k), false, k);
});

test("/api/status names the file the server logs to, or null while that is off", async () => {
  /*-
   *  A failed re-open's Manage tooltip sends the operator there for the
   *  details, and to the terminal while there is no such file.
   */
  assert.equal((await statusPayload()).global.logFilePath, null);
  const file = path.join(os.tmpdir(), `lp-ranger-status-${process.pid}.log`);
  logFile.enableLogFile(file);
  try {
    const body = await statusPayload();
    assert.equal(body.global.logFilePath, path.relative(process.cwd(), file));
  } finally {
    logFile.disableLogFile();
    fs.rmSync(file, { force: true });
  }
});
