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

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createApiStatusHandler } = require("../src/handle-api-status");
const { primaryRouteLabel } = require("../src/rebalancer-swap");
const config = require("../src/config");

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
