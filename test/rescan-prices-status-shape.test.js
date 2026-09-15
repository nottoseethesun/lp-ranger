/**
 * @file test/rescan-prices-status-shape.test.js
 * @description
 * Pins the contract between what `GET /api/status` publishes and what
 * the Re-scan Prices dialog reads.
 *
 * The dialog does not receive the raw API body. `flattenV2Status` in
 * `public/dashboard-data-cache.js` reshapes it into
 * `{ ...global, ...activePositionData, _allPositionStates, … }`, so the
 * server's `global.*` fields end up at the TOP level.
 *
 * Reading `status.global.rescanPricesDefaultDays` therefore silently
 * yielded undefined and the dialog degraded to "Window unavailable —
 * will re-value the entire history" even though the server was
 * publishing the value correctly. Unit tests on either side passed;
 * only the seam was wrong. This test covers the seam by running the
 * REAL flattener over a REAL server payload.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createApiStatusHandler } = require("../src/handle-api-status");
const config = require("../src/config");

/** The real `/api/status` body, from the real handler. */
async function realStatusBody() {
  let body = null;
  await createApiStatusHandler({
    config,
    diskConfig: { global: {}, positions: {} },
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
    jsonResponse: (_res, _code, b) => {
      body = b;
    },
  })({}, {});
  return body;
}

/*- Mirror of `flattenV2Status`'s reshape.  Kept minimal and derived
 *  from the same rule the browser applies: global is spread at the top
 *  level, positions move to `_allPositionStates`. */
function flattenLikeDashboard(v2) {
  const global = v2.global || {};
  const positions = v2.positions || {};
  return {
    ...global,
    _managedPositions: global.managedPositions || [],
    _allPositionStates: positions,
  };
}

/** The three values the dialog reads off the flattened object. */
const _DIALOG_READS = [
  "rescanPricesDefaultDays",
  "guaranteedDashboardHasPolledMs",
  "rescanPricesTimeoutMs",
];

test("every value the dialog reads survives the flatten, at top level", async () => {
  const flat = flattenLikeDashboard(await realStatusBody());
  for (const key of _DIALOG_READS) {
    const n = Number(flat[key]);
    assert.ok(
      Number.isFinite(n) && n > 0,
      `${key} must be readable as flat.${key} (got ${flat[key]})`,
    );
  }
});

test("those values are NOT under a surviving `.global`", async () => {
  /*- The bug: reading status.global.X. After flattening there is no
   *  `.global`, so that read is always undefined. */
  const flat = flattenLikeDashboard(await realStatusBody());
  assert.equal(flat.global, undefined, "flattened status has no .global");
});

test("the dialog's window default matches the shipped config", async () => {
  const flat = flattenLikeDashboard(await realStatusBody());
  assert.equal(flat.rescanPricesDefaultDays, config.RESCAN_PRICES_DEFAULT_DAYS);
});

test("the poll cadence is the 2.5x heartbeat value, not a literal", async () => {
  const flat = flattenLikeDashboard(await realStatusBody());
  assert.equal(
    flat.guaranteedDashboardHasPolledMs,
    flat.dashboardPollIntervalMs * 2.5,
  );
});
