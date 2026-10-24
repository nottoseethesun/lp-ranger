"use strict";

/**
 * @file test/runtime-timings-override.test.js
 * @description The bot's retry, follow-up and retire timings come from
 *   app-runtime.json, an operator's override included, not from figures
 *   written into the code.
 *
 *   Each value is moved off its shipped default here, in an override
 *   directory of the test's own, so a consumer that kept a literal
 *   would fail rather than pass by coincidence. `LP_RANGER_USER_CONFIG_DIR`
 *   is read when `src/lib/load-merged-defaults.js` loads, so it is set before
 *   anything under `src/lib/` is required.
 *
 *   The drained-position retire is driven through its own function. The
 *   bot loop's three are inside `startBotLoop`, which no test here can
 *   start, so the last case pins that the loop reads them from config.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-timings-"));
fs.writeFileSync(
  path.join(_USER_DIR, "app-runtime.json"),
  JSON.stringify({ retire: { drainedAfterMs: 120000 } }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { checkZeroLiquidity } = require("../src/lib/bot-cycle-drain");

describe("a drained position's retire", () => {
  /** Deps for a drained position, with no rebalance under way. */
  const drained = (state) => ({
    position: { tokenId: "1", liquidity: "0", token0: "0xA", token1: "0xB" },
    _botState: state,
  });

  it("waits retire.drainedAfterMs", () => {
    const state = { drainedSince: Date.now() - 60000 };
    const r = checkZeroLiquidity(drained(state));
    assert.deepEqual(r, { rebalanced: false });
  });

  it("retires once retire.drainedAfterMs has passed", () => {
    const state = { drainedSince: Date.now() - 121000 };
    const r = checkZeroLiquidity(drained(state));
    assert.equal(r?.retired, true);
  });
});

describe("the bot loop's own timings", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "lib", "bot-loop.js"),
    "utf8",
  );

  it("are read from config", () => {
    assert.match(src, /midwayRetryCount >= config\.MIDWAY_RETRY_LIMIT/);
    assert.match(src, /followUpMs: config\.POLL_AFTER_ACTION_MS,/);
    assert.match(src, /\}, config\.LIFETIME_RESCAN_CHECK_MS\);/);
  });
});
