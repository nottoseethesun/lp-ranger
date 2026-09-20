/**
 * @file test/dashboard-kpi-fees.test.js
 * @description The Current panel shows Fees Earned and Fees Compounded
 *   as separate rows and sums them into Profit, so the two must not
 *   overlap.
 *
 *   `liveEpoch.fees` overlaps: `pnl-tracker.js` builds it as
 *   `feesAccrued + compoundedAccrued`. Rendering that as "Fees Earned"
 *   and then adding Fees Compounded counts the compounded portion twice
 *   — on a real position that was $40.76 of the $79.78 Profit shown.
 */

"use strict";

require("global-jsdom/register");
const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

describe("currentUnclaimedFees", () => {
  let currentUnclaimedFees;

  before(async () => {
    ({ currentUnclaimedFees } =
      await import("../public/dashboard-data-kpi-fees.js"));
  });

  it("reports the unclaimed figure the bot published", () => {
    const d = {
      pnlSnapshot: { currentFeesUsd: 0.27, liveEpoch: { fees: 41.03 } },
    };
    assert.equal(currentUnclaimedFees(d, 40.76), 0.27);
  });

  it("does not return the epoch figure, which carries compounded fees", () => {
    /*- The whole defect in one assertion: 41.03 is 0.27 unclaimed plus
     *  40.76 already swept back in, and returning it would let Profit add
     *  the 40.76 a second time. */
    const d = {
      pnlSnapshot: { currentFeesUsd: 0.27, liveEpoch: { fees: 41.03 } },
    };
    assert.notEqual(currentUnclaimedFees(d, 40.76), 41.03);
  });

  it("backs the compounded part out when the direct figure is missing", () => {
    /*- The fallback must not reintroduce what it exists to avoid. The two
     *  differ by exactly the compounded amount, by construction. */
    const d = { pnlSnapshot: { liveEpoch: { fees: 41.03 } } };
    assert.equal(Number(currentUnclaimedFees(d, 40.76).toFixed(2)), 0.27);
  });

  it("keeps a real zero rather than falling through it", () => {
    /*- A position with nothing unclaimed has earned nothing yet; that is
     *  a figure, not a missing one. */
    const d = {
      pnlSnapshot: { currentFeesUsd: 0, liveEpoch: { fees: 40.76 } },
    };
    assert.equal(currentUnclaimedFees(d, 40.76), 0);
  });

  it("survives a snapshot that carries neither figure", () => {
    for (const d of [undefined, {}, { pnlSnapshot: {} }])
      assert.equal(currentUnclaimedFees(d, 0), 0, JSON.stringify(d));
  });

  it("never reports negative unclaimed fees with no epoch to subtract from", () => {
    /*- A snapshot can carry the per-NFT compounded figure before any
     *  epoch exists. Subtracting it from nothing would report a negative,
     *  which reads as a loss in Profit and disables Compound Now for the
     *  wrong reason. */
    for (const d of [
      { pnlSnapshot: { currentCompoundedUsd: 35.81 } },
      { pnlSnapshot: { liveEpoch: {} } },
    ])
      assert.equal(currentUnclaimedFees(d, 35.81), 0, JSON.stringify(d));
  });

  it("ignores a non-numeric published figure", () => {
    /*- Same rule as the saved coin totals: judge by type, not by
     *  truthiness, so a bad value falls back rather than propagating. */
    for (const junk of ["0.27", null, undefined, NaN, Infinity, {}]) {
      const d = {
        pnlSnapshot: { currentFeesUsd: junk, liveEpoch: { fees: 41.03 } },
      };
      const got = currentUnclaimedFees(d, 40.76);
      assert.ok(
        Number.isFinite(got),
        "non-finite result for " + JSON.stringify(junk),
      );
    }
  });
});

describe("unmanaged unclaimed fees", () => {
  let remember, read;

  before(async () => {
    const m = await import("../public/dashboard-data-kpi-fees.js");
    remember = m.rememberUnmanagedUnclaimedFees;
    read = m.unmanagedUnclaimedFees;
  });

  it("gives back what the details response reported", () => {
    remember(163164, 0.27);
    assert.equal(read(163164), 0.27);
    assert.equal(read("163164"), 0.27, "tokenId type must not matter");
  });

  it("answers nothing for a different position", () => {
    /*- This is what replaces reset wiring on a position switch: a stale
     *  figure cannot gate another NFT's Compound button, because it only
     *  answers for the NFT it was recorded against. */
    remember(163164, 0.27);
    assert.equal(read(164418), null);
  });

  it("keeps a real zero, which must still gate the button closed", () => {
    remember(163164, 0);
    assert.equal(read(163164), 0);
  });

  it("refuses a figure that is not a finite number", () => {
    for (const junk of ["0.27", null, undefined, NaN, Infinity, {}]) {
      remember(163164, junk);
      assert.equal(read(163164), null, "accepted " + JSON.stringify(junk));
    }
  });

  it("answers nothing when asked about no position at all", () => {
    remember(163164, 0.27);
    assert.equal(read(undefined), null);
    assert.equal(read(null), null);
  });
});

describe("Current panel composition", () => {
  let kpi;

  before(async () => {
    kpi = await import("../public/dashboard-data-kpi.js");
  });

  beforeEach(() => {
    /*- Only the rows this assertion reads. `setKpiValue` and
     *  `_setProfitKpi` no-op on a missing element, so an incomplete
     *  mount would pass everything — each id asserted below is here. */
    document.body.innerHTML = [
      "kpiValue",
      "pnlFees",
      "pnlCompounded",
      "pnlGas",
      "pnlPrice",
      "pnlRealized",
      "curProfit",
      "curIL",
    ]
      .map((id) => '<div id="' + id + '"></div>')
      .join("");
  });

  const usd = (id) =>
    Number(document.getElementById(id).textContent.replace(/[^0-9.-]/g, ""));

  it("shows unclaimed fees and counts compounded exactly once in Profit", () => {
    /*-
     *  The shipped defect, at the site it was visible. `liveEpoch.fees`
     *  is unclaimed + compounded (pnl-tracker.js builds it that way), so
     *  rendering it as Fees Earned and then adding Fees Compounded
     *  charged the compounded figure to Profit twice. On a real position
     *  that was $40.76 of a reported $79.78.
     *
     *  Profit = Fees Earned + Fees Compounded - Gas +/- IL/G
     *         = 0.27 + 40.76 - 0.28 + (-1.72) = 39.03
     */
    kpi._applySnapshotKpis(
      {
        pnlSnapshot: {
          liveEpoch: { fees: 41.03, gas: 0 },
          currentFeesUsd: 0.27,
          currentCompoundedUsd: 40.76,
          currentGasUsd: 0.28,
          currentValue: 3143.94,
          totalIL: -1.72,
        },
      },
      0,
      0,
    );
    assert.equal(usd("pnlFees"), 0.27, "Fees Earned is unclaimed only");
    assert.equal(usd("pnlCompounded"), 40.76);
    assert.equal(usd("curProfit"), 39.03, "compounded counted once");
  });

  it("leaves Net P&L unchanged by the fix", () => {
    /*- The old form reached the same total as unclaimed + compounded -
     *  compounded. Only the decomposition changed, so a shift here would
     *  mean the fix moved a number it had no business moving.
     *  total = (currentValue - deposit) + unclaimed + realized
     *        = (3143.94 - 3000) + 0.27 + 0 = 144.21 */
    kpi._applySnapshotKpis(
      {
        pnlSnapshot: {
          liveEpoch: { fees: 41.03, gas: 0 },
          currentFeesUsd: 0.27,
          currentCompoundedUsd: 40.76,
          currentGasUsd: 0.28,
          currentValue: 3143.94,
          totalIL: -1.72,
        },
      },
      3000,
      0,
    );
    const bd = kpi.getCurBreakdown();
    assert.equal(Number(bd.total.toFixed(2)), 144.21, "Net P&L must not move");
    assert.equal(bd.fees, 0.27, "the dialog shows the same unclaimed figure");
  });
});
