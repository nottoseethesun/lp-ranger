"use strict";

/**
 * @file test/activity-log-help.test.js
 * @description The help on the Activity Log's prices is written once, in
 *   public/shared-help-content.json (`activityLogPrices`), and read by
 *   both places that show it: the Activity Log's circle-i dialog, and the
 *   User Manual's Activity Log section, which the manual's build renders
 *   it into. The entry has no manual heading of its own, since it is part
 *   of a section the manual writes by hand, so the build renders its
 *   sections alone. That the region holds what the build writes is
 *   pinned for every entry by test/il-guard.test.js.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  renderEntry,
  shippedFigures,
} = require("../scripts/build-manual-content");
const { fillEntryFigures, spanFigureTokens } = require("../src/help-figures");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const shared = () => JSON.parse(read("public/shared-help-content.json"));

/** The dialogs' help, built as the dashboard builds it. */
async function paramHelp() {
  const mod = await import("../public/param-help-content.js");
  return mod.buildParamHelp(shippedFigures());
}

describe("the Activity Log's help on prices", () => {
  it("is in the Activity Log's circle-i dialog, after its own section", async () => {
    const help = await paramHelp();
    const prices = fillEntryFigures(
      shared().activityLogPrices,
      shippedFigures(),
    );
    const sections = help.activityLog.sections;
    assert.equal(sections[0].heading, "Detail availability");
    assert.deepEqual(sections.slice(1), prices.sections);
    assert.match(prices.sections[0].body, /Historical/);
    assert.match(prices.sections[0].body, /Current/);
    assert.match(prices.sections[0].body, /\$usd/);
  });

  it("is in the manual's Activity Log section, as the JSON has it", () => {
    const html = read("public/help-and-user-manual.html");
    const start = html.indexOf('<h2 id="activity-log">');
    const end = html.indexOf("<h2 ", start + 1);
    assert.ok(start !== -1 && end !== -1, "the manual has the section");
    const section = html.slice(start, end);
    const prices = fillEntryFigures(
      shared().activityLogPrices,
      shippedFigures(),
      spanFigureTokens,
    );
    for (const s of prices.sections) {
      assert.ok(section.includes(`<h3>${s.heading}</h3>`), s.heading);
      assert.ok(section.includes(`<p>${s.body}</p>`), s.heading);
    }
  });
});

describe("renderEntry", () => {
  const SECTIONS = [{ heading: "A heading", body: "A body." }];

  it("renders an entry with no manual heading as its sections alone", () => {
    const out = renderEntry({ sections: SECTIONS });
    assert.ok(!out.includes("<h2"), out);
    assert.match(out, /<h3>A heading<\/h3>\n {2}<p>A body\.<\/p>/);
  });

  it("opens an entry with a manual heading with an h2 at its anchor", () => {
    const out = renderEntry({
      manualHeading: "A Section",
      manualAnchor: "a-section",
      sections: SECTIONS,
    });
    assert.ok(out.startsWith('  <h2 id="a-section">A Section</h2>\n'), out);
    assert.match(out, /<h3>A heading<\/h3>/);
  });
});
