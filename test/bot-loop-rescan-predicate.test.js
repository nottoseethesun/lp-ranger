/**
 * @file test/bot-loop-rescan-predicate.test.js
 * @description Tests for the two pieces of the 30-minute auto-rescan
 * timer in src/bot-loop.js that were extracted to be testable:
 * `_needsLifetimeRescan`, which decides whether to rescan and why, and
 * `_countRescan`, which numbers the attempts for the log.
 *
 * It gets its own file because the timer that calls it has no test
 * fixture (docs/roadmap/nice-to-haves/project_bot_loop_test_scaffolding.md),
 * and the decision it makes schedules the most expensive thing the bot
 * does unattended: a full pool scan plus a per-NFT walk of the whole
 * rebalance chain.  Wrong in one direction that runs every thirty
 * minutes for the life of the process; wrong in the other and figures
 * built from a short history stand until the next restart.
 *
 * The reason string is asserted as carefully as the boolean.  It is the
 * only account an operator gets of why an expensive scan started, and
 * the burn-in procedure greps for it.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { _needsLifetimeRescan, _countRescan } = require("../src/bot-loop");

/*- A settled position: scan finished, history complete, deposits found.
 *  Every case below is this with one thing changed, so the assertions
 *  name the trigger rather than the fixture. */
const settled = () => ({
  _needsFullRescan: false,
  lifetimeScanComplete: true,
  _epochHistoryIncomplete: false,
  totalLifetimeDepositUsd: 1234.56,
});

describe("_needsLifetimeRescan()", () => {
  it("stays quiet on a settled position", () => {
    const { needed, reason } = _needsLifetimeRescan(settled());
    assert.strictEqual(needed, false);
    assert.strictEqual(reason, "", "nothing to explain when nothing fires");
  });

  it("fires on a rebalance's full-rescan request", () => {
    const r = _needsLifetimeRescan({ ...settled(), _needsFullRescan: true });
    assert.strictEqual(r.needed, true);
    assert.strictEqual(r.reason, "needsFullRescan=true");
  });

  it("fires when the lifetime scan has not completed", () => {
    const r = _needsLifetimeRescan({
      ...settled(),
      lifetimeScanComplete: false,
    });
    assert.strictEqual(r.needed, true);
    assert.strictEqual(r.reason, "lifetimeScanComplete=false");
  });

  it("fires on a short epoch history, and says so", () => {
    /*- The condition this predicate was extracted for. Before the
     *  extraction the reason string was built from the two conditions
     *  above only, so a rescan driven by this one logged them both as
     *  false — an expensive scan with no stated cause. */
    const r = _needsLifetimeRescan({
      ...settled(),
      _epochHistoryIncomplete: true,
    });
    assert.strictEqual(r.needed, true);
    assert.strictEqual(r.reason, "epochHistoryIncomplete=true");
  });

  it("fires when no deposit total has been resolved yet", () => {
    /*- The scan is how that total gets filled in, so a zero is a reason
     *  on its own even with every other condition settled. */
    const r = _needsLifetimeRescan({
      ...settled(),
      totalLifetimeDepositUsd: 0,
    });
    assert.strictEqual(r.needed, true);
    assert.strictEqual(r.reason, "deposit-total=$0");
  });

  it("names every condition that is true, not just the first", () => {
    const r = _needsLifetimeRescan({
      _needsFullRescan: true,
      lifetimeScanComplete: false,
      _epochHistoryIncomplete: true,
      totalLifetimeDepositUsd: 500,
    });
    assert.strictEqual(r.needed, true);
    assert.strictEqual(
      r.reason,
      "needsFullRescan=true lifetimeScanComplete=false epochHistoryIncomplete=true",
    );
  });

  it("lets a specific cause outrank a zero deposit total", () => {
    /*- A position that has never scanned has BOTH a zero total and an
     *  incomplete scan. Reporting the total would name the symptom and
     *  bury the cause. */
    const r = _needsLifetimeRescan({
      _needsFullRescan: false,
      lifetimeScanComplete: false,
      _epochHistoryIncomplete: false,
      totalLifetimeDepositUsd: 0,
    });
    assert.strictEqual(r.reason, "lifetimeScanComplete=false");
    assert.ok(
      !r.reason.includes("deposit-total"),
      "the zero total must not crowd out the real cause",
    );
  });

  it("treats absent flags as settled, not as triggers", () => {
    /*- A freshly built botState carries none of these keys. Reading a
     *  missing flag as "true" would have every position rescanning from
     *  the moment it starts, which is why each test is an explicit
     *  `=== true` / `=== false` rather than a truthiness check. */
    const r = _needsLifetimeRescan({ totalLifetimeDepositUsd: 10 });
    assert.strictEqual(r.needed, false);
    assert.strictEqual(r.reason, "");
  });
});

describe("_countRescan()", () => {
  /*- The number an operator reads to tell a retry that is converging
   *  from one that is looping. Two retries then silence is a recovery;
   *  retry #30 with the same reason each time is a position stuck in a
   *  loop that will not fix itself, and without a count that has to be
   *  established by finding and tallying every line in the log. */

  it("starts at one, not zero", () => {
    /*- The first rescan IS a retry — something already failed or went
     *  unresolved to cause it. Numbering it #0 would read as though it
     *  had not happened yet. */
    assert.strictEqual(_countRescan({}), 1);
  });

  it("climbs by one per rescan", () => {
    const botState = {};
    assert.deepStrictEqual(
      [_countRescan(botState), _countRescan(botState), _countRescan(botState)],
      [1, 2, 3],
    );
    assert.strictEqual(botState._lifetimeRescanCount, 3, "kept on the state");
  });

  it("never resets, so a re-requested rescan still shows as a retry", () => {
    /*- Deliberately not cleared on success. A scan that succeeds and is
     *  immediately asked to run again is precisely the loop worth
     *  seeing, and resetting on success would hide it behind a
     *  permanent "retry #1". */
    const botState = { _lifetimeRescanCount: 12 };
    assert.strictEqual(_countRescan(botState), 13);
  });

  it("counts each position separately", () => {
    /*- The state object is per position, so two pools cannot inflate
     *  each other's count and make a healthy one look stuck. */
    const a = {};
    const b = {};
    _countRescan(a);
    _countRescan(a);
    assert.strictEqual(_countRescan(b), 1, "a fresh position starts over");
    assert.strictEqual(a._lifetimeRescanCount, 2);
  });

  it("recovers from a non-number left on the state", () => {
    /*- Counting from a NaN or a string would produce "retry #NaN" and
     *  then never recover, since every later attempt adds to it. */
    for (const junk of [undefined, null, NaN, "7", {}]) {
      assert.strictEqual(
        _countRescan({ _lifetimeRescanCount: junk }),
        1,
        `a ${String(junk)} count must restart at 1, not poison the tally`,
      );
    }
  });
});
