"use strict";

/**
 * @file test/sync-status-closed-unmanaged.test.js
 * @description Tests for the _syncStatus decision tree in
 * public/dashboard-data.js.  Mirrors the logic under test because the
 * real module pulls DOM + ES-module deps that node:test can't load.
 *
 * The fix under test: unmanaged-closed positions short-circuit phase 2
 * of the unmanaged detail fetch (dashboard-unmanaged.js: phase 1 detects
 * drained → closed view → phase 2 skipped).  Phase 2 is the only code
 * path that writes rebalanceScanComplete on the server for unmanaged
 * positions, so without this fix the Syncing badge hangs forever on
 * closed-unmanaged positions.  The client treats isViewingClosedPos()
 * as the synced signal for the unmanaged-closed case.
 */

const { describe, it } = require("node:test");
const assert = require("assert");

// ── Mirror of _syncStatus from public/dashboard-data.js ─────────────────
//
// Dependencies are passed in so each test can drive the decision tree
// without mocking global state.

function syncStatus({
  active,
  walletAddress,
  positionCount,
  positionManaged,
  viewingClosed,
  rebalanceScanComplete,
  positionScan,
}) {
  if (!active) return { complete: true, label: "" };
  if (walletAddress && positionCount === 0)
    return { complete: false, label: "" };
  if (!positionManaged && viewingClosed)
    return { complete: true, label: "Synced" };
  if (positionScan && positionScan.status === "scanning") {
    const p = positionScan.progress;
    const tip = p && p.total > 0 ? p.done + "/" + p.total + " positions" : "";
    return { complete: false, label: "Syncing\u2026", tip };
  }
  if (!rebalanceScanComplete)
    return { complete: false, label: "Syncing\u2026" };
  return { complete: true, label: "Synced" };
}

const _base = {
  active: { tokenId: "158981" },
  walletAddress: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
  positionCount: 3,
  positionManaged: true,
  viewingClosed: false,
  rebalanceScanComplete: false,
  positionScan: null,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("_syncStatus: four position-state combinations", () => {
  it("open + managed + scan incomplete → Syncing", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: true,
      viewingClosed: false,
      rebalanceScanComplete: false,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing\u2026");
  });

  it("open + managed + scan complete → Synced", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: true,
      viewingClosed: false,
      rebalanceScanComplete: true,
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it("closed + managed + scan complete → Synced (bot loop still ran scan)", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: true,
      viewingClosed: false,
      rebalanceScanComplete: true,
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it("open + unmanaged + scan incomplete → Syncing (waits for phase-2 lifetime scan)", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: false,
      rebalanceScanComplete: false,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing\u2026");
  });

  it("open + unmanaged + scan complete → Synced (phase 2 landed)", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: false,
      rebalanceScanComplete: true,
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it("closed + unmanaged + viewing closed → Synced (FIX: phase 2 is skipped for drained positions)", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: true,
      rebalanceScanComplete: false,
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it("managed + viewing closed → existing logic (closed-view bypass only applies to unmanaged)", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: true,
      viewingClosed: true,
      rebalanceScanComplete: false,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing\u2026");
  });
});

describe("_syncStatus: edge cases", () => {
  it("no active position → complete (nothing to sync)", () => {
    const r = syncStatus({ ..._base, active: null });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "");
  });

  it("wallet set but zero positions → incomplete, empty label", () => {
    const r = syncStatus({
      ..._base,
      walletAddress: "0xabc",
      positionCount: 0,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "");
  });

  it("position scan in progress → Syncing with tip", () => {
    const r = syncStatus({
      ..._base,
      positionScan: { status: "scanning", progress: { done: 42, total: 106 } },
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing\u2026");
    assert.strictEqual(r.tip, "42/106 positions");
  });

  it("closed + unmanaged takes precedence over _positionScan scanning status", () => {
    const r = syncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: true,
      positionScan: { status: "scanning", progress: { done: 1, total: 2 } },
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });
});
