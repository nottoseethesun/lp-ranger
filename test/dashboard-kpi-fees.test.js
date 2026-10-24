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
 *
 *   An unmanaged position shows no Profit at all, since it can never
 *   have the compound records Profit needs.
 */

"use strict";

require("global-jsdom/register");
const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

describe("currentUnclaimedFees", () => {
  let currentUnclaimedFees;

  before(async () => {
    ({ currentUnclaimedFees } =
      await import("../src/client/web/dashboard-data-kpi-fees.js"));
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
    const m = await import("../src/client/web/dashboard-data-kpi-fees.js");
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
    kpi = await import("../src/client/web/dashboard-data-kpi.js");
  });

  beforeEach(() => {
    /*- Only the rows this assertion reads. `setKpiValue` and
     *  `_setProfitKpi` no-op on a missing element, so an incomplete
     *  mount would pass everything — each id asserted below is here. */
    document.body.innerHTML = [
      "kpiValue",
      "pnlFees",
      "pnlCompounded",
      "pnlFeesLeft",
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

  it("adds the fees a compound left in the wallet to Profit and to Net P&L, on their own line", () => {
    /*-
     *  The user, 2026-10-23: "The Compound knows the total of coins so of
     *  course, that should show up in Current." They are in neither fee
     *  row nor the IL/G, which counts no coin in the wallet, and outside
     *  Current Value, so Net P&L adds them too: once a later compound
     *  sweeps them in, Initial Deposit for This LP counts them among the
     *  wallet's coins it took (src/lib/current-lp-deposit.js), so they
     *  still count once.
     *  Profit = 0.27 + 40.76 + 5.00 - 0.28 + (-1.72) = 44.03
     *  Net P&L = (3143.94 - 3000) + 0.27 + 0 + 5.00 = 149.21
     */
    const snap = {
      liveEpoch: { fees: 41.03, gas: 0 },
      currentFeesUsd: 0.27,
      currentCompoundedUsd: 40.76,
      currentFeesLeftUsd: 5,
      currentGasUsd: 0.28,
      currentValue: 3143.94,
      totalIL: -1.72,
    };
    kpi._applySnapshotKpis({ pnlSnapshot: snap }, 3000, 0);
    assert.equal(usd("pnlFeesLeft"), 5);
    assert.equal(usd("pnlCompounded"), 40.76, "Fees Compounded unchanged");
    assert.equal(usd("curProfit"), 44.03);
    const bd = kpi.getCurBreakdown();
    assert.equal(Number(bd.total.toFixed(2)), 149.21, "Net P&L counts them");
    assert.equal(bd.feesLeft, 5, "and the dialog shows them on their row");
  });

  it("shows a dash on the line when no compound left any", () => {
    kpi._applySnapshotKpis(
      { pnlSnapshot: { currentFeesUsd: 0.27, currentFeesLeftUsd: 0 } },
      0,
      0,
    );
    assert.equal(
      document.getElementById("pnlFeesLeft").textContent.includes("—"),
      true,
    );
  });
});

describe("the Current panel's Initial Deposit for This LP", () => {
  /*-
   *  The coins the NFT was minted with, $3,000 at its mint, and the
   *  wallet's coins its compounds took in beyond their fees, $500 at
   *  their compounds' prices (`currentDepositAddedUsd`,
   *  src/lib/current-lp-deposit.js). Current Value holds both.
   */
  let kpi;
  before(async () => {
    kpi = await import("../src/client/web/dashboard-data-kpi.js");
  });

  const status = (snap, over = {}) => ({
    _hasPositionData: true,
    hodlBaseline: { entryValue: 3000 },
    pnlSnapshot: {
      currentValue: 3600,
      currentFeesUsd: 0.5,
      currentDepositAddedUsd: 500,
      currentFeesLeftUsd: 5,
      ...snap,
    },
    ...over,
  });

  it("counts the wallet's coins the NFT's compounds took in, with the coins it was minted with", () => {
    assert.equal(kpi._resolveCurDeposit(status()), 3500);
  });

  it("keeps those coins out of Net P&L, and adds the fees left in the wallet", () => {
    // (3600 - 3500) + 0.50 unclaimed + 0 realized + 5.00 left = 105.50
    const t = kpi._resolveKpiTotals(status());
    assert.equal(t.curDep, 3500);
    assert.equal(Number(t.curTotal.toFixed(2)), 105.5);
  });

  it("adds them to the minted coins at the prices when the bot started, where the mint's are missing", () => {
    const d = status(
      { liveEpoch: { entryValue: 2900 } },
      { hodlBaseline: null },
    );
    assert.equal(kpi._resolveCurDeposit(d), 3400);
  });

  it("is nothing while neither figure for the minted coins is known", () => {
    assert.equal(kpi._resolveCurDeposit(status({}, { hodlBaseline: null })), 0);
  });
});

describe("an unmanaged position's Profit", () => {
  /*-
   *  The user, 2026-10-23: "An Unmanaged Position should not show any
   *  Profit figure, because it simply can never have the required info."
   *  Profit needs LP Ranger's record of each compound, kept only while
   *  LP Ranger manages the position.
   */
  let kpi;
  let unmanaged;

  before(async () => {
    kpi = await import("../src/client/web/dashboard-data-kpi.js");
    unmanaged = await import("../src/client/web/dashboard-unmanaged-apply.js");
  });

  beforeEach(() => {
    document.body.innerHTML = [
      "kpiValue",
      "pnlFees",
      "pnlCompounded",
      "pnlFeesLeft",
      "pnlGas",
      "pnlPrice",
      "kpiPnl",
      "curProfit",
      "curIL",
      "pnlRealized",
    ]
      .map((id) => '<div id="' + id + '"></div>')
      .join("");
  });

  const text = (id) => document.getElementById(id).textContent;

  it("shows no figure from the first step, whatever its answer carries", () => {
    // The dash the fetch puts on every card before asking.
    document.getElementById("curProfit").textContent = "—";
    unmanaged._applyCurrentKpis({
      value: 100,
      feesUsd: 2,
      il: 30,
      profit: 32,
      netPnl: 5,
    });
    assert.equal(text("curProfit"), "—");
    assert.ok(text("curIL").includes("30"), "the IL/G still shows");
  });

  it("puts the dash back on each status answer, over a figure from managing it", () => {
    kpi._setProfitKpi("curProfit", 12, 0.5, -1);
    assert.ok(text("curProfit").includes("10.50"), "the managed figure");
    kpi._applyUnmanagedSnapshotOverlay({
      pnlSnapshot: {
        currentCompoundedUsd: 10,
        currentFeesLeftUsd: 1,
        currentGasUsd: 0.5,
      },
    });
    assert.equal(text("curProfit"), "—");
    assert.ok(text("pnlCompounded").includes("10"), "the lines above it show");
  });

  it("puts the dash back before the second step's figures arrive, too", () => {
    kpi._setProfitKpi("curProfit", 12, 0.5, -1);
    kpi._applyUnmanagedSnapshotOverlay({});
    assert.equal(text("curProfit"), "—");
  });
});

describe("Lifetime Net P&L", () => {
  let kpi;

  before(async () => {
    kpi = await import("../src/client/web/dashboard-data-kpi.js");
  });

  /** A lifetime snapshot: $1,000 deposited, prices flat. */
  const snapshot = (over) => ({
    pnlSnapshot: {
      currentValue: 1150,
      totalLifetimeDeposit: 1000,
      totalCompoundedUsd: 150,
      currentFeesUsd: 0,
      totalGas: 0,
      residualValueUsd: 0,
      initialResidualUsd: 0,
      ...over,
    },
  });

  it("counts reinvested fees once: they are inside Current Value", () => {
    /*-
     *  $150 of fees earned and all reinvested: Current Value is $1,150,
     *  and the $150 is in it, so Net P&L is $150. Adding Fees Compounded
     *  on top reported $300.
     */
    assert.equal(kpi._resolveKpiTotals(snapshot({})).ltTotal, 150);
  });

  it("still adds the fees not yet compounded, which Current Value lacks", () => {
    const t = kpi._resolveKpiTotals(snapshot({ currentFeesUsd: 20 }));
    assert.equal(t.ltTotal, 170);
  });
});
