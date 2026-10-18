"use strict";

/**
 * @file test/per-day-pnl-help.test.js
 * @description The two circle-i help entries on the Per-Day P&L card,
 *   checked against the real `public/index.html` markup.
 *
 *   Both were hover-only popovers, which no touch device can reach.
 *   They are now click-to-dialog buttons using the project's canonical
 *   circle-i (`9mm-pos-mgr-il-info-btn` plus a literal "i").
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { shippedFigures } = require("../scripts/build-manual-content");

let PARAM_HELP;

const HTML = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8",
);
const BODY = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));

before(async () => {
  const { buildParamHelp } = await import("../public/param-help-content.js");
  PARAM_HELP = buildParamHelp(shippedFigures());
});

beforeEach(() => {
  document.body.innerHTML = BODY;
});

/** The Per-Day P&L card element. */
function card() {
  const title = [...document.querySelectorAll(".card-title")].find((el) =>
    el.textContent.includes("Per-Day P&L"),
  );
  assert.ok(title, "Per-Day P&L card title not found");
  return title;
}

describe("Per-Day P&L — the table-level circle-i", () => {
  it("uses the canonical circle-i, not the grey info dot", () => {
    /*- The project's circle-i is `9mm-pos-mgr-il-info-btn` with a
     *  literal "i" — the hover-only `info-dot` reads as a different
     *  control and cannot be opened by touch. */
    const icon = card().querySelector("[data-param-help]");
    assert.ok(icon, "expected a click-to-dialog circle-i");
    assert.ok(icon.className.includes("il-info-btn"), icon.className);
    assert.equal(icon.textContent, "i");
    assert.equal(icon.dataset.paramHelp, "perDayPnl");
  });

  it("sits last in the title so it right-justifies", () => {
    /*- `.card-title` is `display:flex; justify-content:space-between`,
     *  so a middle child floats mid-row instead of hugging the edge. */
    const title = card();
    assert.equal(
      title.lastElementChild.dataset.paramHelp,
      "perDayPnl",
      "the icon must be the last child",
    );
  });

  it("explains each of the three value columns", () => {
    /*- The columns a reader cannot otherwise tell apart: two of them
     *  looked identical until Profit was corrected. */
    const headings = PARAM_HELP.perDayPnl.sections.map((s) => s.heading);
    for (const h of ["Price P&L", "Profit", "Net P&L"])
      assert.ok(headings.includes(h), `no section for ${h}`);
  });

  it("explains that empty days are omitted", () => {
    /*- The reason the icon exists: with blank days no longer padded in,
     *  the gaps have to be accounted for. */
    const entry = PARAM_HELP.perDayPnl;
    assert.ok(entry, "perDayPnl help content missing");
    const all = entry.sections.map((s) => s.body).join(" ");
    assert.match(all, /omitted/i);
  });

  it("stays within its word budget", () => {
    /*- The original three sections fitted in 120 words.  Price P&L,
     *  Profit and Net P&L were added after, plus a section on why
     *  Profit and Net P&L answer different questions — the distinction
     *  that caused the confusion in the first place.  Budget raised to
     *  520 on the user's instruction; it sits around 370. */
    const entry = PARAM_HELP.perDayPnl;
    const words = entry.sections
      .map((s) => s.body)
      .join(" ")
      .replace(/<[^>]+>|&[a-z]+;/g, " ")
      .trim()
      .split(/\s+/).length;
    assert.ok(words <= 520, `help copy is ${words} words`);
  });
});

describe("Per-Day P&L — the In/Out column circle-i", () => {
  it("is a click-to-dialog on the column header", () => {
    const th = [...document.querySelectorAll("th")].find((el) =>
      el.textContent.includes("In/Out"),
    );
    const icon = th.querySelector("[data-param-help]");
    assert.ok(icon, "In/Out column needs a circle-i");
    assert.equal(icon.dataset.paramHelp, "perDayInOut");
    assert.ok(icon.className.includes("il-info-btn"));
  });

  it("has help content behind it", () => {
    const entry = PARAM_HELP.perDayInOut;
    assert.ok(entry?.title);
    assert.ok(entry.sections?.length > 0);
  });
});

describe("no hover-only popovers remain on this card", () => {
  it("neither icon relies on hover", () => {
    /*- Both were `info-wrap` + `info-popover`, which is CSS-hover-only
     *  and unreachable on a phone. */
    const row = document.getElementById("historyRow");
    const hoverOnly = row.querySelectorAll('[class*="info-popover"]');
    assert.equal(hoverOnly.length, 0, "a hover-only popover is still here");
  });
});
