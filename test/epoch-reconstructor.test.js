/**
 * @file test/epoch-reconstructor.test.js
 * @description Unit tests for the epoch-reconstructor module.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { format } = require("node:util");
const { _setSinkForTests } = require("../src/log");
const {
  _buildClosedEpoch,
  isEpochHistoryComplete,
  reconstructEpochs,
} = require("../src/epoch-reconstructor");

/**
 * Capture `log.warn` output as formatted strings.
 *
 * Through the module's own test sink rather than by replacing `console`
 * — see [[feedback_no_global_monkey_patch]].  The sink receives the
 * printf format string and its arguments unexpanded, so `format` is
 * what turns "%d of %d" into the line an operator actually reads, which
 * is the thing worth asserting.
 *
 * @returns {{lines: string[], restore: Function}}
 */
function captureWarnings() {
  const lines = [];
  const restore = _setSinkForTests({
    warn: (...a) => lines.push(format(...a)),
  });
  return { lines, restore };
}

describe("_buildClosedEpoch", () => {
  it("returns null when no dates available", () => {
    assert.strictEqual(
      _buildClosedEpoch({ mintDate: null, closeDate: null }, 0),
      null,
    );
  });

  it("builds epoch from position history data", () => {
    const h = {
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: "2026-03-17T14:00:00Z",
      entryValueUsd: 300,
      exitValueUsd: 295,
      feesEarnedUsd: 0.5,
      gasCostUsd: 0.02,
      token0UsdPriceAtOpen: 0.0016,
      token1UsdPriceAtOpen: 0.0006,
      token0UsdPriceAtClose: 0.0017,
      token1UsdPriceAtClose: 0.00059,
    };
    const ep = _buildClosedEpoch(h, 0);
    assert.strictEqual(ep.status, "closed");
    assert.strictEqual(ep.entryValue, 300);
    assert.strictEqual(ep.exitValue, 295);
    assert.strictEqual(ep.fees, 0.5);
    assert.strictEqual(ep.feePnl, 0.5);
    assert.strictEqual(ep.priceChangePnl, 295 - 300 - 0.5);
    assert.strictEqual(ep.openTime, new Date("2026-03-15T10:00:00Z").getTime());
    assert.strictEqual(
      ep.closeTime,
      new Date("2026-03-17T14:00:00Z").getTime(),
    );
    assert.strictEqual(ep.id, 1);
    assert.strictEqual(ep.color, "#00e5ff");
  });

  it("uses openTime as closeTime fallback when closeDate is null", () => {
    const h = {
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: null,
      entryValueUsd: 100,
      exitValueUsd: 0,
      feesEarnedUsd: 0,
      gasCostUsd: 0,
    };
    const ep = _buildClosedEpoch(h, 0);
    assert.ok(ep);
    assert.strictEqual(ep.closeTime, ep.openTime);
  });

  it("returns null when exitValueUsd is missing", () => {
    const h = {
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: "2026-03-16T10:00:00Z",
      entryValueUsd: 293.99,
      exitValueUsd: null,
      feesEarnedUsd: null,
    };
    assert.strictEqual(_buildClosedEpoch(h, 2), null);
  });

  /*- A shape the test above does NOT cover: it rejects on the exit
   *  value, so the fee being null there is incidental.
   *
   *  An RPC outage produces exactly this one — the exit value survives
   *  from the rebalance log while the chain scan that supplies fees
   *  returns nothing. A zero fallback then writes a fee figure that
   *  reads exactly like a measured one, and the epoch understates the
   *  position for as long as it stands. */
  describe("unknown fees are not zero", () => {
    /** Exit value known, fees not — an outage mid-reconstruction. */
    const withFees = (feesEarnedUsd) => ({
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: "2026-03-16T10:00:00Z",
      entryValueUsd: 293.99,
      exitValueUsd: 290.12,
      feesEarnedUsd,
      /*- Present so these cases turn on the fee alone. Gas carries its
       *  own guard, covered in test/epoch-reconstructor-gas.test.js. */
      gasCostUsd: 0.02,
    });

    it("rejects the epoch when feesEarnedUsd is null", () => {
      assert.strictEqual(_buildClosedEpoch(withFees(null), 0), null);
    });

    it("rejects the epoch when feesEarnedUsd is undefined", () => {
      assert.strictEqual(_buildClosedEpoch(withFees(undefined), 0), null);
      /*- Absent entirely, not merely set to undefined. */
      const h = withFees(0);
      delete h.feesEarnedUsd;
      assert.strictEqual(_buildClosedEpoch(h, 0), null);
    });

    it("still builds when the fees are a real zero", () => {
      /*- Over-rejecting would drop every dust NFT that genuinely earned
       *  nothing, so the guard has to separate "zero" from "unknown". */
      const ep = _buildClosedEpoch(withFees(0), 0);
      assert.ok(ep, "a genuine $0.00 fee is data, not a gap");
      assert.strictEqual(ep.fees, 0);
    });

    it("carries the fee through without a zero fallback", () => {
      assert.strictEqual(_buildClosedEpoch(withFees(3.3), 0).fees, 3.3);
    });
  });

  it("assigns correct colour per index", () => {
    const h = {
      mintDate: "2026-01-01T00:00:00Z",
      closeDate: "2026-01-02T00:00:00Z",
      entryValueUsd: 100,
      exitValueUsd: 100,
      feesEarnedUsd: 1,
      gasCostUsd: 0.02,
    };
    assert.strictEqual(_buildClosedEpoch(h, 0).color, "#00e5ff");
    assert.strictEqual(_buildClosedEpoch(h, 1).color, "#ff6b35");
    assert.strictEqual(_buildClosedEpoch(h, 10).color, "#00e5ff"); // wraps
  });

  it("computes epochPnl correctly", () => {
    const h = {
      mintDate: "2026-01-01T00:00:00Z",
      closeDate: "2026-01-02T00:00:00Z",
      entryValueUsd: 200,
      exitValueUsd: 190,
      feesEarnedUsd: 3,
      gasCostUsd: 2,
    };
    const ep = _buildClosedEpoch(h, 0);
    // epochPnl = (exit - entry) + fees - gas = (190 - 200) + 3 - 2 = -9
    assert.strictEqual(ep.epochPnl, -9);
    // priceChangePnl = exit - entry - fees = 190 - 200 - 3 = -13
    assert.strictEqual(ep.priceChangePnl, -13);
    /*- Gas is subtracted, and at its real value. Treating an unknown as
     *  zero would report -7 — two dollars of profit the position never
     *  made. */
    assert.strictEqual(ep.gas, 2);
  });
});

describe("epoch-cache round-trip", () => {
  const { getCachedEpochs, setCachedEpochs } = require("../src/epoch-cache");
  const key = {
    blockchain: "test",
    contract: "0xPM",
    wallet: "0xW",
    token0: "0xA",
    token1: "0xB",
    fee: 3000,
  };
  it("stores and retrieves tracker state", () => {
    const data = { closedEpochs: [{ e: 1 }], liveEpoch: null };
    setCachedEpochs(key, data);
    const got = getCachedEpochs(key);
    assert.deepStrictEqual(got.closedEpochs, [{ e: 1 }]);
  });
  it("normalizes plain array to full state", () => {
    setCachedEpochs(key, [{ e: 2 }]);
    const got = getCachedEpochs(key);
    assert.deepStrictEqual(got.closedEpochs, [{ e: 2 }]);
    assert.strictEqual(got.liveEpoch, null);
  });
});

describe("isEpochHistoryComplete", () => {
  /*- The guard that decides whether reconstruction runs at all.  It used
   *  to ask "do we have ANY closed epochs?", which treated a partial
   *  history as a finished one.  The position it broke was the only pool
   *  the bot had rebalanced itself: eight epochs closed live during that
   *  window, so reconstruction returned at the first line and the 124
   *  rebalances either side of it never got an epoch — leaving the
   *  Per-Day P&L table blank on every day but one. */
  const ids = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

  it("is false when the history covers only part of the chain", () => {
    assert.strictEqual(isEpochHistoryComplete(new Array(8), ids(132)), false);
  });

  it("is false for a single live-recorded epoch on a long chain", () => {
    /*- The hardest shape to get right: one rebalance by this bot on a
     *  position with a long prior history, so the epoch count is
     *  plausible while the chain is almost entirely unreconstructed. */
    assert.strictEqual(isEpochHistoryComplete(new Array(1), ids(40)), false);
  });

  it("is true once every closed position has an epoch", () => {
    assert.strictEqual(isEpochHistoryComplete(new Array(37), ids(37)), true);
  });

  it("is true when the history runs ahead of the chain", () => {
    /*- A live close lands before the event scanner catches up.  Treat
     *  that as complete rather than rebuilding on every poll. */
    assert.strictEqual(isEpochHistoryComplete(new Array(38), ids(37)), true);
  });

  it("is false when there is no history at all", () => {
    assert.strictEqual(isEpochHistoryComplete([], ids(3)), false);
    assert.strictEqual(isEpochHistoryComplete(undefined, ids(3)), false);
  });
});

describe("reconstructEpochs — when it decides to run", () => {
  /*- Drives the real function.  Every collaborator that would touch the
   *  chain is absent, so a run that gets past the guard fails loudly
   *  rather than silently reaching for RPC. */
  const events = (n) =>
    Array.from({ length: n }, (_, i) => ({
      oldTokenId: String(1000 + i),
      newTokenId: String(1001 + i),
    }));

  const tracker = (closedCount) => ({
    serialize: () => ({
      closedEpochs: new Array(closedCount).fill({}),
      liveEpoch: null,
    }),
    restore: () => {},
  });

  it("skips when the history already covers the chain", async () => {
    const n = await reconstructEpochs({
      pnlTracker: tracker(5),
      rebalanceEvents: events(5),
      botState: {},
    });
    assert.strictEqual(n, 0);
  });

  it("does NOT skip a partial history — the regression", async () => {
    /*- Eight epochs against a 132-rebalance chain.  Before the fix this
     *  returned 0 immediately.  It must now get past the guard; with no
     *  position metadata it can build no cache key and no epochs, so it
     *  still returns 0 — the distinction is that it TRIED, which the
     *  progress callback records. */
    let reached = false;
    await reconstructEpochs({
      pnlTracker: tracker(8),
      rebalanceEvents: events(132),
      botState: { activePosition: null },
      updateBotState: () => {
        reached = true;
      },
    });
    assert.ok(
      reached,
      "reconstruction did not get past the completeness guard",
    );
  });

  it("still skips when the chain closed nothing", async () => {
    const n = await reconstructEpochs({
      pnlTracker: tracker(0),
      rebalanceEvents: [{ oldTokenId: "?", newTokenId: "2" }],
      botState: {},
    });
    assert.strictEqual(n, 0);
  });
});

// ── per-NFT resume buffer ────────────────────────────────────────────────────

describe("_fetchEpochsFromChain resume buffer", () => {
  /*- Every per-NFT failure in this loop is caught and skipped, so the
   *  pass always finishes. Without somewhere outside the loop to keep
   *  the NFTs already read, finishing discards them, and the next
   *  attempt starts at the first NFT again — hours of re-reading per
   *  attempt on a 132-NFT chain.
   *
   *  A closed NFT is inert: drained, never returned to, so its history
   *  cannot change between attempts. Reuse is exact rather than a cache
   *  with a staleness window — which is why this buffer needs no floor
   *  check, unlike the one in bot-recorder-scan-helpers.js. */

  const IDS = ["200", "201", "202", "203"];

  /**
   * Load the module with `getPositionHistory` and the gas converter
   * stubbed.
   *
   * @param {string|null} failOn  tokenId to throw for, once.
   * @param {number} [gasUsd]     What the gas converter answers. Zero
   *   stands for a failed or paused price lookup, which the real
   *   `actualGasCostUsd` also reports as 0.
   */
  function withStubbedHistory(failOn, gasUsd = 0.02) {
    const Module = require("module");
    const orig = Module.prototype.require;
    const seen = [];
    let failed = false;
    Module.prototype.require = function (id) {
      /*- The gas converter is stubbed alongside the history because the
       *  real one calls `fetchTokenPriceUsd`, which would put network
       *  I/O in a unit test — and because a zero USD is now meaningful
       *  (it says the price was unknown), so the tests need to set it
       *  deliberately rather than inherit whatever a price lookup did. */
      if (id === "./bot-pnl-updater")
        return { actualGasCostUsd: async () => gasUsd };
      if (id !== "./position-history") return orig.apply(this, arguments);
      return {
        getPositionHistory: async (tid) => {
          seen.push(String(tid));
          if (String(tid) === failOn && !failed) {
            failed = true;
            throw new Error("simulated RPC outage");
          }
          const h = {
            mintDate: "2026-03-15T10:00:00Z",
            closeDate: "2026-03-16T10:00:00Z",
            entryValueUsd: 100,
            exitValueUsd: 95,
            feesEarnedUsd: 1,
            gasCostWei: "1000000000000000",
          };
          /*- #202 stands for the outage shape that started all this:
           *  the exit value survives while the fee read does not. */
          return String(tid) === "202" ? { ...h, feesEarnedUsd: null } : h;
        },
      };
    };
    try {
      delete require.cache[require.resolve("../src/epoch-reconstructor")];
      const mod = require("../src/epoch-reconstructor");
      /*- Evict again: the copy just built holds the stubbed
       *  `getPositionHistory`, and leaving it cached would hand it to
       *  whoever requires this module next. The returned reference stays
       *  valid — only the cache entry goes. */
      delete require.cache[require.resolve("../src/epoch-reconstructor")];
      return { fetch: mod._fetchEpochsFromChain, seen };
    } finally {
      Module.prototype.require = orig;
    }
  }

  it("leaves a failed read and an unknown fee out of the buffer", async () => {
    const { fetch, seen } = withStubbedHistory("203");
    const buf = new Map();
    await fetch(IDS, [], null, null, null, buf);
    assert.deepEqual(seen, IDS);
    assert.deepEqual(
      [...buf.keys()],
      ["200", "201"],
      "an NFT whose epoch did not build must stay on the to-do list",
    );
  });

  it("re-reads only the gaps on the next attempt", async () => {
    const { fetch, seen } = withStubbedHistory("203");
    const buf = new Map();
    await fetch(IDS, [], null, null, null, buf);
    seen.length = 0;
    const epochs = await fetch(IDS, [], null, null, null, buf);
    assert.deepEqual(seen, ["202", "203"]);
    /*- Indices are assigned from the array being built, so reusing
     *  buffered reads must not leave holes in the numbering. */
    assert.deepEqual(
      epochs.map((e) => e.id),
      [1, 2, 3],
    );
  });

  it("leaves no stubbed module behind in the require cache", () => {
    /*- The helper re-requires the module with a faked
     *  `getPositionHistory`. Leaving that copy cached would hand the
     *  stub to whoever requires this module next, and a suite that
     *  passes against a stub reports nothing about the real code. */
    withStubbedHistory(null);
    assert.strictEqual(
      require.cache[require.resolve("../src/epoch-reconstructor")],
      undefined,
      "a stubbed epoch-reconstructor is still cached",
    );
  });

  it("reads everything when no buffer is supplied", async () => {
    const { fetch, seen } = withStubbedHistory(null);
    await fetch(IDS, [], null, null, null);
    seen.length = 0;
    await fetch(IDS, [], null, null, null);
    assert.deepEqual(seen, IDS);
  });

  /*- The warning pair. A short result is the NORMAL shape of a failed
   *  reconstruction, not an exception: every per-NFT failure is caught
   *  and skipped, so the loop always finishes and "Reconstructed 90"
   *  reads exactly like "Reconstructed 132". These two lines are the
   *  only place the difference is stated, and the burn-in procedure in
   *  docs greps for them — so their content is part of the contract,
   *  not incidental output. */

  it("warns with both counts when the result is short", async () => {
    const { fetch } = withStubbedHistory("203");
    const { lines, restore } = captureWarnings();
    try {
      await fetch(IDS, [], null, null, null, new Map());
    } finally {
      restore();
    }
    const incomplete = lines.find((l) =>
      l.includes("Reconstruction incomplete"),
    );
    assert.ok(incomplete, "a short result must warn");
    /*- Two of four build: #202's fee is unknown and #203 throws. */
    assert.match(incomplete, /2 of 4 epochs built/);
    assert.match(incomplete, /2 NFT\(s\) could not be read/);
    assert.ok(
      incomplete.includes("understate"),
      "the line must say the figures are wrong, not merely that a count differs",
    );
  });

  it("follows it with what the operator should do", async () => {
    /*- Separate line, deliberately: the first says what happened, this
     *  says whether the app will fix it by itself. An operator reading
     *  the first alone cannot tell, and the wrong guess — restarting —
     *  discards the buffer and starts the chain over. */
    const { fetch } = withStubbedHistory("203");
    const { lines, restore } = captureWarnings();
    try {
      await fetch(IDS, [], null, null, null, new Map());
    } finally {
      restore();
    }
    const advice = lines.find((l) => l.includes("Recommended:"));
    assert.ok(advice, "the shortfall warning must carry an action");
    assert.ok(
      advice.includes("leave it running"),
      "the action must be stated, not implied",
    );
    assert.ok(
      advice.includes("Restarting discards them"),
      "it must warn against the tempting wrong move",
    );
    assert.match(advice, /only the 2 missing NFT\(s\)/);
  });

  it("stays silent when every epoch builds", async () => {
    /*- Fires on the count, not on whether anything failed. A warning on
     *  a complete pass would train the operator to ignore it. */
    const { fetch } = withStubbedHistory(null);
    const { lines, restore } = captureWarnings();
    try {
      /*- #202 carries the unknown fee unconditionally, so a complete
       *  pass needs the ids that do build. */
      await fetch(["200", "201"], [], null, null, null, new Map());
    } finally {
      restore();
    }
    assert.deepEqual(lines, [], "a complete reconstruction must not warn");
  });
});

// ── the rescan flag ──────────────────────────────────────────────────────────

describe("reconstructEpochs — the rescan flag", () => {
  /*- `_epochHistoryIncomplete` is the only thing that makes the
   *  30-minute rescan timer in src/bot-loop.js fire for a short epoch
   *  history; its other three conditions all describe the LIFETIME
   *  scan. So the flag has to be lowered on EVERY path that settles a
   *  complete history, not only on the rebuild at the end.
   *
   *  Four paths settle it without rebuilding: the tracker is already
   *  complete, the cache is, or there is nothing to reconstruct at all
   *  (no events, or none of them closed a position). A flag left raised
   *  at any of them turns a single recovery into a full pool and
   *  lifetime scan every 30 minutes for the rest of the process's life.
   *
   *  These drive the real `reconstructEpochs`. Nothing here reaches the
   *  chain: the early-return cases never get that far, and the partial
   *  case has no position metadata, so each per-NFT fetch fails inside
   *  the loop's own try/catch. */

  const { _cacheKeyFromState } = require("../src/epoch-reconstructor");
  const { setCachedEpochs } = require("../src/epoch-cache");

  const events = (n) =>
    Array.from({ length: n }, (_, i) => ({
      oldTokenId: String(2000 + i),
      newTokenId: String(2001 + i),
    }));

  const tracker = (closedCount) => ({
    serialize: () => ({
      closedEpochs: new Array(closedCount).fill({}),
      liveEpoch: null,
    }),
    restore: () => {},
  });

  it("raises the flag when the rebuild comes up short", async () => {
    const botState = { activePosition: null };
    await reconstructEpochs({
      pnlTracker: tracker(0),
      rebalanceEvents: events(4),
      botState,
      updateBotState: () => {},
    });
    assert.strictEqual(botState._epochHistoryIncomplete, true);
  });

  it("lowers it when the tracker is already complete", async () => {
    /*- The regression: this path returns before the rebuild, so it
     *  never reached the assignment. A history filled in by a live
     *  epoch close arrives here. */
    const botState = { activePosition: null, _epochHistoryIncomplete: true };
    const n = await reconstructEpochs({
      pnlTracker: tracker(4),
      rebalanceEvents: events(4),
      botState,
      updateBotState: () => {},
    });
    assert.strictEqual(n, 0, "it must take the early return");
    assert.strictEqual(
      botState._epochHistoryIncomplete,
      false,
      "a raised flag here retries every 30 minutes forever",
    );
  });

  it("lowers it on the cache fast-restart path", async () => {
    /*- The second early return, and the one a restart takes. */
    const botState = {
      activePosition: { token0: "0xA", token1: "0xB", fee: 2500 },
      walletAddress: "0xFlagTest",
      _epochHistoryIncomplete: true,
    };
    const key = _cacheKeyFromState(botState);
    assert.ok(key, "the fixture must produce a cache key");
    setCachedEpochs(key, {
      closedEpochs: new Array(4).fill({ id: 1 }),
      liveEpoch: null,
    });
    const n = await reconstructEpochs({
      pnlTracker: tracker(0),
      rebalanceEvents: events(4),
      botState,
      updateBotState: () => {},
    });
    assert.strictEqual(n, 4, "it must restore from cache, not rebuild");
    assert.strictEqual(botState._epochHistoryIncomplete, false);
  });

  /*- Nothing to reconstruct is a COMPLETE history, not a short one: an
   *  empty yardstick is one nothing can fall short of. The flag can
   *  already be standing from an earlier pass when these are reached —
   *  a cleared event cache rescanning to a smaller set lands on both —
   *  so leaving it alone would keep retrying a condition that is gone. */

  it("lowers it when no events reach the reconstructor", async () => {
    const botState = { activePosition: null, _epochHistoryIncomplete: true };
    const n = await reconstructEpochs({
      pnlTracker: tracker(0),
      rebalanceEvents: [],
      botState,
      updateBotState: () => {},
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(botState._epochHistoryIncomplete, false);
  });

  it("lowers it when no event closed a position", async () => {
    /*- Events exist but none pair an old id to a new one, so the chain
     *  has no closed NFT to build an epoch from. */
    const botState = { activePosition: null, _epochHistoryIncomplete: true };
    const n = await reconstructEpochs({
      pnlTracker: tracker(0),
      rebalanceEvents: [{ newTokenId: "3000" }, { oldTokenId: "?" }],
      botState,
      updateBotState: () => {},
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(botState._epochHistoryIncomplete, false);
  });

  it("does not require a botState on the nothing-to-do paths", async () => {
    /*- position-details.js reconstructs for a view with its own
     *  throwaway state, and a caller asking only for the number has no
     *  state to keep. Neither may be made to throw by the flag. */
    await assert.doesNotReject(() =>
      reconstructEpochs({
        pnlTracker: tracker(0),
        rebalanceEvents: [],
        updateBotState: () => {},
      }),
    );
  });
});

// ── Reload discards the buffer ───────────────────────────────────────────────

describe("reconstructEpochs — a forced rebuild starts from nothing", () => {
  /*- Reload Current Position exists to re-read this chain from the
   *  chain. Answering it out of the resume buffer would hand back the
   *  very data the operator asked to replace, and Reload would appear
   *  to do nothing — the same failure `_consumeRebuildRequest` avoids
   *  by emptying the tracker. */

  const events = (n) =>
    Array.from({ length: n }, (_, i) => ({
      oldTokenId: String(3000 + i),
      newTokenId: String(3001 + i),
    }));

  const tracker = () => ({
    serialize: () => ({ closedEpochs: [], liveEpoch: null }),
    restore: () => {},
  });

  it("drops a populated buffer when a rebuild is requested", async () => {
    const stale = new Map([["3000", { mintDate: "2026-01-01T00:00:00Z" }]]);
    const botState = {
      activePosition: null,
      _needsEpochRebuild: true,
      _epochResumeBuffer: stale,
    };
    await reconstructEpochs({
      pnlTracker: tracker(),
      rebalanceEvents: events(2),
      botState,
      updateBotState: () => {},
    });
    assert.notStrictEqual(
      botState._epochResumeBuffer,
      stale,
      "the forced rebuild reused the buffer it was meant to replace",
    );
    assert.strictEqual(
      botState._epochResumeBuffer instanceof Map &&
        botState._epochResumeBuffer.has("3000"),
      false,
      "the stale entry survived a forced rebuild",
    );
  });

  it("keeps the buffer across an ordinary retry", async () => {
    /*- The counterpart: without a rebuild request the buffer is what
     *  makes a retry cheap, so it must survive. */
    const carried = new Map([["3000", { mintDate: "2026-01-01T00:00:00Z" }]]);
    const botState = { activePosition: null, _epochResumeBuffer: carried };
    await reconstructEpochs({
      pnlTracker: tracker(),
      rebalanceEvents: events(2),
      botState,
      updateBotState: () => {},
    });
    assert.strictEqual(botState._epochResumeBuffer, carried);
  });
});
