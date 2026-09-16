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
 * Two independent failures produce it and both are covered here: the wei
 * amount being unknown, and the wei amount being known while the USD
 * price behind it is not. The second is the likelier one in production,
 * because receipt reads are cheap and reliable while price lookups are
 * quota-limited and deliberately pausable.
 *
 * Split from test/epoch-reconstructor.test.js at the 500-line cap. The
 * whole gas story lives here: the guard, the conversion that feeds it,
 * and the retry that makes rejecting an epoch acceptable.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { _buildClosedEpoch } = require("../src/epoch-reconstructor");
const {
  CHAIN_HISTORY_MODULE,
  chainHistoryStub,
} = require("./helpers/chain-history-stub");

describe("_buildClosedEpoch", () => {
  /*- Gas is the third input to `epochPnl` and the last to get the guard.
   *  It runs the opposite way from the fee bug: `epochPnl = exit − entry
   *  + fees − gas`, so an unknown cost subtracted as zero reports MORE
   *  profit than the position made. Every rebalance costs gas, so a
   *  missing value is always "not known" and never "free". */
  describe("unknown gas is not zero", () => {
    /** Everything else known, gas the only variable. */
    const withGas = (gasCostUsd) => ({
      mintDate: "2026-03-15T10:00:00Z",
      closeDate: "2026-03-16T10:00:00Z",
      entryValueUsd: 100,
      exitValueUsd: 95,
      feesEarnedUsd: 2,
      gasCostUsd,
    });

    it("rejects the epoch when gasCostUsd is null", () => {
      assert.strictEqual(_buildClosedEpoch(withGas(null), 0), null);
    });

    it("rejects the epoch when gasCostUsd is undefined", () => {
      assert.strictEqual(_buildClosedEpoch(withGas(undefined), 0), null);
      /*- Absent entirely, which is the shape `_fetchEpochsFromChain`
       *  actually produces: it assigns the field only once it has
       *  resolved a cost, so an unresolved one never appears at all. */
      const h = withGas(0);
      delete h.gasCostUsd;
      assert.strictEqual(_buildClosedEpoch(h, 0), null);
    });

    it("still builds when the gas is a real zero", () => {
      /*- Over-rejecting here would withhold every epoch whose gas
       *  genuinely resolved to nothing, so the guard has to separate
       *  "zero" from "unknown" exactly as the fee guard does. */
      const ep = _buildClosedEpoch(withGas(0), 0);
      assert.ok(ep, "a resolved $0.00 gas cost is data, not a gap");
      assert.strictEqual(ep.gas, 0);
    });

    it("carries the gas through without a zero fallback", () => {
      assert.strictEqual(_buildClosedEpoch(withGas(1.75), 0).gas, 1.75);
    });

    it("subtracts the real gas from epochPnl", () => {
      /*- The number at stake. exit − entry + fees − gas =
       *  95 − 100 + 2 − 1.75. Treating the gas as zero would report -3,
       *  which is $1.75 of profit that was never made. */
      const ep = _buildClosedEpoch(withGas(1.75), 0);
      assert.strictEqual(ep.epochPnl, 95 - 100 + 2 - 1.75);
      assert.notStrictEqual(ep.epochPnl, -3);
    });
  });
});

// ── resolving the gas cost ───────────────────────────────────────────────────

describe("_fetchEpochsFromChain — resolving the gas cost", () => {
  /*- Two independent failures produce a fabricated $0.00 gas, and the
   *  guard in `_buildClosedEpoch` only catches what this function
   *  declines to set. So this is where both have to be turned into "not
   *  known":
   *
   *  1. the wei amount is unknown — `position-history` leaves
   *     `gasCostWei` null when the receipt reads come back empty;
   *  2. the wei amount is known but its USD price is not —
   *     `actualGasCostUsd` answers 0 both when its lookup throws and
   *     when `fetchTokenPriceUsd` returns 0, which is what the idle
   *     pause returns with no cached price.
   *
   *  The second is the likelier one in production: receipt reads are
   *  cheap and reliable, price lookups are quota-limited and pausable. */

  /** Load the module with one history shape and one gas price. */
  function withGas(historyPatch, gasUsd, trace = []) {
    const Module = require("module");
    const orig = Module.prototype.require;
    let inScope = false;
    Module.prototype.require = function (id) {
      if (id === CHAIN_HISTORY_MODULE) return chainHistoryStub();
      if (id === "./bot-pnl-updater")
        return { actualGasCostUsd: async () => gasUsd };
      /*- Stubbed so no unit test reaches the network, and so the trace
       *  can show WHERE the native-price fetch happened relative to the
       *  fresh-prices scope. */
      if (id === "./price-fetcher")
        return {
          fetchTokenPriceUsd: async () => {
            trace.push(inScope ? "price-fetch-in-scope" : "price-fetch-bare");
            return 1;
          },
          withFreshPricesAllowed: async (fn) => {
            inScope = true;
            try {
              return await fn();
            } finally {
              inScope = false;
            }
          },
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
      delete require.cache[require.resolve("../src/epoch-reconstructor")];
      const mod = require("../src/epoch-reconstructor");
      /*- Evicted again so the stubbed copy cannot be handed to whoever
       *  requires this module next. */
      delete require.cache[require.resolve("../src/epoch-reconstructor")];
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

  it("skips it when the price behind a real cost is unknown", async () => {
    /*- Path 2, and the one the epoch guard alone would NOT have caught:
     *  `gasCostWei` is present and positive, so the old truthiness check
     *  converted it happily — into $0.00, which looks like a real
     *  figure and is subtracted as one. */
    const epochs = await run(withGas({ gasCostWei: "5000000000000000" }, 0));
    assert.deepEqual(epochs, [], "a zero USD on a real cost means no price");
  });

  it("builds when the cost genuinely resolves to zero", async () => {
    /*- A zero wei amount needs no price to convert, so it is knowable
     *  even while prices are paused. Rejecting it would withhold the
     *  epoch over a number that is not in doubt. */
    const epochs = await run(withGas({ gasCostWei: "0" }, 0));
    assert.strictEqual(epochs.length, 1);
    assert.strictEqual(epochs[0].gas, 0);
    assert.strictEqual(epochs[0].gasNative, 0);
  });

  it("converts a real cost and records both units", async () => {
    const epochs = await run(withGas({ gasCostWei: "2000000000000000" }, 0.03));
    assert.strictEqual(epochs.length, 1);
    assert.strictEqual(epochs[0].gas, 0.03);
    assert.strictEqual(epochs[0].gasNative, 0.002);
    assert.strictEqual(epochs[0].epochPnl, 95 - 100 + 2 - 0.03);
  });

  it("leaves an NFT rejected for gas out of the resume buffer", async () => {
    /*- What makes rejection acceptable: the NFT stays on the to-do
     *  list, so the rescan re-reads exactly it rather than inheriting
     *  the gap. Same contract as an unknown fee. */
    const buf = new Map();
    await run(withGas({ gasCostWei: "5000000000000000" }, 0), buf);
    assert.strictEqual(buf.size, 0, "a skipped NFT must be re-read");
  });

  it("resolves the native price past the idle pause before converting", async () => {
    /*- Gas is the only epoch figure needing a CURRENT price; exit values
     *  and fees use historical ones carried on the history record.
     *
     *  `bot.js` pauses price lookups at startup unless
     *  `--start-with-price-lookups-unpaused` is passed, and only browser
     *  activity lifts the pause — which a headless run never has. A
     *  paused lookup returns the last cached value, or 0 with nothing
     *  cached. `actualGasCostUsd` reports that 0 as the gas cost, the
     *  guard reads a zero USD on a real wei amount as "price unknown",
     *  and EVERY epoch in the chain is rejected: on headless the P&L
     *  history would never build at all.
     *
     *  So the price must be resolved inside a fresh-prices scope. Once
     *  per reconstruction, not once per NFT — everything after reads it
     *  from cache, which is what keeps the pause doing its job. */
    const trace = [];
    const mod = withGas({ gasCostWei: "2000000000000000" }, 0.03, trace);
    await run(mod);
    assert.deepEqual(
      trace,
      ["price-fetch-in-scope"],
      "the native price must be fetched exactly once, inside the scope",
    );
  });

  it("schedules the retry, through reconstructEpochs itself", async () => {
    /*- Closes the loop on the real entry point rather than trusting the
     *  links to compose: a gas rejection shortens the history, which
     *  raises `_epochHistoryIncomplete`, which is the only thing that
     *  makes the 30-minute timer in src/bot-loop.js try again. Without
     *  that last step a withheld epoch stays withheld until a restart,
     *  and rejecting it would be strictly worse than the $0.00 it
     *  replaced. */
    const mod = withGas({ gasCostWei: "5000000000000000" }, 0);
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
