"use strict";

/**
 * @file test/bot-start-up-shared.test.js
 * @description The headless bot (bot.js) starts the positions saved as
 *   managed through the server's start-up (src/server-auto-start.js), so
 *   the same rules hold without the dashboard: one active position per
 *   pool, and a saved position that cannot be managed comes off the list.
 *   test/server-auto-start.test.js tests those rules. bot.js runs the
 *   whole app as it loads, so this reads its source rather than running it.
 */

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs
  .readFileSync(path.join(__dirname, "..", "bot.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

it("starts its saved positions through the server's start-up", () => {
  assert.match(SRC, /require\("\.\/src\/server-auto-start"\)/);
  assert.match(SRC, /createAutoStartManagedPositions\(\{/);
});

it("starts no saved position by a loop of its own", () => {
  /*-
   *  With no saved positions, bot.js starts the one `POSITION_ID` names
   *  through `startBotLoop`; a saved position starts only in the start-up.
   */
  assert.doesNotMatch(SRC, /positionMgr\.startPosition\(/);
});
