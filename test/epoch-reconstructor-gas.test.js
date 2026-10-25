/**
 * @file test/epoch-reconstructor-gas.test.js
 * @description The gas cost of a closed epoch, and refusing to invent one.
 *
 * `epochPnl = exit − entry + fees − gas`, so an unknown gas cost
 * subtracted as zero reports MORE profit than the position made. That is
 * the same class of defect as the `feesEarnedUsd` one covered in
 * test/epoch-reconstructor.test.js, running in the opposite direction —
 * the fee bug understated, this one flatters.
 *
 * Two different unknowns are covered here, and they are handled apart.
 * An unknown amount of gas withholds the epoch, and the rescan reads the
 * NFT again. A known amount whose day has no native price builds the
 * epoch with no dollar figure for its gas and no net figure, which the
 * Per-Day table shows as dashes; it is never priced at today's market.
 *
 * Split from test/epoch-reconstructor.test.js at the 500-line cap. The
 * whole gas story lives here: the guard, the conversion that feeds it,
 * and the retry that makes withholding an epoch acceptable.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { _buildClosedEpoch } = require("../src/lib/epoch-reconstructor");
const {
  CHAIN_HISTORY_MODULE,
  chainHistoryStub,
} = require("./helpers/chain-history-stub");

describe("_buildClosedEpoch", () => {
  /*- Gas is the third input to `epochPnl` and the last to get the guard.
   *  It runs the opposite way from the fee bug: `epochPnl = exit − entry
   *  + fees − gas`, so an unknown cost subtracted as zero reports MORE
   *  profit than the position made. Every rebalance costs gas, so a
   *  missing amount is always "not known" and never "free". */
  describe("unknown gas is not zero", () => {
    /** Everything else known, gas the only variable. */
    const withGas = (gasNative, gasCostUsd) => ({
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: "2026-03-16T10:00:00Z",
      entryValueUsd: 100,
      exitValueUsd: 95,
      feesEarnedUsd: 2,
      gasNative,
      gasCostUsd,
    });

    it("rejects the epoch when the amount of gas is not known", () => {
      assert.strictEqual(_buildClosedEpoch(withGas(null, null), 0), null);
      assert.strictEqual(_buildClosedEpoch(withGas(undefined, 1), 0), null);
      /*- Absent entirely, which is the shape `_fetchEpochsFromChain`
       *  actually produces: it assigns the fields only once it has read
       *  the amount, so an unread one never appears at all. */
      const h = withGas(0, 0);
      delete h.gasNative;
      delete h.gasCostUsd;
      assert.strictEqual(_buildClosedEpoch(h, 0), null);
    });

    it("builds with no gas or net figure when the amount has no price", () => {
      const ep = _buildClosedEpoch(withGas(0.002, null), 0);
      assert.ok(ep, "a known amount with no price is a dash, not a gap");
      assert.strictEqual(ep.gas, null);
      assert.strictEqual(ep.epochPnl, null);
      assert.strictEqual(ep.gasNative, 0.002);
    });

    it("still builds when the gas is a real zero", () => {
      /*- Over-rejecting here would withhold every epoch whose gas
       *  genuinely resolved to nothing, so the guard has to separate
       *  "zero" from "unknown" exactly as the fee guard does. */
      const ep = _buildClosedEpoch(withGas(0, 0), 0);
      assert.ok(ep, "a resolved $0.00 gas cost is data, not a gap");
      assert.strictEqual(ep.gas, 0);
    });

    it("carries the gas through without a zero fallback", () => {
      assert.strictEqual(_buildClosedEpoch(withGas(0.002, 1.75), 0).gas, 1.75);
    });

    it("subtracts the real gas from epochPnl", () => {
      /*- The number at stake. exit − entry + fees − gas =
       *  95 − 100 + 2 − 1.75. Treating the gas as zero would report -3,
       *  which is $1.75 of profit that was never made. */
      const ep = _buildClosedEpoch(withGas(0.002, 1.75), 0);
      assert.strictEqual(ep.epochPnl, 95 - 100 + 2 - 1.75);
      assert.notStrictEqual(ep.epochPnl, -3);
    });
  });
});

// ── resolving the gas cost ───────────────────────────────────────────────────

describe("_fetchEpochsFromChain — resolving the gas cost", () => {
  /*-
   *  The guard in `_buildClosedEpoch` only catches what this function
   *  declines to set, so this is where the two unknowns are told apart:
   *
   *  1. the wei amount is unknown — `position-history` leaves
   *     `gasCostWei` null when the receipt reads come back empty — and
   *     the epoch is withheld;
   *  2. the wei amount is known but the native price on its close day
   *     is not — `pastGasCostUsd` answers null — and the epoch builds
   *     with no dollar figure for its gas.
   */

  /**
   * Load the module with one history shape and one answer for the gas
   * price of its close day.
   */
  function withGas(historyPatch, gasUsd, trace = [], seen = null) {
    const Module = require("module");
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === CHAIN_HISTORY_MODULE) return chainHistoryStub();
      if (id === "./bot-pnl-updater")
        return {
          /*-
           *  Both arguments are recorded, not just the first, so a
           *  dropped close moment shows.
           */
          pastGasCostUsd: async (wei, when) => {
            if (seen) seen.push({ wei, when });
            return gasUsd;
          },
        };
      /*- Stubbed so no unit test reaches the network, and so the trace
       *  shows any lookup of today's price. */
      if (id === "./price-fetcher")
        return {
          fetchTokenPriceUsd: async () => {
            trace.push("price-fetch");
            return 1;
          },
          withFreshPricesAllowed: async (fn) => fn(),
        };
      if (id !== "./position-history") return orig.apply(this, arguments);
      return {
        getPositionHistory: async () => ({
          mintDate: "2026-03-15T10:00:00Z",
          closeDate: "2026-03-16T10:00:00Z",
          entryValueUsd: 100,
          exitValueUsd: 95,
          feesEarnedUsd: 2,
          ...historyPatch,
        }),
      };
    };
    try {
      delete require.cache[require.resolve("../src/lib/epoch-reconstructor")];
      const mod = require("../src/lib/epoch-reconstructor");
      /*- Evicted again so the stubbed copy cannot be handed to whoever
       *  requires this module next. */
      delete require.cache[require.resolve("../src/lib/epoch-reconstructor")];
      return mod;
    } finally {
      Module.prototype.require = orig;
    }
  }

  const run = (mod, buf) =>
    mod._fetchEpochsFromChain(["500"], [], null, null, null, buf);

  it("skips the epoch when the wei amount is unknown", async () => {
    const epochs = await run(withGas({ gasCostWei: null }, 0.02));
    assert.deepEqual(epochs, [], "an unreadable gas cost is not $0.00");
  });

  it("skips it when the field is absent entirely", async () => {
    const epochs = await run(withGas({}, 0.02));
    assert.deepEqual(epochs, []);
  });

  it("builds with no gas figure when its day has no native price", async () => {
    /*-
     *  The amount is known, so the period belongs in the table; only its
     *  dollar figure is not, and the Per-Day row shows a dash for it.
     */
    const epochs = await run(withGas({ gasCostWei: "5000000000000000" }, null));
    assert.strictEqual(epochs.length, 1);
    assert.strictEqual(epochs[0].gas, null, "no dollar figure, not $0.00");
    assert.strictEqual(epochs[0].epochPnl, null);
    assert.strictEqual(epochs[0].gasNative, 0.005);
  });

  it("builds when the cost genuinely resolves to zero", async () => {
    /*- A zero wei amount needs no price to convert, so it is knowable
     *  whatever the price lookups answer. */
    const seen = [];
    const epochs = await run(withGas({ gasCostWei: "0" }, null, [], seen));
    assert.strictEqual(epochs.length, 1);
    assert.strictEqual(epochs[0].gas, 0);
    assert.strictEqual(epochs[0].gasNative, 0);
    assert.strictEqual(seen.length, 0, "nothing to price");
  });

  it("converts a real cost and records both units", async () => {
    const epochs = await run(withGas({ gasCostWei: "2000000000000000" }, 0.03));
    assert.strictEqual(epochs.length, 1);
    assert.strictEqual(epochs[0].gas, 0.03);
    assert.strictEqual(epochs[0].gasNative, 0.002);
    assert.strictEqual(epochs[0].epochPnl, 95 - 100 + 2 - 0.03);
  });

  it("prices the gas at the moment the epoch closed", async () => {
    /*-
     *  Gas charged to an epoch is the rebalance that closed it, so it is
     *  valued then rather than at today's market.
     */
    const seen = [];
    await run(
      withGas(
        { gasCostWei: "2000000000000000", closeBlockNumber: 27_123_456 },
        0.03,
        [],
        seen,
      ),
    );
    assert.strictEqual(seen.length, 1, "gas should be converted once");
    const { when } = seen[0];
    assert.ok(when, "a close moment must be handed to the converter");
    assert.strictEqual(
      when.timestamp,
      Math.floor(Date.parse("2026-03-16T10:00:00Z") / 1000),
      "timestamp must be the close, in seconds",
    );
    assert.strictEqual(
      when.blockNumber,
      27_123_456,
      "the close block lets the exact-to-the-moment source answer",
    );
  });

  it("leaves the gas with no dollar figure when its close is unknown", async () => {
    /*-
     *  With no close date there is no day to price at, so there is no
     *  figure: the period still builds, and its gas shows a dash.
     */
    const seen = [];
    const epochs = await run(
      withGas(
        { gasCostWei: "2000000000000000", closeDate: null },
        0.03,
        [],
        seen,
      ),
    );
    assert.strictEqual(seen.length, 0, "no moment, so nothing to ask");
    assert.strictEqual(epochs.length, 1);
    assert.strictEqual(epochs[0].gas, null);
  });

  it("never prices a past period's gas at today's price", async () => {
    const trace = [];
    await run(withGas({ gasCostWei: "2000000000000000" }, null, trace));
    assert.deepEqual(trace, [], "today's price is not a past day's");
  });

  it("leaves an NFT with an unread gas amount out of the resume buffer", async () => {
    /*-
     *  What makes withholding acceptable: the NFT stays on the to-do
     *  list, so the rescan re-reads exactly it rather than inheriting
     *  the gap. Same contract as an unknown fee.
     */
    const buf = new Map();
    await run(withGas({ gasCostWei: null }, 0.02), buf);
    assert.strictEqual(buf.size, 0, "a skipped NFT must be re-read");
  });

  it("schedules the retry, through reconstructEpochs itself", async () => {
    /*- Closes the loop on the real entry point rather than trusting the
     *  links to compose: an unread gas amount shortens the history,
     *  which raises `_epochHistoryIncomplete`, which is the only thing
     *  that makes the 30-minute timer in src/lib/bot-loop.js try again.
     *  Without that last step a withheld epoch stays withheld until a
     *  restart. */
    const mod = withGas({ gasCostWei: null }, 0.02);
    const botState = { activePosition: null };
    const n = await mod.reconstructEpochs({
      pnlTracker: {
        serialize: () => ({ closedEpochs: [], liveEpoch: null }),
        restore: () => {},
      },
      rebalanceEvents: [{ oldTokenId: "500", newTokenId: "501" }],
      botState,
      updateBotState: () => {},
    });
    assert.strictEqual(n, 0, "the epoch must be withheld, not admitted");
    assert.strictEqual(
      botState._epochHistoryIncomplete,
      true,
      "a withheld epoch that is never retried is worse than a wrong one",
    );
  });
});
