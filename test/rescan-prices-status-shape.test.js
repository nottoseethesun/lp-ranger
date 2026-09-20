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
 * A read of `status.global.<field>` therefore yields undefined even
 * while the server publishes the value, and unit tests on either side
 * still pass. This test covers the seam by running the REAL flattener
 * over a REAL server payload. Uses jsdom (via `global-jsdom/register`)
 * so the browser module can be imported directly.
 */

"use strict";

require("global-jsdom/register");

const { test, before } = require("node:test");
const assert = require("node:assert/strict");

const { createApiStatusHandler } = require("../src/handle-api-status");
const config = require("../src/config");

let flattenV2Status;

before(async () => {
  ({ flattenV2Status } = await import("../public/dashboard-data-cache.js"));
});

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

/** The status the dialog is given: the real body, flattened. */
async function flatStatus() {
  const body = await realStatusBody();
  return flattenV2Status(body);
}

/** The two values the dialog reads off the flattened object. */
const _DIALOG_READS = [
  "guaranteedDashboardHasPolledMs",
  "rescanPricesTimeoutMs",
];

test("every value the dialog reads survives the flatten, at top level", async () => {
  const flat = await flatStatus();
  for (const key of _DIALOG_READS) {
    const n = Number(flat[key]);
    assert.ok(
      Number.isFinite(n) && n > 0,
      `${key} must be readable as flat.${key} (got ${flat[key]})`,
    );
  }
});

test("those values are NOT under a surviving `.global`", async () => {
  // After flattening there is no `.global`, so reading through it fails.
  const flat = await flatStatus();
  assert.equal(flat.global, undefined, "flattened status has no .global");
});

test("the poll cadence is the 2.5x heartbeat value, not a literal", async () => {
  const flat = await flatStatus();
  assert.equal(
    flat.guaranteedDashboardHasPolledMs,
    flat.dashboardPollIntervalMs * 2.5,
  );
});
