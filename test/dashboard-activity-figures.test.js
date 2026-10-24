"use strict";

/**
 * @file test/dashboard-activity-figures.test.js
 * @description The figures under the date of each Rebalance and Compound
 *   entry in the Activity Log (src/client/web/dashboard-activity-figures.js), as
 *   `act()` draws them into the page's own entry template: the label, the
 *   Current and Historical percents, and "Old Log: Unavailable" for an
 *   entry written before the figures existed. Also the one record of the
 *   entries the log shows, which keeps an entry from being drawn twice,
 *   lets each status answer bring Current up to date, and takes a
 *   position's entries off so they can be drawn again from the records a
 *   scan left. When the page does that last is pinned in
 *   test/dashboard-activity-figures-scan-end.test.js.
 *
 *   The fixture rebalance swapped 100 of token0 for 90 of token1: 1,000
 *   and 100 before, 900 and 190 after. At $1 each the coins after are
 *   worth $1,090 against $1,100, a loss of 0.92% of the position after,
 *   shown as "-1%". At $1 and $2 they are worth $1,280 against $1,200, a
 *   gain of 6.25%, shown as "6%". The fixture compound collected 10 of
 *   token0 and 20 of token1, 12.5% of the position at the time, shown to
 *   three decimal places as a Compound's figures are ("12.500%"); at $2
 *   and $1 against a position worth $400 today, they are "10.000%".
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { indexHtmlDocument } = require("./helpers/index-html");
const { learnUiSettings } = require("./helpers/ui-settings");

let figs;
let act;

before(async () => {
  figs = await import("../src/client/web/dashboard-activity-figures.js");
  ({ act } = await import("../src/client/web/dashboard-helpers.js"));
  // A short log, so a test can see the oldest entry trimmed.
  await learnUiSettings({ activityLogMaxEntries: 2 });
});

beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    document.importNode(page.getElementById("actList"), true),
    document.importNode(page.getElementById("tplActItem"), true),
  );
  figs.clearActivityEntries();
});

const REBALANCE_TX = "0x" + "ab".repeat(32);
const COMPOUND_TX = "0x" + "cd".repeat(32);
const LOSS_PCT = ((1090 - 1100) / 1090) * 100;

/** A rebalance's event record, with its figures finished. */
const rebalanceRecord = (over = {}) => ({
  txHash: REBALANCE_TX,
  oldTokenId: "6",
  newTokenId: "7",
  beforeRebalance: { amount0: 1000, amount1: 100 },
  afterRebalance: { amount0: 900, amount1: 190 },
  historical: { impermanentLossGainPct: LOSS_PCT },
  ...over,
});

/** A compound's record, with its figures. */
const compoundRecord = (over = {}) => ({
  txHash: COMPOUND_TX,
  tokenId: "7",
  feesCollected: { amount0: 10, amount1: 20 },
  historical: { percentGainForPosition: 12.5 },
  ...over,
});

/** A position's state as a status answer carries it. */
const stateAt = (price0, price1, over = {}) => ({
  pnlSnapshot: { ilInputs: { price0, price1 }, currentValue: 400 },
  ...over,
});

/** Draw a Rebalance entry as the log does. */
function drawRebalance(record, state, when = "2026-10-21T11:17:00Z") {
  act(
    "R",
    "fee",
    "Rebalance",
    "NFT #6 → #7",
    new Date(when),
    record.txHash,
    figs.rebalanceFigures(record, state),
  );
}

/** Draw a Compound entry as the log does. */
function drawCompound(record, state) {
  act(
    "C",
    "fee",
    "Compound",
    "NFT #7 — $usd 4.33 reinvested (Auto)",
    new Date("2026-10-21T10:51:00Z"),
    record.txHash,
    figs.compoundFigures(record, state),
  );
}

/** What the figures section of the log's one entry reads, line by line. */
function shown() {
  const entries = document.getElementById("actList").children;
  assert.equal(entries.length, 1, "one entry in the log");
  const fin = entries[0].querySelector('[data-tpl="fin"]');
  if (fin === null) return null;
  assert.equal(fin.hidden, false);
  return [...fin.children].map((line) => line.textContent);
}

describe("fmtPct", () => {
  it("shows a whole number, a minus sign for a loss and none for a gain", () => {
    assert.equal(figs.fmtPct(-3.4, 0), "-3%");
    assert.equal(figs.fmtPct(3.6, 0), "4%");
    assert.equal(figs.fmtPct(12.5, 0), "13%");
    assert.equal(figs.fmtPct(0, 0), "0%");
  });

  it("shows three decimal places when asked, as a Compound's figures are", () => {
    assert.equal(figs.fmtPct(0.0583, 3), "0.058%");
    assert.equal(figs.fmtPct(0.95571, 3), "0.956%");
    assert.equal(figs.fmtPct(12.5, 3), "12.500%");
  });

  it("never puts a minus sign on a figure that rounds to zero", () => {
    assert.equal(figs.fmtPct(-0.4, 0), "0%");
    assert.equal(figs.fmtPct(-0, 0), "0%");
    assert.equal(figs.fmtPct(-0.0004, 3), "0.000%");
  });

  it("shows a dash for a figure that is not known", () => {
    for (const v of [null, undefined, Number.NaN, Infinity, "3"]) {
      assert.equal(figs.fmtPct(v, 0), "—");
      assert.equal(figs.fmtPct(v, 3), "—");
    }
  });
});

describe("figuresView", () => {
  it("works out a rebalance's Current from its coins at today's prices", () => {
    const view = figs.figuresView(
      "rebalance",
      rebalanceRecord(),
      stateAt(1, 2),
    );
    assert.equal(view.old, false);
    assert.equal(view.historical, LOSS_PCT);
    assert.ok(Math.abs(view.current - 6.25) < 1e-9, String(view.current));
  });

  it("leaves Current unknown for a rebalance whose coins are still due", () => {
    const due = {
      txHash: REBALANCE_TX,
      figuresDue: true,
      historical: { impermanentLossGainPct: LOSS_PCT },
    };
    const view = figs.figuresView("rebalance", due, stateAt(1, 1));
    assert.deepEqual(view, { old: false, historical: LOSS_PCT, current: null });
    const rebuilt = { txHash: REBALANCE_TX, figuresDue: true };
    assert.deepEqual(figs.figuresView("rebalance", rebuilt, stateAt(1, 1)), {
      old: false,
      historical: null,
      current: null,
    });
  });

  it("works out a compound's Current against the position's value today", () => {
    const view = figs.figuresView("compound", compoundRecord(), stateAt(2, 1));
    assert.deepEqual(view, { old: false, historical: 12.5, current: 10 });
  });

  it("is old for a record that holds no figures", () => {
    const old = { txHash: REBALANCE_TX, newTokenId: "7" };
    assert.deepEqual(figs.figuresView("rebalance", old, stateAt(1, 1)), {
      old: true,
    });
    assert.deepEqual(figs.figuresView("compound", old, stateAt(1, 1)), {
      old: true,
    });
  });

  it("leaves Current unknown without the position's prices", () => {
    for (const state of [undefined, {}, { pnlSnapshot: {} }]) {
      assert.equal(
        figs.figuresView("rebalance", rebalanceRecord(), state).current,
        null,
      );
      assert.equal(
        figs.figuresView("compound", compoundRecord(), state).current,
        null,
      );
    }
  });
});

describe("an entry's figures in the Activity Log", () => {
  it("show under a Rebalance entry's date", () => {
    drawRebalance(rebalanceRecord(), stateAt(1, 1));
    assert.deepEqual(shown(), [
      "Impermanent Loss/Gain:",
      "Current: -1% · Historical: -1%",
    ]);
    const side = document.getElementsByClassName("9mm-pos-mgr-act-side")[0];
    assert.deepEqual(
      [...side.children].map((el) => el.dataset.tpl),
      ["when", "fin"],
      "the date, then the figures, in one column",
    );
  });

  it("show under a Compound entry's date", () => {
    drawCompound(compoundRecord(), stateAt(2, 1));
    assert.deepEqual(shown(), [
      "Percent Gain for Position:",
      "Current: 10.000% · Historical: 12.500%",
    ]);
  });

  it("show a Compound's gain to three decimal places, since it is often well under 1%", () => {
    // $40 of fees against a position worth $68,610 today: 0.0583%.
    drawCompound(
      compoundRecord({ historical: { percentGainForPosition: 0.0583 } }),
      {
        pnlSnapshot: {
          ilInputs: { price0: 2, price1: 1 },
          currentValue: 68610,
        },
      },
    );
    assert.deepEqual(shown(), [
      "Percent Gain for Position:",
      "Current: 0.058% · Historical: 0.058%",
    ]);
  });

  it("read Old Log: Unavailable for an entry written before they existed", () => {
    drawRebalance({ txHash: REBALANCE_TX }, stateAt(1, 1));
    assert.deepEqual(shown(), [
      "Impermanent Loss/Gain:",
      "Old Log: Unavailable",
    ]);
    document.getElementById("actList").replaceChildren();
    drawCompound({ txHash: COMPOUND_TX }, stateAt(1, 1));
    assert.deepEqual(shown(), [
      "Percent Gain for Position:",
      "Old Log: Unavailable",
    ]);
  });

  it("show a dash for each figure not yet known", () => {
    drawRebalance({ txHash: REBALANCE_TX, figuresDue: true }, undefined);
    assert.deepEqual(shown(), [
      "Impermanent Loss/Gain:",
      "Current: — · Historical: —",
    ]);
  });

  it("are left out of every other kind of entry", () => {
    act("i", "start", "Bot started", "Watching NFT #7");
    assert.equal(shown(), null);
  });
});

describe("drawing an entry once", () => {
  it("draws a rebalance the live check and the history pass both reach once", () => {
    drawRebalance(rebalanceRecord(), stateAt(1, 1));
    drawRebalance(rebalanceRecord(), stateAt(1, 1));
    assert.equal(document.getElementById("actList").children.length, 1);
  });

  it("knows the entry whatever the case of its hash", () => {
    drawCompound(compoundRecord(), stateAt(2, 1));
    drawCompound(
      compoundRecord({ txHash: COMPOUND_TX.toUpperCase() }),
      stateAt(2, 1),
    );
    assert.equal(document.getElementById("actList").children.length, 1);
  });

  it("forgets an entry the log trims, and every entry when it is cleared", () => {
    const tx = (n) => "0x" + String(n).repeat(64);
    drawRebalance(
      rebalanceRecord({ txHash: tx(1) }),
      stateAt(1, 1),
      "2026-10-19T00:00:00Z",
    );
    drawRebalance(
      rebalanceRecord({ txHash: tx(2) }),
      stateAt(1, 1),
      "2026-10-20T00:00:00Z",
    );
    drawRebalance(
      rebalanceRecord({ txHash: tx(3) }),
      stateAt(1, 1),
      "2026-10-21T00:00:00Z",
    );
    const drawn = (n) =>
      figs.isActivityEntryDrawn(
        figs.rebalanceFigures(rebalanceRecord({ txHash: tx(n) }), {}),
      );
    assert.equal(document.getElementById("actList").children.length, 2);
    assert.deepEqual([drawn(1), drawn(2), drawn(3)], [false, true, true]);
    figs.clearActivityEntries();
    assert.deepEqual([drawn(2), drawn(3)], [false, false]);
  });
});

describe("refreshActivityCurrent", () => {
  const KEY = "pulsechain-0x1-0x2-7";

  /** The figures line of the log's one entry. */
  const figuresLine = () => shown()[1];

  it("brings Current up to date with today's prices, leaving Historical", () => {
    drawRebalance(rebalanceRecord(), stateAt(1, 1));
    figs.refreshActivityCurrent({
      [KEY]: stateAt(1, 2, { rebalanceEvents: [rebalanceRecord()] }),
    });
    assert.equal(figuresLine(), "Current: 6% · Historical: -1%");
  });

  it("keeps the last Current while the position's prices are missing", () => {
    drawRebalance(rebalanceRecord(), stateAt(1, 2));
    figs.refreshActivityCurrent({
      [KEY]: { rebalanceEvents: [rebalanceRecord()] },
    });
    assert.equal(figuresLine(), "Current: 6% · Historical: -1%");
  });

  it("fills in an entry drawn while its figures were due", () => {
    const due = {
      txHash: REBALANCE_TX,
      figuresDue: true,
      historical: { impermanentLossGainPct: LOSS_PCT },
    };
    drawRebalance(due, stateAt(1, 1));
    assert.equal(figuresLine(), "Current: — · Historical: -1%");
    // The rebalance moved the position to a new key; its record is there.
    figs.refreshActivityCurrent({
      [KEY]: stateAt(1, 1, { rebalanceEvents: [] }),
      "pulsechain-0x1-0x2-8": stateAt(1, 1, {
        rebalanceEvents: [rebalanceRecord()],
      }),
    });
    assert.equal(figuresLine(), "Current: -1% · Historical: -1%");
  });

  it("updates a compound's Current from its record", () => {
    drawCompound(compoundRecord(), stateAt(2, 1));
    figs.refreshActivityCurrent({
      [KEY]: {
        pnlSnapshot: { ilInputs: { price0: 2, price1: 1 }, currentValue: 800 },
        compoundHistory: [compoundRecord()],
      },
    });
    assert.equal(figuresLine(), "Current: 5.000% · Historical: 12.500%");
  });

  it("leaves an old entry and an entry no answer carries as they are", () => {
    drawRebalance({ txHash: REBALANCE_TX }, stateAt(1, 1));
    figs.refreshActivityCurrent({
      [KEY]: stateAt(1, 2, { rebalanceEvents: [rebalanceRecord()] }),
    });
    assert.equal(figuresLine(), "Old Log: Unavailable");
    document.getElementById("actList").replaceChildren();
    figs.clearActivityEntries();
    drawCompound(compoundRecord(), stateAt(2, 1));
    figs.refreshActivityCurrent({ [KEY]: stateAt(9, 9) });
    assert.equal(figuresLine(), "Current: 10.000% · Historical: 12.500%");
  });

  it("reads past an answer it cannot use", () => {
    drawCompound(compoundRecord(), stateAt(2, 1));
    for (const states of [undefined, null, [], { [KEY]: null }, { [KEY]: 3 }])
      figs.refreshActivityCurrent(states);
    assert.equal(figuresLine(), "Current: 10.000% · Historical: 12.500%");
  });
});

describe("removePositionActivityEntries", () => {
  /** The entries in the log, by title. */
  const titles = () =>
    [...document.getElementById("actList").children].map(
      (el) => el.querySelector('[data-tpl="title"]').textContent,
    );

  it("takes one position's entries off, and leaves another's", () => {
    drawCompound(compoundRecord(), stateAt(2, 1, { poolKey: "pool-a" }));
    drawRebalance(rebalanceRecord(), stateAt(1, 1, { poolKey: "pool-b" }));
    figs.removePositionActivityEntries("pool-a");
    assert.deepEqual(titles(), ["Rebalance"]);
    // Off the log, so the history pass can draw it again.
    assert.equal(
      figs.isActivityEntryDrawn(figs.compoundFigures(compoundRecord(), {})),
      false,
    );
    drawCompound(compoundRecord(), stateAt(2, 1, { poolKey: "pool-a" }));
    assert.deepEqual(titles().sort(), ["Compound", "Rebalance"]);
  });

  it("leaves every other kind of entry", () => {
    drawCompound(compoundRecord(), stateAt(2, 1, { poolKey: "pool-a" }));
    act("i", "start", "Setting Saved", "Max Rebalances / Day: 5");
    figs.removePositionActivityEntries("pool-a");
    assert.deepEqual(titles(), ["Setting Saved"]);
  });

  it("takes off an entry with no transaction too", () => {
    /*-
     *  Nothing can tell two such entries apart, so the log never refuses
     *  one as drawn already; left behind, each redraw would add a copy.
     */
    drawCompound(
      compoundRecord({ txHash: undefined }),
      stateAt(2, 1, { poolKey: "pool-a" }),
    );
    figs.removePositionActivityEntries("pool-a");
    assert.deepEqual(titles(), []);
  });

  it("takes nothing off without a pool key", () => {
    drawCompound(compoundRecord(), stateAt(2, 1, { poolKey: "pool-a" }));
    drawRebalance(rebalanceRecord(), stateAt(1, 1));
    for (const poolKey of [undefined, null, ""])
      figs.removePositionActivityEntries(poolKey);
    assert.deepEqual(titles().sort(), ["Compound", "Rebalance"]);
  });
});

describe("canDrawPositionEntries", () => {
  it("waits for a managed position's second data load, its pool key", () => {
    assert.equal(figs.canDrawPositionEntries({ status: "running" }), false);
    for (const poolKey of [undefined, null, "", 7])
      assert.equal(
        figs.canDrawPositionEntries({ status: "running", poolKey }),
        false,
        `pool key ${String(poolKey)}`,
      );
    assert.equal(
      figs.canDrawPositionEntries({ status: "running", poolKey: "pool-a" }),
      true,
    );
  });

  it("does not wait for a position the bot does not manage", () => {
    assert.equal(figs.canDrawPositionEntries({ status: "stopped" }), true);
    assert.equal(figs.canDrawPositionEntries({}), true);
  });

  it("draws nothing for a state it cannot read", () => {
    for (const state of [undefined, null, [], "running"])
      assert.equal(figs.canDrawPositionEntries(state), false);
  });
});
