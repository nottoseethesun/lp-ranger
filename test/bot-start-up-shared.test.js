"use strict";

/**
 * @file test/bot-start-up-shared.test.js
 * @description The headless bot (src/bot.js) builds its bot the one way the
 *   server builds it, through the bot's interface (`createBot`,
 *   src/bot/bot-interface.js), and starts the positions saved as managed
 *   through the same start-up (src/bot/auto-start.js). So the same rules
 *   hold without the dashboard: one active position per pool, a saved
 *   position that cannot be managed comes off the list, and each pool's
 *   count of today's rebalances is read from the rebalance log as the bot
 *   starts (Bug #19: the headless bot built its parts itself and skipped
 *   that count). test/server-auto-start.test.js tests the start-up's
 *   rules and test/bot-parts.test.js the count. bot.js runs the whole app
 *   as it loads, so this reads its source rather than running it.
 */

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs
  .readFileSync(path.join(__dirname, "..", "src", "bot.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

it("builds its bot through the bot's interface, as the server does", () => {
  assert.match(SRC, /require\("\.\/bot\/bot-interface"\)/);
  assert.match(SRC, /createBot\(\{/);
});

it("builds none of the bot's parts itself", () => {
  for (const part of [
    /createPositionManager/,
    /createRebalanceLock/,
    /readPriceCacheSettings/,
    /seedPoolDailyCounts/,
    /sendTx/,
  ])
    assert.doesNotMatch(SRC, part);
});

it("starts its saved positions through the server's start-up", () => {
  assert.match(SRC, /\.startManagedPositions\(\)/);
  assert.doesNotMatch(SRC, /createAutoStartManagedPositions/);
});

it("starts no saved position by a loop of its own", () => {
  /*-
   *  With no saved positions, bot.js starts the one `POSITION_ID` names
   *  through `startBotLoop`; a saved position starts only in the start-up.
   */
  assert.doesNotMatch(SRC, /\.startPosition\(/);
});
