"use strict";

/**
 * @file test/dashboard-param-help-before-figures.test.js
 * @description A help dialog opened before the server has sent the help's
 *   figures does not open.
 *
 *   The dialogs state the figures this install runs on, which the
 *   dashboard asks the server for at startup. Until they arrive there is
 *   nothing true to show, and nothing stands in for them, so
 *   `showParamHelp` opens nothing and says why in the console. A file of
 *   its own, because the figures, once loaded, stay loaded for the life
 *   of the page.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let logMod;

before(async () => {
  logMod = await import("../src/client/web/dashboard-log.js");
  mod = await import("../src/client/web/dashboard-param-help.js");
  document.body.innerHTML = `
    <template id="tplParamHelpModal">
      <div class="9mm-pos-mgr-modal">
        <h3 data-tpl="title">&nbsp;</h3>
        <p data-tpl="subtitle" hidden></p>
        <div data-tpl="body"></div>
      </div>
    </template>
    <template id="tplParamHelpSection">
      <h4 data-tpl="heading">&nbsp;</h4>
      <p data-tpl="body"></p>
    </template>
  `;
});

describe("showParamHelp before the help's figures arrive", () => {
  it("opens nothing, and says why", (t) => {
    const warned = [];
    t.mock.method(logMod.log, "warn", (...args) => warned.push(args));
    mod.showParamHelp("inSlipToken0");
    assert.equal(document.getElementById("9mm-param-help-modal"), null);
    assert.equal(warned.length, 1);
    assert.match(warned[0][0], /have not arrived from the server yet/);
    assert.equal(warned[0][1], "inSlipToken0");
  });
});
