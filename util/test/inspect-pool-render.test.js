/**
 * @file util/test/inspect-pool-render.test.js
 * @description
 * Tests for `inspect-pool.js`'s two renderers, which together are the
 * tool's entire output.  `inspect-pool.test.js` covers the pure
 * formatters and filters; this suite covers what an operator actually
 * reads.
 *
 * The renderers take a plain object and print — no I/O to stub — so
 * every assertion here is on captured console output.  The cases that
 * matter are the absent-field ones: this tool exists to show what IS
 * and IS NOT on disk, so a missing field must render as an explicit
 * placeholder rather than `undefined`.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  printPosition,
  printEpochEntry,
} = require("../diagnostic/inspect-pool");
const { captureConsole } = require("./_capture");

const KEY = "pulsechain-0xW-0xPM-162980";

test("printPosition — renders every documented field", async () => {
  const pos = {
    status: "running",
    initialDepositUsd: 1234.5,
    collectedFeesUsd: 12.34,
    totalCompoundedUsd: 56.78,
    hodlBaseline: {
      entryValue: 1000,
      hodlAmount0: 1.5,
      hodlAmount1: 2.5,
      token0UsdPrice: 0.002,
      token1UsdPrice: 0.001,
      mintDate: "2026-07-18",
      mintTimestamp: 1_752_000_000,
      mintGasWei: "12345",
    },
    residuals: { amount0: "10", amount1: "20" },
    pnlSnapshot: { totalIL: -5, lifetimeIL: -9, lifetimeDepositUsd: 900 },
  };
  const { out } = await captureConsole(() => printPosition(KEY, pos));
  const text = out.join("\n");
  assert.match(text, new RegExp(`Position: ${KEY}`));
  assert.match(text, /status:\s+running/);
  assert.match(text, /HODL baseline:/);
  assert.match(text, /mintDate:\s+2026-07-18/);
  assert.match(text, /residuals \(raw token units\):/);
  assert.match(text, /pnlSnapshot:/);
});

test("printPosition — absent status reads as the stopped default", async () => {
  const { out } = await captureConsole(() => printPosition(KEY, {}));
  assert.match(out.join("\n"), /\(absent → stopped\)/);
});

test("printPosition — missing sub-objects render placeholders", async () => {
  /*- The tool's whole job is showing what is and is not on disk, so a
   *  bare `undefined` would be a defect. */
  const { out } = await captureConsole(() => printPosition(KEY, {}));
  const text = out.join("\n");
  assert.doesNotMatch(text, /undefined/);
  assert.match(text, /mintDate:\s+—/);
  assert.match(text, /amount0:\s+—/);
  assert.match(text, /closedEpochs:\s+—/);
});

test("printPosition — closedEpochs shows the array length", async () => {
  const { out } = await captureConsole(() =>
    printPosition(KEY, { pnlSnapshot: { closedEpochs: [1, 2, 3] } }),
  );
  assert.match(out.join("\n"), /closedEpochs:\s+3/);
});

test("printPosition — liveEpoch start falls back to startedAt", async () => {
  const { out } = await captureConsole(() =>
    printPosition(KEY, {
      pnlSnapshot: { liveEpoch: { startedAt: "2026-08-01" } },
    }),
  );
  assert.match(out.join("\n"), /liveEpoch start:\s+2026-08-01/);
});

test("printPosition — liveEpoch line omitted when there is none", async () => {
  const { out } = await captureConsole(() => printPosition(KEY, {}));
  assert.doesNotMatch(out.join("\n"), /liveEpoch start/);
});

test("printPosition — compoundHistory count shows only if any", async () => {
  const withHist = await captureConsole(() =>
    printPosition(KEY, { compoundHistory: [{}, {}] }),
  );
  assert.match(withHist.out.join("\n"), /compoundHistory:\s+2 entries/);
  const without = await captureConsole(() =>
    printPosition(KEY, { compoundHistory: [] }),
  );
  assert.doesNotMatch(without.out.join("\n"), /compoundHistory:/);
});

test("printEpochEntry — renders liveEpoch + closedEpochs count", async () => {
  const entry = {
    cachedAt: "2026-08-04T00:00:00Z",
    liveEpoch: { startDate: "2026-07-18", netIL: -3, totalFees: 7, gasUsd: 1 },
    closedEpochs: [1, 2],
  };
  const { out } = await captureConsole(() =>
    printEpochEntry("pool.key", entry),
  );
  const text = out.join("\n");
  assert.match(text, /Pool epoch cache: pool\.key/);
  assert.match(text, /liveEpoch:/);
  assert.match(text, /startDate:\s+2026-07-18/);
  assert.match(text, /closedEpochs:\s+2/);
});

test("printEpochEntry — a bare entry renders zero closedEpochs", async () => {
  const { out } = await captureConsole(() => printEpochEntry("k", {}));
  const text = out.join("\n");
  assert.match(text, /cachedAt:\s+—/);
  assert.match(text, /closedEpochs:\s+0/);
  assert.doesNotMatch(text, /liveEpoch:/);
});

test("printEpochEntry — lifetimeHodlAmounts lists each deposit", async () => {
  const entry = {
    lifetimeHodlAmounts: {
      amount0: 1.5,
      amount1: 2.5,
      lastBlock: 27_000_000,
      deposits: [
        { block: 100, raw0: "10", raw1: "20" },
        { block: 200, raw0: "30", raw1: "40" },
      ],
    },
  };
  const { out } = await captureConsole(() => printEpochEntry("k", entry));
  const text = out.join("\n");
  assert.match(text, /lifetimeHodlAmounts \(pool-level on-chain truth\)/);
  assert.match(text, /deposits:\s+2/);
  assert.match(text, /block 100: raw0=10 raw1=20/);
  assert.match(text, /block 200: raw0=30 raw1=40/);
});

test("printEpochEntry — deposit with no block gets a placeholder", async () => {
  const entry = {
    lifetimeHodlAmounts: { deposits: [{ raw0: "1", raw1: "2" }] },
  };
  const { out } = await captureConsole(() => printEpochEntry("k", entry));
  assert.match(out.join("\n"), /block \?: raw0=1 raw1=2/);
});

test("printEpochEntry — freshDeposits count shows only if any", async () => {
  const withFresh = await captureConsole(() =>
    printEpochEntry("k", { freshDeposits: [{}] }),
  );
  assert.match(withFresh.out.join("\n"), /freshDeposits:\s+1 entries/);
  const without = await captureConsole(() =>
    printEpochEntry("k", { freshDeposits: [] }),
  );
  assert.doesNotMatch(without.out.join("\n"), /freshDeposits:/);
});
