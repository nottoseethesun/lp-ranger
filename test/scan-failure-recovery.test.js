/**
 * @file test/scan-failure-recovery.test.js
 * @description Guards two ways a failed or partial scan can leave the
 *   app stuck, both of which put the recovery burden on the operator.
 *
 * 1. A scan that throws must not leave the global status on "scanning".
 *    "scanning" means "still coming" to every reader, so the dashboard
 *    pulses its Syncing badge indefinitely and holds the KPI, range and
 *    history panels under blur with pointer-events disabled. Nothing
 *    short of a restart clears it.
 *
 * 2. A scan that skips a window under best-effort must not record
 *    "scanned through the chain head". The next scan resumes past the
 *    hole, so the events inside it stay missing until someone runs
 *    Reload Position by hand.
 *
 * Both are silent: the app looks like it is working.
 */

"use strict";

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let sync;

before(async () => {
  sync = await import("../public/dashboard-sync-decisions.js");
});

/*- The startup shape: a wallet is loaded, the position list has not
 *  arrived, nothing is selected. */
const STARTUP = {
  active: null,
  walletAddress: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
  positionCount: 0,
  positionManaged: false,
  viewingClosed: false,
  positionScan: null,
  rebalanceScanComplete: false,
  lifetimeScanComplete: false,
};

/** What the dashboard actually renders for a given decision. */
function rendered(r) {
  return {
    text: r.label || "Syncing…",
    /*- `complete` drives the `done` class, which is also what
     *  applySyncBlur mirrors onto the panels. */
    panelsUsable: r.complete === true,
  };
}

describe("a failed position scan must not freeze the dashboard", () => {
  it("treats an errored scan as terminal, not as still-running", () => {
    /*- The regression this exists for: "error" read as "not ready"
     *  leaves the badge pulsing and the panels blurred with nothing
     *  left to arrive. */
    const r = sync._computeSyncStatus({
      ...STARTUP,
      positionScan: { status: "error" },
    });
    const { panelsUsable } = rendered(r);
    assert.equal(
      panelsUsable,
      true,
      "an errored scan has nothing further to deliver — waiting on it is a permanently blurred screen",
    );
  });

  it("still waits while a scan is genuinely in progress", () => {
    const r = sync._computeSyncStatus({
      ...STARTUP,
      positionScan: { status: "scanning" },
    });
    assert.equal(rendered(r).panelsUsable, false);
  });

  it("still waits before a scan has started", () => {
    /*- "idle" is not an answer: nobody has looked yet. */
    const r = sync._computeSyncStatus({
      ...STARTUP,
      positionScan: { status: "idle" },
    });
    assert.equal(rendered(r).panelsUsable, false);
  });

  it("never leaves the badge reading Syncing while the panels are usable", () => {
    /*- Text and colour come from the same decision and must agree in
     *  every scan state, including the new one. */
    for (const status of ["idle", "scanning", "ready", "error"]) {
      const { text, panelsUsable } = rendered(
        sync._computeSyncStatus({ ...STARTUP, positionScan: { status } }),
      );
      assert.equal(
        panelsUsable,
        text === "Synced",
        `status "${status}" rendered "${text}" with panelsUsable=${panelsUsable}`,
      );
    }
  });
});

describe("the scan handler records a terminal status when it fails", () => {
  /*- Drives the REAL handler.  An earlier version of this test rebuilt
   *  the handler's try/catch locally, which proves nothing about the
   *  handler: the copy would keep passing after the real one changed. */
  const { createScanHandlers } = require("../src/server-scan");
  const sendTx = require("../src/send-transaction");

  /**
   * Run the real scan handler with the RPC layer uninitialised, so the
   * scan throws the way it would during a genuine outage.
   * @returns {Promise<{statuses: string[], status: number, body: object}>}
   */
  async function runFailingScan() {
    /*- No init() means getManagedReadProvider's proxy throws on first
     *  use — a real failure inside _doScan, not a simulated one. */
    sendTx._resetForTests();

    const statuses = [];
    const sent = {};
    const handlers = createScanHandlers({
      walletManager: {
        getStatus: () => ({
          loaded: true,
          address: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
        }),
      },
      jsonResponse: (_res, status, body) => {
        sent.status = status;
        sent.body = body;
      },
      readJsonBody: async () => ({}),
      getGlobalScanStatus: () => ({ status: statuses[statuses.length - 1] }),
      setGlobalScanStatus: (s) => statuses.push(s),
      getAllPositionBotStates: () => ({}),
      positionMgr: { getAll: () => [] },
    });

    let threw = null;
    try {
      await handlers._handlePositionsScan({}, {});
    } catch (e) {
      threw = e;
    }
    return { statuses, threw, ...sent };
  }

  it("does not leave the status on scanning when the scan dies", async () => {
    /*- The freeze: "scanning" means "still coming" to every reader, so
     *  the dashboard waits on it forever — badge pulsing, panels blurred
     *  and click-through-disabled — with nothing left to arrive. */
    const { statuses } = await runFailingScan();
    assert.notEqual(
      statuses[statuses.length - 1],
      "scanning",
      "a dead scan that still reads as running freezes the dashboard",
    );
  });

  it("records a terminal status the client understands", async () => {
    const { statuses } = await runFailingScan();
    const last = statuses[statuses.length - 1];
    assert.ok(
      last === "error" || last === "ready",
      `expected a terminal status, got "${last}"`,
    );
    /*- And the client must treat whatever it is as terminal, or the
     *  freeze comes straight back. */
    const r = sync._computeSyncStatus({
      ...STARTUP,
      positionScan: { status: last },
    });
    assert.equal(rendered(r).panelsUsable, true);
  });

  it("still surfaces the failure rather than swallowing it", async () => {
    /*- Recording the outcome must not turn a failure into a success. */
    const { threw, status, body } = await runFailingScan();
    const reported =
      threw !== null || status >= 400 || (body && body.ok === false);
    assert.ok(reported, "the failure must reach the caller somehow");
  });
});

describe("a partial scan must not claim ground it never read", () => {
  /*- Drives the real _resolveLastBlock.  Re-implementing it here would
   *  be a mirror: the copy would keep passing after the real rule
   *  changed, which is the one thing a test must never do. */
  const { _resolveLastBlock } = require("../src/event-scanner");

  /** The scan result carries the first hole, or none. */
  const result = (firstGapFrom) => {
    const events = [];
    if (firstGapFrom !== null) events.firstGapFrom = firstGapFrom;
    return events;
  };
  const lastBlock = (firstGapFrom, scanFrom, head) =>
    _resolveLastBlock(result(firstGapFrom), scanFrom, head);

  it("records the chain head when every window was read", () => {
    assert.equal(lastBlock(null, 500, 9000), 9000);
  });

  it("stops one block short of the first hole", () => {
    /*- So the next scan resumes inside the gap and fills it, instead of
     *  the operator discovering missing events and running Reload
     *  Position by hand. */
    assert.equal(lastBlock(1000, 500, 9000), 999);
  });

  it("never moves the marker backwards past where the scan began", () => {
    /*- Blocks before scanFrom were covered by an earlier scan; rewinding
     *  into them would re-read history every time. */
    assert.equal(lastBlock(400, 500, 9000), 499);
  });

  it("keeps the earliest hole when several windows fail", () => {
    const gaps = [4000, 1500, 7000];
    const earliest = Math.min(...gaps);
    assert.equal(lastBlock(earliest, 500, 9000), 1499);
  });
});
