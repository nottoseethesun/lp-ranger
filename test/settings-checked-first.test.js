"use strict";

/**
 * @file test/settings-checked-first.test.js
 * @description Both programs check every setting before they read one:
 *   src/server.js and src/bot.js call `refuseToStartOnBadSettings()`
 *   (src/lib/settings-check.js) before they load src/lib/config.js or any
 *   of the bot's modules beyond its help text. That call is the one
 *   refusal of a dashboard setting written outside its rule: the readers
 *   of the dashboard settings (src/lib/ui-defaults.js) keep the shipped
 *   value for one rather than stop the app. Each entry point runs the whole
 *   app as it loads, so this reads their source rather than running them.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CHECK = 'require("./lib/settings-check").refuseToStartOnBadSettings()';

/** The source of `file` under src/, its comments removed. */
const source = (file) =>
  fs
    .readFileSync(path.join(__dirname, "..", "src", file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

for (const file of ["server.js", "bot.js"]) {
  describe(`src/${file}`, () => {
    const src = source(file);
    const at = src.indexOf(CHECK);

    it("checks every setting as it starts", () => {
      assert.ok(at >= 0, "it calls refuseToStartOnBadSettings()");
    });

    it("checks before it loads config.js", () => {
      const config = src.indexOf('require("./lib/config")');
      assert.ok(at >= 0 && config > at, "config.js loads after the check");
    });

    it("checks before it loads a bot module, its help text aside", () => {
      const firstBot = [
        ...src.matchAll(/require\("\.\/bot\/([\w-]+)"\)/g),
      ].find((m) => m[1] !== "bot-cli-help");
      assert.ok(firstBot, "it loads a bot module");
      assert.ok(
        at >= 0 && firstBot.index > at,
        `${firstBot[1]} loads after the check`,
      );
    });
  });
}
