"use strict";

/**
 * @file test/dashboard-manage-ui.test.js
 * @description Unit tests for the pure `computeManageUI` decision tree
 *   that owns the dashboard's Manage button + badge + Lifetime panel +
 *   Pool-details button rendering.  Drives the real
 *   `computeManageUI` export from `public/dashboard-manage-ui.js`
 *   under jsdom — no mirror.  `MANAGE_SYNCING_HELP` is imported from
 *   the same module so tests match the exact string the UI paints.
 */

require("global-jsdom/register");

const { test, before } = require("node:test");
const assert = require("node:assert");
const { GUARANTEED_DASHBOARD_HAS_POLLED_MS } = require("../src/config");

let computeManageUI;
let MANAGE_SYNCING_HELP;

before(async () => {
  const mod = await import("../public/dashboard-manage-ui.js");
  computeManageUI = mod.computeManageUI;
  MANAGE_SYNCING_HELP = mod.MANAGE_SYNCING_HELP;
});

const RETIRE_DEBOUNCE_MS = GUARANTEED_DASHBOARD_HAS_POLLED_MS;

// ── Test fixtures ────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

/** Build a happy-path input object — override fields per-test. */
function ins(overrides) {
  return {
    hasActive: true,
    isClosed: false,
    isNft: true,
    posState: { status: "stopped" },
    syncComplete: true,
    walletUnlocked: true,
    manageInFlight: false,
    nowMs: NOW,
    retireDebounceMs: RETIRE_DEBOUNCE_MS,
    ...overrides,
  };
}

// ── No-active branch ─────────────────────────────────────────────────

test("no active position: button + badge + pd disabled with select-first", () => {
  const s = computeManageUI(ins({ hasActive: false }));
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonTitle, "Select a position first");
  assert.equal(s.badgeText, "Not Actively Managed");
  assert.equal(s.badgeManaged, false);
  assert.equal(s.lifetimeVisible, false);
  assert.equal(s.pdBtnDisabled, true);
  assert.equal(s.pdBtnTitle, "Select a position first");
});

// ── manage-in-flight branch ──────────────────────────────────────────

test("manage in-flight: returns null (applier skips, preserves optimistic UI)", () => {
  const s = computeManageUI(ins({ manageInFlight: true }));
  assert.equal(s, null);
});

// ── posState null (pre-first-poll) branch ────────────────────────────

test("posState=null open: Loading…, badge Not Actively Managed", () => {
  const s = computeManageUI(ins({ posState: null }));
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonTitle, "Loading position state…");
  assert.equal(s.badgeText, "Not Actively Managed");
  assert.equal(s.pdBtnDisabled, false);
});

test("posState=null closed: Loading…, badge Position Closed", () => {
  const s = computeManageUI(ins({ posState: null, isClosed: true }));
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.badgeText, "Position Closed");
});

// ── Wallet locked branch ─────────────────────────────────────────────

test("wallet locked open running: Stop Managing disabled, locked tooltip", () => {
  const s = computeManageUI(
    ins({ walletUnlocked: false, posState: { status: "running" } }),
  );
  assert.equal(s.buttonText, "Stop Managing");
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonTitle, "Unlock wallet to manage positions");
  assert.equal(s.badgeText, "Being Actively Managed");
  assert.equal(s.badgeManaged, true);
});

test("wallet locked closed: Manage disabled, locked tooltip, Position Closed badge", () => {
  const s = computeManageUI(
    ins({
      walletUnlocked: false,
      isClosed: true,
      posState: { status: "stopped" },
    }),
  );
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonTitle, "Unlock wallet to manage positions");
  assert.equal(s.badgeText, "Position Closed");
});

// ── ERC-20 branch ────────────────────────────────────────────────────

test("ERC-20 position: Manage disabled with NFT-only tooltip", () => {
  const s = computeManageUI(ins({ isNft: false }));
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonTitle, "Only NFT (V3) positions can be managed");
});

// ── Sync gate ────────────────────────────────────────────────────────

test("syncing open: keeps current text disabled with sync hint", () => {
  const s = computeManageUI(
    ins({ syncComplete: false, posState: { status: "running" } }),
  );
  assert.equal(s.buttonText, "Stop Managing");
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonTitle, MANAGE_SYNCING_HELP);
});

test("syncing closed: Manage disabled with sync hint, Position Closed badge", () => {
  const s = computeManageUI(
    ins({
      syncComplete: false,
      isClosed: true,
      posState: { status: "stopped" },
    }),
  );
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, true);
  assert.equal(s.buttonTitle, MANAGE_SYNCING_HELP);
  assert.equal(s.badgeText, "Position Closed");
});

// ── Closed + synced sub-tree ─────────────────────────────────────────

test("closed stopped idle: Manage ENABLED with re-open tooltip", () => {
  const s = computeManageUI(
    ins({ isClosed: true, posState: { status: "stopped" } }),
  );
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, false);
  assert.match(s.buttonTitle, /Re-open this closed position/);
  assert.equal(s.badgeText, "Position Closed");
  assert.equal(s.lifetimeVisible, false);
});

test("closed RUNNING idle (stale-disk-state bug repro): Manage ENABLED", () => {
  const s = computeManageUI(
    ins({ isClosed: true, posState: { status: "running" } }),
  );
  assert.equal(s.buttonDisabled, false, "stale-running closed must be enabled");
  assert.match(s.buttonTitle, /Re-open this closed position/);
});

test("closed + rebalanceInProgress: disabled with TX-in-flight tooltip", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: { status: "running", rebalanceInProgress: true },
    }),
  );
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /Re-open in progress/);
});

test("closed + forceRebalance pre-first-tick window: disabled with TX-in-flight", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: { status: "running", forceRebalance: true },
    }),
  );
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /Re-open in progress/);
});

test("closed + rebalanceFailedMidway: disabled with recovery tooltip", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: { status: "running", rebalanceFailedMidway: true },
    }),
  );
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /Re-open recovering/);
});

test("closed + rebalancePaused: disabled with auto-retiring tooltip (intentional change)", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: { status: "running", rebalancePaused: true },
    }),
  );
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /Re-open just failed/);
});

test("closed + lastRetiredAt within debounce: disabled with debounce tooltip", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: {
        status: "stopped",
        lastRetiredAt: NOW - Math.floor(RETIRE_DEBOUNCE_MS / 2),
      },
    }),
  );
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /wait a moment/i);
});

test("closed + lastRetiredAt past debounce window: ENABLED", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: {
        status: "stopped",
        lastRetiredAt: NOW - (RETIRE_DEBOUNCE_MS + 1000),
      },
    }),
  );
  assert.equal(s.buttonDisabled, false);
});

test("closed + lastRetiredAt exactly at window edge: ENABLED", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: {
        status: "stopped",
        lastRetiredAt: NOW - RETIRE_DEBOUNCE_MS,
      },
    }),
  );
  assert.equal(s.buttonDisabled, false, "boundary excludes equal");
});

test("closed + lastRetiredAt set but retireDebounceMs=0: ENABLED (server didn't ship the value)", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: { status: "stopped", lastRetiredAt: NOW - 1000 },
      retireDebounceMs: 0,
    }),
  );
  assert.equal(s.buttonDisabled, false);
});

// ── Precedence: rebalanceInProgress beats rebalancePaused ───────────

test("precedence: rebalanceInProgress wins over rebalancePaused", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: {
        status: "running",
        rebalanceInProgress: true,
        rebalancePaused: true,
      },
    }),
  );
  assert.match(s.buttonTitle, /Re-open in progress/);
});

test("precedence: forceRebalance wins over rebalancePaused", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      posState: {
        status: "stopped",
        forceRebalance: true,
        rebalancePaused: true,
      },
    }),
  );
  assert.match(s.buttonTitle, /Re-open in progress/);
});

// ── Open + synced sub-tree ───────────────────────────────────────────

test("open + running: Stop Managing ENABLED with green badge + lifetime visible", () => {
  const s = computeManageUI(ins({ posState: { status: "running" } }));
  assert.equal(s.buttonText, "Stop Managing");
  assert.equal(s.buttonDisabled, false);
  assert.equal(s.badgeText, "Being Actively Managed");
  assert.equal(s.badgeManaged, true);
  assert.equal(s.lifetimeVisible, true);
});

test("open + stopped: Manage ENABLED, badge Not Actively Managed, lifetime hidden", () => {
  const s = computeManageUI(ins({ posState: { status: "stopped" } }));
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, false);
  assert.equal(s.badgeText, "Not Actively Managed");
  assert.equal(s.badgeManaged, false);
  assert.equal(s.lifetimeVisible, false);
});

test("open + running + rebalanceInProgress: Stop Managing disabled with rebalance tip", () => {
  const s = computeManageUI(
    ins({
      posState: { status: "running", rebalanceInProgress: true },
    }),
  );
  assert.equal(s.buttonText, "Stop Managing");
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /Rebalance in progress/);
  assert.equal(s.badgeManaged, true);
});

test("open + stopped + rebalanceInProgress: Manage disabled with rebalance tip", () => {
  const s = computeManageUI(
    ins({
      posState: { status: "stopped", rebalanceInProgress: true },
    }),
  );
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, true);
});

// ── PD button parity ────────────────────────────────────────────────

test("pd button enabled with view-details tooltip when active position present", () => {
  const variants = [
    ins({}),
    ins({ posState: null }),
    ins({ walletUnlocked: false }),
    ins({ syncComplete: false }),
    ins({ isClosed: true, posState: { status: "running" } }),
    ins({ isNft: false }),
  ];
  for (const v of variants) {
    const s = computeManageUI(v);
    if (s === null) continue;
    assert.equal(
      s.pdBtnDisabled,
      false,
      "pdBtn disabled in: " + JSON.stringify(v),
    );
    assert.equal(s.pdBtnTitle, "View pool and contract details");
  }
});

// ── Badge consistency ───────────────────────────────────────────────

test("badge: closed always renders Position Closed regardless of status", () => {
  for (const status of ["running", "stopped"]) {
    const s = computeManageUI(ins({ isClosed: true, posState: { status } }));
    assert.equal(s.badgeText, "Position Closed");
    assert.equal(s.badgeManaged, false);
  }
});
