"use strict";

/**
 * @file test/dashboard-il-debug-figures.test.js
 * @description The IL/G popover shows a USD figure below one cent in
 *   scientific notation to four significant digits, trailing zeros
 *   dropped and its sign kept, so a coin priced in billionths of a
 *   dollar fits its row. Driven on the popover's templates from
 *   src/client/web/index.html.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

let ilDebug;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  await learnActiveChain();
  await learnUiSettings();
  document.body.innerHTML = indexHtmlDocument().body.innerHTML;
  ilDebug = await import("../src/client/web/dashboard-il-debug.js");
});

/**
 * Open the Current Position popover on a status answer whose IL inputs
 * carry the given prices, LP value and compounded fees.
 */
function showWith(o) {
  ilDebug.updateILDebugData({
    pnlSnapshot: {
      totalIL: 0,
      lifetimeIL: 0,
      ilInputs: {
        lpValue: o.lpValue,
        price0: o.price0,
        price1: o.price1,
        residualValueUsd: 0,
        cur: {
          hodlAmount0: 1000,
          hodlAmount1: 1000,
          compoundedRemoved: o.compounded,
        },
        lt: { hodlAmount0: 1000, hodlAmount1: 1000 },
      },
    },
  });
  ilDebug.showILDebug("cur");
}

const figure = (key) =>
  document
    .getElementById("9mm-il-debug-popover")
    .querySelector(`[data-tpl="${key}"]`).textContent;

describe("the IL/G popover's figures below one cent", () => {
  it("show four significant digits", () => {
    showWith({
      lpValue: 10,
      price0: 2.9223882966886928e-9,
      price1: 2.928973712910885e-9,
      compounded: 0,
    });
    assert.equal(figure("p0"), "$2.922e-9");
    assert.equal(figure("p1"), "$2.929e-9");
  });

  it("drop the zeros a shorter figure would trail", () => {
    showWith({ lpValue: 10, price0: 0.003, price1: 0.0015, compounded: 0 });
    assert.equal(figure("p0"), "$3e-3");
    assert.equal(figure("p1"), "$1.5e-3");
  });

  it("keep their sign", () => {
    // LP value less compounded fees: 0.001 - 0.004.
    showWith({ lpValue: 0.001, price0: 1, price1: 1, compounded: 0.004 });
    assert.equal(figure("lpPlusResidual"), "-$3e-3");
  });

  it("leave a figure of a cent or more to the cent", () => {
    showWith({ lpValue: 10, price0: 0.25, price1: 1234.5678, compounded: 0 });
    assert.equal(figure("p0"), "$0.25");
    assert.equal(figure("p1"), "$1234.57");
  });
});

describe("the IL/G popover's sections and the Wallet Residual", () => {
  /** Open one section on inputs that carry a $12 Wallet Residual. */
  function open(panel) {
    ilDebug.updateILDebugData({
      pnlSnapshot: {
        totalIL: 0,
        lifetimeIL: 0,
        ilInputs: {
          lpValue: 100,
          price0: 1,
          price1: 1,
          residualValueUsd: 12,
          cur: { hodlAmount0: 50, hodlAmount1: 50, compoundedRemoved: 4 },
          lt: { hodlAmount0: 50, hodlAmount1: 50, compoundedRemoved: 4 },
        },
      },
    });
    ilDebug.showILDebug(panel);
    return document.getElementById("9mm-il-debug-popover");
  }
  const tpl = (root, key) => root.querySelector(`[data-tpl="${key}"]`);

  it("leaves the residual out of the Current Position IL/G", () => {
    /*-
     *  The current figure counts no coin in the wallet, so that it
     *  compares evenly (src/lib/bot-pnl-il.js).
     */
    const root = open("cur");
    assert.equal(tpl(root, "residualRow").hidden, true);
    assert.equal(tpl(root, "lpPlusResidual").textContent, "$96.00");
    assert.equal(tpl(root, "lblLpSide").textContent, "LP Value − Compounded");
    assert.match(tpl(root, "formula").textContent, /^IL = LP Value − \(/);
  });

  it("credits it in the Lifetime IL/G, as before", () => {
    const root = open("lt");
    assert.equal(tpl(root, "residualRow").hidden, false);
    assert.equal(tpl(root, "lpPlusResidual").textContent, "$108.00");
    assert.match(tpl(root, "formula").textContent, /Wallet Residual/);
  });
});
