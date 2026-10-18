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
 *   is read when `src/load-merged-defaults.js` loads, so it is set before
 *   anything under `src/` is required.
 *
 *   The swap backoff and the drained-position retire are driven through
 *   their own functions. The bot loop's three are inside `startBotLoop`,
 *   which no test here can start, so the last case pins that the loop
 *   reads them from config.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-timings-"));
fs.writeFileSync(
  path.join(_USER_DIR, "app-runtime.json"),
  JSON.stringify({
    tx: { swapBackoffBaseMs: 7000, swapBackoffMaxMs: 20000 },
    retire: { drainedAfterMs: 120000 },
  }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { _activateSwapBackoff } = require("../src/bot-cycle-backoff");
const { checkZeroLiquidity } = require("../src/bot-cycle-drain");

describe("the swap backoff", () => {
  it("waits tx.swapBackoffBaseMs first", () => {
    const state = {};
    _activateSwapBackoff(state, null);
    assert.equal(state.swapBackoffMs, 7000);
  });

  it("doubles up to tx.swapBackoffMaxMs, and no further", () => {
    const state = { swapBackoffMs: 14000, swapBackoffAttempts: 1 };
    _activateSwapBackoff(state, null);
    assert.equal(state.swapBackoffMs, 20000);
  });
});

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
    path.join(__dirname, "..", "src", "bot-loop.js"),
    "utf8",
  );

  it("are read from config", () => {
    assert.match(src, /midwayRetryCount >= config\.MIDWAY_RETRY_LIMIT/);
    assert.match(src, /followUpMs: config\.POLL_AFTER_ACTION_MS,/);
    assert.match(src, /\}, config\.LIFETIME_RESCAN_CHECK_MS\);/);
  });
});
