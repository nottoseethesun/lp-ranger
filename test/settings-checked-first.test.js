"use strict";

/**
 * @file test/settings-checked-first.test.js
 * @description Both programs check every setting before they load the
 *   app's settings or the bot: src/server.js and src/bot.js call
 *   `refuseToStartOnBadSettings()` (src/lib/settings-check.js) before they
 *   load src/lib/config.js or any of the bot's modules beyond its help
 *   text. Only the log file's own settings (logging.json) are read before
 *   it, so the log captures the startup. That call is the one refusal of a dashboard
 *   setting written outside its rule: the readers of the dashboard
 *   settings (src/lib/ui-defaults.js) keep the shipped value for one
 *   rather than stop the app. So both programs read those settings right
 *   after the check, and keep them: an edit made while one runs waits for
 *   the next start, and its check. Each entry point runs the whole app as
 *   it loads, so this reads their source rather than running them.
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
      const config = src.search(/require\(["']\.\/lib\/config(\.js)?["']\)/);
      assert.ok(at >= 0 && config > at, "config.js loads after the check");
    });

    it("reads and keeps the dashboard settings right after the check", () => {
      /*-
       *  Read as the program starts, the file the check has just passed
       *  is the one kept for the life of the process, so an edit made
       *  while it runs waits for the next start and its check.
       */
      const read = src.indexOf('require("./lib/ui-defaults").readUiDefaults()');
      const built = src.search(/createBot\(/);
      assert.ok(at >= 0 && read > at, "the read comes after the check");
      assert.ok(built > read, "the read comes before the bot is built");
    });

    it("checks before it loads a bot module, its help text aside", () => {
      /*-
       *  Any module under src/bot/, in a subfolder or not, named with its
       *  `.js` or without, in either quote.
       */
      const firstBot = [
        ...src.matchAll(/require\(["']\.\/bot\/([\w\-./]+?)(?:\.js)?["']\)/g),
      ].find((m) => m[1] !== "bot-cli-help");
      assert.ok(firstBot, "it loads a bot module");
      assert.ok(
        at >= 0 && firstBot.index > at,
        `${firstBot[1]} loads after the check`,
      );
    });
  });
}
