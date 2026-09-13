"use strict";

/**
 * @file test/sync-status-closed-unmanaged.test.js
 * @description Tests the pure `_computeSyncStatus` decision extracted
 *   from `_syncStatus` in `public/dashboard-data.js`.  The prior file
 *   mirrored the decision inline; the extract lets the tests drive the
 *   real module directly under jsdom.
 *
 *   The fix under test: unmanaged-closed positions short-circuit
 *   phase 2 of the unmanaged detail fetch (dashboard-unmanaged.js:
 *   phase 1 detects drained → closed view → phase 2 skipped).  Phase 2
 *   is the only path that writes rebalanceScanComplete on the server
 *   for unmanaged positions, so without this short-circuit the Syncing
 *   badge would hang forever on closed-unmanaged positions.  The client
 *   treats `isViewingClosedPos()` as the synced signal for that case.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-data.js");
});

const _base = {
  active: { tokenId: "158981" },
  walletAddress: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
  positionCount: 3,
  positionManaged: true,
  viewingClosed: false,
  positionScan: null,
  rebalanceScanComplete: false,
  lifetimeScanComplete: false,
};

// ── Four position-state combinations ────────────────────────────────

describe("_computeSyncStatus: position-state combinations", () => {
  it("open + managed + scans incomplete → Syncing", () => {
    const r = mod._computeSyncStatus({
      ..._base,
      positionManaged: true,
      viewingClosed: false,
      rebalanceScanComplete: false,
      lifetimeScanComplete: false,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing…");
  });

  it("open + managed + BOTH scans complete → Synced", () => {
    const r = mod._computeSyncStatus({
      ..._base,
      positionManaged: true,
      viewingClosed: false,
      rebalanceScanComplete: true,
      lifetimeScanComplete: true,
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it(
    "open + managed + rebalanceScan complete but lifetime NOT complete → " +
      "Syncing (managed positions must clear both scans)",
    () => {
      /*- Regression pin: the earlier mirror in this test file did NOT
       *  cover the lifetimeScanComplete gate, so it silently drifted
       *  away from the real module's contract.  Extract-then-test
       *  eliminates that drift. */
      const r = mod._computeSyncStatus({
        ..._base,
        positionManaged: true,
        viewingClosed: false,
        rebalanceScanComplete: true,
        lifetimeScanComplete: false,
      });
      assert.strictEqual(r.complete, false);
      assert.strictEqual(r.label, "Syncing…");
    },
  );

  it("open + unmanaged + rebalance scan incomplete → Syncing", () => {
    const r = mod._computeSyncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: false,
      rebalanceScanComplete: false,
      lifetimeScanComplete: false,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing…");
  });

  it("open + unmanaged + rebalance complete → Synced (lifetime is n/a for unmanaged)", () => {
    /*- Unmanaged positions don't render a Lifetime panel; the flag is
     *  structurally irrelevant for them and must NOT gate the badge. */
    const r = mod._computeSyncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: false,
      rebalanceScanComplete: true,
      lifetimeScanComplete: false,
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it("closed + unmanaged + viewing closed → Synced (FIX: phase 2 is skipped for drained positions)", () => {
    const r = mod._computeSyncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: true,
      rebalanceScanComplete: false,
      lifetimeScanComplete: false,
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it("managed + viewing closed → existing logic (closed-view bypass only applies to unmanaged)", () => {
    const r = mod._computeSyncStatus({
      ..._base,
      positionManaged: true,
      viewingClosed: true,
      rebalanceScanComplete: false,
      lifetimeScanComplete: false,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing…");
  });
});

describe("_computeSyncStatus: edge cases", () => {
  it("no active position → complete, labelled Synced", () => {
    /*- Every branch must name its label outright.  The caller renders
     *  an empty label as "Syncing…" while `complete: true` paints the
     *  badge green and still, so an unset label contradicts itself. */
    const r = mod._computeSyncStatus({ ..._base, active: null });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });

  it("wallet set, zero positions, scan not finished → Syncing", () => {
    /*- Same reasoning as above: the label was "" and relied on the
     *  caller's fallback.  Named explicitly now. */
    const r = mod._computeSyncStatus({
      ..._base,
      walletAddress: "0xabc",
      positionCount: 0,
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing\u2026");
  });

  it("position scan in progress → Syncing with tip", () => {
    const r = mod._computeSyncStatus({
      ..._base,
      positionScan: {
        status: "scanning",
        progress: { done: 42, total: 106 },
      },
    });
    assert.strictEqual(r.complete, false);
    assert.strictEqual(r.label, "Syncing…");
    assert.strictEqual(r.tip, "42/106 positions");
  });

  it("closed + unmanaged takes precedence over _positionScan scanning status", () => {
    const r = mod._computeSyncStatus({
      ..._base,
      positionManaged: false,
      viewingClosed: true,
      positionScan: {
        status: "scanning",
        progress: { done: 1, total: 2 },
      },
    });
    assert.strictEqual(r.complete, true);
    assert.strictEqual(r.label, "Synced");
  });
});

/*- The badge's text and its colour come from the same result: `label`
 *  supplies the words, `complete` toggles the `done` class that turns it
 *  green and stops the pulse.  They must never disagree.
 *
 *  They did.  `!active` returned `{complete: true, label: ""}`, and the
 *  caller renders an empty label as "Syncing…", so for the whole of
 *  startup the badge read "Syncing…" while painted green and still.
 *  That early return also made the wallet-loaded-no-positions branch
 *  below it unreachable, which is where the correct answer already was. */
describe("_computeSyncStatus — badge text must match badge colour", () => {
  const startup = {
    active: null,
    walletAddress: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
    positionCount: 0,
    positionManaged: false,
    viewingClosed: false,
    positionScan: null,
    rebalanceScanComplete: false,
    lifetimeScanComplete: false,
  };

  /** What the caller actually renders for a given result. */
  const rendered = (r) => ({
    text: r.label || "Syncing\u2026",
    green: r.complete === true,
  });

  it("never says Syncing while painted as done", () => {
    /*- The invariant, stated once and checked across every shape the
     *  inputs take during startup and steady state. */
    const cases = [
      startup,
      { ...startup, positionScan: { status: "idle" } },
      { ...startup, positionScan: { status: "scanning" } },
      { ...startup, positionScan: { status: "ready" } },
      { ...startup, positionCount: 16, positionScan: { status: "ready" } },
      { ...startup, walletAddress: null },
      {
        ...startup,
        active: { tokenId: "71544" },
        positionCount: 16,
        positionManaged: true,
        positionScan: { status: "scanning", progress: { done: 3, total: 16 } },
      },
      {
        ...startup,
        active: { tokenId: "71544" },
        positionCount: 16,
        positionManaged: true,
        rebalanceScanComplete: true,
        lifetimeScanComplete: true,
      },
    ];
    for (const c of cases) {
      const { text, green } = rendered(mod._computeSyncStatus(c));
      assert.equal(
        green,
        text === "Synced",
        `badge read "${text}" while green=${green} for ${JSON.stringify(c.positionScan)} count=${c.positionCount} active=${Boolean(c.active)}`,
      );
    }
  });

  it("pulses Syncing at startup, before the position scan has run", () => {
    const r = mod._computeSyncStatus({
      ...startup,
      positionScan: { status: "idle" },
    });
    assert.equal(r.complete, false, "must not wear the done class");
    assert.equal(r.label, "Syncing\u2026");
  });

  it("settles to Synced once a finished scan finds no positions", () => {
    /*- A completed scan that found nothing is an answer, not a pending
     *  state — pulsing forever at a wallet with no LP positions would be
     *  a lie in the other direction. */
    const r = mod._computeSyncStatus({
      ...startup,
      positionScan: { status: "ready" },
    });
    assert.equal(r.complete, true);
    assert.equal(r.label, "Synced");
  });
});
