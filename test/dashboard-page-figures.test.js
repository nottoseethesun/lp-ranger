"use strict";

/**
 * @file test/dashboard-page-figures.test.js
 * @description The dashboard's help quotes the figures this install runs
 *   on, which it asks the server for at startup.
 *
 *   `index.html` holds an empty `<span data-figure="name">` wherever its
 *   help quotes a configured number: the slippage confirmation dialogs'
 *   tiers and the least slippage the server accepts, the residual
 *   cleanup's delay, and how far back history is read, which one
 *   template quotes. `loadHelpFigures` asks `GET /api/help-figures`,
 *   asking again until the server answers, keeps the answer, and writes
 *   each figure into its spans, templates included. Until then the spans
 *   stay empty and the table reads null; nothing stands in for it.
 *
 *   Runs the real module under jsdom against the markup index.html ships,
 *   with a scripted fetch answering what the server would: the table
 *   `src/help-figures.js` works out, here from the shipped files.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const UI = require("../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-up-scenario.json");
const BOUNDS = require("../app-config/app-defaults-for-user-configurable/setting-bounds.json");
const BOT = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");
const { duration } = require("../src/help-figures");
const { shippedFigures } = require("../scripts/build-manual-content");

const INDEX = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8",
);
const FIGURES = shippedFigures();
const ANSWER = { figures: FIGURES, botDefaults: BOT };

let mod;

before(async () => {
  mod = await import("../public/dashboard-help-figures.js");
});

/** Every `data-figure` span in index.html as `{name, text}`. */
function figureSpans() {
  return [
    ...INDEX.matchAll(/<span data-figure="([A-Za-z0-9]+)">([^<]*)<\/span>/g),
  ].map((m) => ({ name: m[1], text: m[2] }));
}

/** Put index.html's body into the document. */
function mountPage() {
  document.body.innerHTML = INDEX.slice(
    INDEX.indexOf("<body"),
    INDEX.lastIndexOf("</body>"),
  );
}

/** A scripted server: each request gets the next answer, the last repeating. */
function scriptedServer(answers) {
  const asked = [];
  const left = answers.slice();
  const fetchFn = async (url) => {
    asked.push(url);
    const next = left.length > 1 ? left.shift() : left[0];
    return next();
  };
  return { fetchFn, asked };
}

const answering = (body) => async () => ({ ok: true, json: async () => body });
const unavailable = async () => ({ ok: false, status: 503 });

describe("the page's figure spans", () => {
  it("each name a figure that exists, and hold no figure in the markup", () => {
    const spans = figureSpans();
    assert.ok(spans.length > 0);
    for (const { name, text } of spans) {
      assert.ok(Object.hasOwn(FIGURES, name), name);
      assert.equal(text, "", `${name} holds a figure in the markup`);
    }
  });

  it("leave the slippage dialogs no figure typed in", () => {
    /*-
     *  From the first dialog to the next overlay after the second: both
     *  dialogs whole, and nothing past them.
     */
    const start = INDEX.indexOf('id="slippageAbove5ConfirmModal"');
    const second = INDEX.indexOf('id="slippageAbove10TypeConfirmModal"');
    const next = INDEX.indexOf('<div class="modal-overlay', second);
    const dialogs = INDEX.slice(start, next === -1 ? undefined : next);
    assert.ok(start !== -1 && second > start, "both dialogs are in index.html");
    assert.doesNotMatch(dialogs, /\b(0\.1|5|10)%/);
  });
});

describe("loadHelpFigures", () => {
  it("holds nothing, and fills nothing, before the server answers", () => {
    mountPage();
    assert.equal(mod.helpFigures(), null);
    assert.equal(mod.resolvedBotDefaults(), null);
    for (const el of document.querySelectorAll("[data-figure]"))
      assert.equal(el.textContent, "");
  });

  it("asks again until the server answers, then writes every figure", async () => {
    mountPage();
    const server = scriptedServer([unavailable, answering(ANSWER)]);
    const lines = [];
    const seen = { unanswered: 0, answered: 0 };
    await mod.loadHelpFigures({
      fetchFn: server.fetchFn,
      askEveryMs: 1,
      warnFn: (format, ...args) => {
        let i = 0;
        lines.push(format.replace(/%[ds]/g, () => String(args[i++])));
      },
      onUnanswered: () => seen.unanswered++,
      onAnswered: () => seen.answered++,
    });
    assert.deepEqual(server.asked, ["/api/help-figures", "/api/help-figures"]);
    assert.deepEqual(seen, { unanswered: 1, answered: 1 });
    assert.deepEqual(lines, [
      "[lp-ranger] [help] attempt 1: asked the server for the help's figures; it answered HTTP 503 — asking again",
    ]);
    assert.deepEqual(mod.helpFigures(), FIGURES);
    assert.deepEqual(mod.resolvedBotDefaults(), BOT);

    const shown = (name) =>
      [...document.querySelectorAll(`[data-figure="${name}"]`)].map(
        (el) => el.textContent,
      );
    const expected = {
      slippageMinPct: String(BOUNDS.slippagePctToken0.min),
      slippageConfirmAbovePct: String(UI.slippageConfirmAbovePct),
      slippageTypedConfirmFromPct: String(UI.slippageTypedConfirmFromPct),
      residualCleanupDelay: duration(BOT.residualCleanup.delayMs / 1000),
    };
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(shown(name).length > 0, name);
      for (const t of shown(name)) assert.equal(t, value, name);
    }
  });

  it("fills a template's spans too, so every copy cloned from it has them", async () => {
    /*-
     *  A template's content is not part of the document a search walks.
     *  Left unfilled, the days note would read "up to  back".
     */
    mountPage();
    await mod.loadHelpFigures({
      fetchFn: scriptedServer([answering(ANSWER)]).fetchFn,
      askEveryMs: 1,
      warnFn: () => assert.fail("answered at once"),
      onUnanswered: () => {},
      onAnswered: () => {},
    });
    const note = document
      .getElementById("tplPnlBreakdownDaysNote")
      .content.cloneNode(true);
    const spans = [...note.querySelectorAll('[data-figure="historyLookback"]')];
    assert.ok(spans.length > 0, "the days note quotes the lookback");
    for (const el of spans)
      assert.equal(el.textContent, `${BOT.historyLookbackYears} years`);
  });

  it("writes the figures it is sent, not shipped ones", async () => {
    mountPage();
    const ours = { ...FIGURES, residualCleanupDelay: "42 minutes" };
    await mod.loadHelpFigures({
      fetchFn: scriptedServer([answering({ figures: ours, botDefaults: BOT })])
        .fetchFn,
      askEveryMs: 1,
      warnFn: () => assert.fail("answered at once"),
      onUnanswered: () => {},
      onAnswered: () => {},
    });
    for (const el of document.querySelectorAll(
      '[data-figure="residualCleanupDelay"]',
    ))
      assert.equal(el.textContent, "42 minutes");
  });
});
