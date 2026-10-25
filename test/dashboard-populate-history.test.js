"use strict";

/**
 * @file test/dashboard-populate-history.test.js
 * @description The history pass (src/client/web/dashboard-populate-history.js)
 *   draws a position's Rebalance entries in the same words as the live
 *   check, what started each one included. The log runs the pass again
 *   when a scan of the position on screen finishes, so a rebalance's
 *   label has to come back with it rather than live only in the first
 *   drawing of the entry. For a managed position, both of its passes
 *   wait for the position's second data load, the status answer that
 *   carries its pool key.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { indexHtmlDocument } = require("./helpers/index-html");
const { learnUiSettings } = require("./helpers/ui-settings");

let history;
let figs;

before(async () => {
  history = await import("../src/client/web/dashboard-populate-history.js");
  figs = await import("../src/client/web/dashboard-activity-figures.js");
  await learnUiSettings();
});

beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    document.importNode(page.getElementById("actList"), true),
    document.importNode(page.getElementById("tplActItem"), true),
  );
  figs.clearActivityEntries();
  history.resetPopulateHistoryFlags();
});

/** A rebalance's event record. */
const event = (n, trigger) => ({
  txHash: "0x" + String(n).repeat(64),
  oldTokenId: String(n),
  newTokenId: String(n + 1),
  dateStr: `2026-10-2${n}T11:17:00.000Z`,
  trigger,
});

/** What each Rebalance entry's line reads, newest first. */
function lines() {
  return [...document.querySelectorAll("#actList .ai")].map(
    (el) => el.querySelector('[data-tpl="main"]').firstChild.textContent,
  );
}

describe("populateRebalanceHistoryOnce", () => {
  it("names what started each rebalance its record says", () => {
    history.populateRebalanceHistoryOnce(
      {
        running: false,
        rebalanceEvents: [event(1, "manual"), event(2, undefined)],
      },
      "PulseX/WPLS",
    );
    assert.deepEqual(lines(), ["NFT #2 → #3", "NFT #1 → #2 (Manual)"]);
  });

  it("draws a running position's history once its scan has finished", () => {
    const data = {
      running: true,
      rebalanceScanComplete: false,
      rebalanceEvents: [event(1, "residual-cleanup")],
    };
    history.populateRebalanceHistoryOnce(data, "");
    assert.deepEqual(lines(), []);
    history.populateRebalanceHistoryOnce(
      { ...data, rebalanceScanComplete: true },
      "",
    );
    assert.deepEqual(lines(), ["NFT #1 → #2 (Residual Cleanup)"]);
  });

  it("waits for a managed position's second data load", () => {
    /*-
     *  As the server starts a position, its records reach the page before
     *  its loop runs, so the scan gate alone would let these through.
     */
    const data = {
      status: "running",
      running: false,
      rebalanceEvents: [event(1, "manual")],
    };
    history.populateRebalanceHistoryOnce(data, "");
    assert.deepEqual(lines(), []);
    history.populateRebalanceHistoryOnce(
      {
        ...data,
        running: true,
        rebalanceScanComplete: true,
        poolKey: "pulsechain-pool-of-2",
      },
      "",
    );
    assert.deepEqual(lines(), ["NFT #1 → #2 (Manual)"]);
  });
});

describe("populateCompoundHistoryOnce", () => {
  /** A compound's record. */
  const compound = {
    timestamp: "2026-10-21T10:51:00.000Z",
    txHash: "0x" + "cd".repeat(32),
    tokenId: "5",
    usdValue: 4.33,
    trigger: "manual",
  };

  it("waits for a managed position's second data load", () => {
    const data = {
      status: "running",
      running: false,
      compoundHistory: [compound],
    };
    history.populateCompoundHistoryOnce(data, "");
    assert.deepEqual(lines(), []);
    history.populateCompoundHistoryOnce(
      {
        ...data,
        running: true,
        lifetimeScanComplete: true,
        poolKey: "pulsechain-pool-of-5",
      },
      "",
    );
    assert.deepEqual(lines(), ["NFT #5 — $usd 4.33 reinvested (Manual)"]);
  });
});
