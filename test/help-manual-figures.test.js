"use strict";

/**
 * @file test/help-manual-figures.test.js
 * @description The User Manual on disk states the figures the shipped
 *   files give, every one in a span the served copy refills.
 *
 *   The build rewrites each span from the shipped files, so a span that
 *   disagrees means the manual was not rebuilt after a setting changed,
 *   or names a figure the table lacks. Kept apart from
 *   `help-figures.test.js`, whose cases read a copy of the shipped files
 *   with their values moved.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { shippedFigures } = require("../scripts/build-manual-content");

describe("the User Manual", () => {
  it("states every figure it quotes as the table has it", () => {
    const figures = shippedFigures();
    const html = fs.readFileSync(
      path.join(__dirname, "..", "public", "help-and-user-manual.html"),
      "utf8",
    );
    const spans = [
      ...html.matchAll(/<span data-figure="([A-Za-z0-9]+)">([^<]*)<\/span>/g),
    ];
    assert.ok(spans.length > 0);
    for (const [, name, text] of spans) {
      assert.ok(Object.hasOwn(figures, name), `${name} is not a figure`);
      assert.equal(text, figures[name], name);
    }
    assert.doesNotMatch(html, /\{\{figure:/);
  });
});
