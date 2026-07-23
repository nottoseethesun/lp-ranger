"use strict";

/**
 * @file test/dashboard-rebalance-scan-gate.test.js
 * @description Tests for the pure decisions extracted from
 *   `_handleRebalance` in `public/dashboard-data-events.js`:
 *   `_shouldTriggerRebalanceScan(lastRebalanceAt, trackedAt)` and
 *   `_shouldCommitRebalanceScan(scanResult, at, trackedAt, ev)`.
 *   The prior test file mirrored the whole orchestrator; the extracts
 *   pin the exact "advance-tracker-AFTER-success, retry-on-failure"
 *   contract that was the point of the fix.
 *
 *   Bug the gates prevent: during burn-in a managed-but-unfocused
 *   position that rebalanced while the user was away/idle showed up
 *   in the LP Browser as "old NFT closed, new NFT missing" until a
 *   manual scan.  Root cause: the silent scan triggered on
 *   `lastRebalanceAt` change was fire-and-forget AND `_lastRebAt` was
 *   advanced BEFORE the scan ran, so a transient failure left the
 *   tracker masking the rebalance forever — no retry on next poll.
 *
 *   Fix: trigger the scan first, and only advance `_lastRebAt` (which
 *   ALSO gates the Activity Log entry) inside the `.then()` after
 *   `r.ok`.  Concurrent in-flight scans dedupe via a second check on
 *   the same tracker.  Failed scans leave the tracker unset and
 *   naturally retry on the next 3 s `/api/status` poll.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-data-events.js");
});

// ── _shouldTriggerRebalanceScan ────────────────────────────────────────

describe("_shouldTriggerRebalanceScan()", () => {
  it("skips when there is no lastRebalanceAt (nothing to scan for)", () => {
    assert.strictEqual(mod._shouldTriggerRebalanceScan(null, null), false);
    assert.strictEqual(mod._shouldTriggerRebalanceScan(undefined, null), false);
    assert.strictEqual(mod._shouldTriggerRebalanceScan("", null), false);
  });

  it("skips when lastRebalanceAt matches the tracker (already handled)", () => {
    assert.strictEqual(
      mod._shouldTriggerRebalanceScan(
        "2026-05-10T00:00:00.000Z",
        "2026-05-10T00:00:00.000Z",
      ),
      false,
    );
  });

  it("triggers when lastRebalanceAt is present and unseen (fresh event)", () => {
    assert.strictEqual(
      mod._shouldTriggerRebalanceScan("2026-05-10T01:00:00.000Z", null),
      true,
    );
    assert.strictEqual(
      mod._shouldTriggerRebalanceScan(
        "2026-05-10T02:00:00.000Z",
        "2026-05-10T01:00:00.000Z",
      ),
      true,
    );
  });

  it(
    "returns true again on the next poll after a failed scan — the tracker " +
      "was intentionally NOT advanced, so this is what makes the retry fire",
    () => {
      // Simulates: first poll triggered a scan, scan failed, tracker
      // stays at null.  Next poll sees the same lastRebalanceAt.
      const at = "2026-05-10T01:00:00.000Z";
      let tracked = null;
      assert.strictEqual(mod._shouldTriggerRebalanceScan(at, tracked), true);
      // scan failed → tracker not advanced
      // next poll:
      assert.strictEqual(mod._shouldTriggerRebalanceScan(at, tracked), true);
      // scan succeeded → tracker advances
      tracked = at;
      assert.strictEqual(mod._shouldTriggerRebalanceScan(at, tracked), false);
    },
  );
});

// ── _shouldCommitRebalanceScan ─────────────────────────────────────────

describe("_shouldCommitRebalanceScan()", () => {
  const _ev = { oldTokenId: "100", newTokenId: "200", txHash: "0xaaa" };
  const _at = "2026-05-10T01:00:00.000Z";

  it("commit=false on failed scan (tracker stays unset → next poll retries)", () => {
    assert.deepStrictEqual(
      mod._shouldCommitRebalanceScan({ ok: false }, _at, null, _ev),
      { commit: false, log: false },
    );
  });

  it("commit=false on null / undefined scan result", () => {
    assert.deepStrictEqual(
      mod._shouldCommitRebalanceScan(null, _at, null, _ev),
      { commit: false, log: false },
    );
    assert.deepStrictEqual(
      mod._shouldCommitRebalanceScan(undefined, _at, null, _ev),
      { commit: false, log: false },
    );
  });

  it(
    "commit=false when tracker already matches — concurrent in-flight scan " +
      "already committed",
    () => {
      /*- Two polls fire while the first scan is in flight; both resolve
       *  ok.  The first resolution advances the tracker; the second sees
       *  `_lastRebAt.get(key) === at` and exits before logging again. */
      assert.deepStrictEqual(
        mod._shouldCommitRebalanceScan({ ok: true }, _at, _at, _ev),
        { commit: false, log: false },
      );
    },
  );

  it("commit=true, log=true on successful scan with an event to log", () => {
    assert.deepStrictEqual(
      mod._shouldCommitRebalanceScan({ ok: true }, _at, null, _ev),
      { commit: true, log: true },
    );
  });

  it(
    "commit=true, log=false when the payload has no rebalance event yet — " +
      "advance the tracker so the next poll doesn't loop, but skip the log",
    () => {
      /*- Edge case: the event scan is mid-cycle so lastRebalanceAt is
       *  set but rebalanceEvents is empty.  Advancing the tracker
       *  prevents a re-fire loop; a future poll won't re-log because the
       *  tracker matches. */
      assert.deepStrictEqual(
        mod._shouldCommitRebalanceScan({ ok: true }, _at, null, null),
        { commit: true, log: false },
      );
    },
  );
});
