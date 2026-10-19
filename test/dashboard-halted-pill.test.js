"use strict";

/**
 * @file test/dashboard-halted-pill.test.js
 * @description The status pill reads HALTED when the server stops
 *   answering, and that includes the dashboard failing to learn its
 *   blockchain at startup.
 *
 *   One count serves every question the dashboard asks the server: the
 *   three startup requests (the blockchain, the dashboard settings and
 *   the help figures), and every status poll after them. `pollFailuresBeforeHalted` unanswered in a row turn the pill
 *   red; an answer ends the run. Startup hands the chain query the same
 *   two counters a poll uses, so a dashboard that cannot learn its
 *   blockchain reads HALTED like one whose polls go unanswered.
 *
 *   Runs the real browser modules under jsdom, with the pill as
 *   index.html ships it and a scripted `fetch` for the chain query.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const SERVER_DOWN = require("../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-down-scenario.json");

let poll;
let chainMod;

before(async () => {
  /*-
   *  The data module first, as the bundle loads it: it hands the poll
   *  module its status callback at load, so the poll module must have
   *  run before it, which importing the data module first arranges.
   */
  await import("../public/dashboard-data.js");
  poll = await import("../public/dashboard-data-poll.js");
  chainMod = await import("../public/dashboard-chain.js");
});

// The pill as index.html ships it.
beforeEach(() => {
  document.body.innerHTML =
    '<div class="status-pill" id="botStatusPill">' +
    '<div class="dot" id="botDot"></div>' +
    '<span id="botStatusText"></span></div>';
  poll.countAnsweredQuestion();
});

const pillText = () => document.getElementById("botStatusText").textContent;
const N = SERVER_DOWN.pollFailuresBeforeHalted;

describe("the HALTED pill", () => {
  it("reads HALTED once the shipped number of questions go unanswered in a row", () => {
    for (let i = 1; i < N; i++) poll.countUnansweredQuestion();
    assert.equal(pillText(), "", "not yet: one short of the count");
    poll.countUnansweredQuestion();
    assert.equal(pillText(), "HALTED");
    assert.equal(
      document.getElementById("botStatusPill").className,
      "status-pill danger",
    );
  });

  it("starts the count again after an answer", () => {
    for (let i = 1; i < N; i++) poll.countUnansweredQuestion();
    poll.countAnsweredQuestion();
    poll.countUnansweredQuestion();
    assert.equal(pillText(), "", "one miss after an answer is not a run");
  });

  it("reads HALTED while startup cannot learn the blockchain", async () => {
    /*-
     *  The server never names a chain for N requests, then does. The pill
     *  reads HALTED after the Nth, and the answer resets the count, so a
     *  single failed poll afterwards does not bring HALTED straight back.
     */
    let asked = 0;
    let haltedBeforeAnswer = false;
    const fetchFn = async () => {
      asked++;
      if (asked <= N) throw new TypeError("Failed to fetch");
      haltedBeforeAnswer = pillText() === "HALTED";
      return { ok: true, json: async () => ({ chainId: "pulsechain" }) };
    };
    await chainMod.loadActiveChain({
      fetchFn,
      askEveryMs: 1,
      warnFn: () => {},
      onUnanswered: poll.countUnansweredQuestion,
      onAnswered: poll.countAnsweredQuestion,
    });
    assert.equal(haltedBeforeAnswer, true, "HALTED while no chain was known");
    document.getElementById("botStatusText").textContent = "";
    poll.countUnansweredQuestion();
    assert.equal(pillText(), "", "the answer reset the count");
  });
});
