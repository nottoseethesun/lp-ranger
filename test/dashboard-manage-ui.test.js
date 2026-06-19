"use strict";

/**
 * @file test/dashboard-manage-ui.test.js
 * @description Unit tests for the pure `computeManageUI` decision tree
 * that owns the dashboard's Manage button + badge + Lifetime panel +
 * Pool-details button rendering.
 *
 * The production function lives in `public/dashboard-manage-ui.js`
 * (browser ES module).  The dashboard's other ES modules pull in DOM
 * globals at import time, so node:test cannot import the browser
 * module directly — mirror the function here, same pattern as
 * `test/dashboard-mixed-state-fix.test.js`.  Keep the two copies in
 * sync if the decision tree changes.
 *
 * @see public/dashboard-manage-ui.js
 */

const { test } = require("node:test");
const assert = require("node:assert");
const { GUARANTEED_DASHBOARD_HAS_POLLED_MS } = require("../src/config");

// ── Mirrored copy of public/dashboard-manage-ui.js's pure compute ───

const MANAGE_SYNCING_HELP =
  'This button will be clickable once the "Syncing…" badge above is finished.';
/*- Production code reads this from /api/status's
 *  guaranteedDashboardHasPolledMs (server flows it from
 *  src/config.js).  Tests import the canonical config value so the
 *  literal 7500 lives in exactly one place. */
const RETIRE_DEBOUNCE_MS = GUARANTEED_DASHBOARD_HAS_POLLED_MS;

const _MANAGE_REOPEN_HELP =
  "Re-open this closed position (requires a rebalance to seed liquidity from your wallet).";
const _MANAGE_STOP_HELP =
  "Remove this position from active management by LP Ranger.";
const _MANAGE_START_HELP =
  "Bring this position under active management by LP Ranger.";
const _MANAGE_REBALANCING_HELP =
  "Re-open in progress — bot is submitting the rebalance. Wait for completion.";
const _MANAGE_RECOVERY_HELP =
  "Re-open recovering — bot is retrying mint from wallet balances. Wait for completion.";
const _MANAGE_PAUSED_HELP =
  "Re-open just failed — the bot will auto-retire shortly. Watch for the alert above.";
const _MANAGE_DEBOUNCE_HELP =
  "Re-open just retired — wait a moment so the alert above can render.";
const _MANAGE_LOCKED_HELP = "Unlock wallet to manage positions";
const _MANAGE_ERC20_HELP = "Only NFT (V3) positions can be managed";
const _MANAGE_LOADING_HELP = "Loading position state…";
const _MANAGE_REBALANCE_OPEN_HELP =
  "Rebalance in progress — wait for completion before clicking again.";
const _NO_ACTIVE_HELP = "Select a position first";
const _PD_VIEW_HELP = "View pool and contract details";

function _deriveBadgeText(isClosed, isRunning) {
  if (isClosed) return "Position Closed";
  if (isRunning) return "Being Actively Managed";
  return "Not Actively Managed";
}

function _computeClosedSynced(posState, nowMs, retireDebounceMs) {
  let disabled = false;
  let title = _MANAGE_REOPEN_HELP;
  if (posState.rebalanceInProgress || posState.forceRebalance) {
    disabled = true;
    title = _MANAGE_REBALANCING_HELP;
  } else if (posState.rebalanceFailedMidway) {
    disabled = true;
    title = _MANAGE_RECOVERY_HELP;
  } else if (posState.rebalancePaused) {
    disabled = true;
    title = _MANAGE_PAUSED_HELP;
  } else if (
    posState.lastRetiredAt &&
    retireDebounceMs &&
    nowMs - posState.lastRetiredAt < retireDebounceMs
  ) {
    disabled = true;
    title = _MANAGE_DEBOUNCE_HELP;
  }
  return {
    buttonText: "Manage",
    buttonDisabled: disabled,
    buttonTitle: title,
    badgeText: "Position Closed",
    badgeManaged: false,
    lifetimeVisible: false,
    pdBtnDisabled: false,
    pdBtnTitle: _PD_VIEW_HELP,
  };
}

function _computeOpenSynced(posState, isRunning, currentText) {
  if (posState.rebalanceInProgress) {
    return {
      buttonText: currentText,
      buttonDisabled: true,
      buttonTitle: _MANAGE_REBALANCE_OPEN_HELP,
      badgeText: _deriveBadgeText(false, isRunning),
      badgeManaged: isRunning,
      lifetimeVisible: isRunning,
      pdBtnDisabled: false,
      pdBtnTitle: _PD_VIEW_HELP,
    };
  }
  if (isRunning) {
    return {
      buttonText: "Stop Managing",
      buttonDisabled: false,
      buttonTitle: _MANAGE_STOP_HELP,
      badgeText: "Being Actively Managed",
      badgeManaged: true,
      lifetimeVisible: true,
      pdBtnDisabled: false,
      pdBtnTitle: _PD_VIEW_HELP,
    };
  }
  return {
    buttonText: "Manage",
    buttonDisabled: false,
    buttonTitle: _MANAGE_START_HELP,
    badgeText: "Not Actively Managed",
    badgeManaged: false,
    lifetimeVisible: false,
    pdBtnDisabled: false,
    pdBtnTitle: _PD_VIEW_HELP,
  };
}

function computeManageUI(inputs) {
  const {
    hasActive,
    isClosed,
    isNft,
    posState,
    syncComplete,
    walletUnlocked,
    manageInFlight,
    nowMs,
    retireDebounceMs,
  } = inputs;

  if (!hasActive) {
    return {
      buttonText: "Manage",
      buttonDisabled: true,
      buttonTitle: _NO_ACTIVE_HELP,
      badgeText: "Not Actively Managed",
      badgeManaged: false,
      lifetimeVisible: false,
      pdBtnDisabled: true,
      pdBtnTitle: _NO_ACTIVE_HELP,
    };
  }
  if (manageInFlight) return null;
  if (!posState) {
    return {
      buttonText: "Manage",
      buttonDisabled: true,
      buttonTitle: _MANAGE_LOADING_HELP,
      badgeText: isClosed ? "Position Closed" : "Not Actively Managed",
      badgeManaged: false,
      lifetimeVisible: false,
      pdBtnDisabled: false,
      pdBtnTitle: _PD_VIEW_HELP,
    };
  }

  const isRunning = posState.status === "running" && !isClosed;
  const badgeText = _deriveBadgeText(isClosed, isRunning);
  const _currentText = isRunning ? "Stop Managing" : "Manage";
  const _common = {
    badgeText,
    badgeManaged: isRunning,
    lifetimeVisible: isRunning,
    pdBtnDisabled: false,
    pdBtnTitle: _PD_VIEW_HELP,
  };

  if (!walletUnlocked) {
    return {
      buttonText: isClosed ? "Manage" : _currentText,
      buttonDisabled: true,
      buttonTitle: _MANAGE_LOCKED_HELP,
      ..._common,
    };
  }
  if (!isNft) {
    return {
      buttonText: "Manage",
      buttonDisabled: true,
      buttonTitle: _MANAGE_ERC20_HELP,
      ..._common,
    };
  }
  if (!syncComplete) {
    return {
      buttonText: isClosed ? "Manage" : _currentText,
      buttonDisabled: true,
      buttonTitle: MANAGE_SYNCING_HELP,
      ..._common,
    };
  }
  if (isClosed) return _computeClosedSynced(posState, nowMs, retireDebounceMs);
  return _computeOpenSynced(posState, isRunning, _currentText);
}

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
