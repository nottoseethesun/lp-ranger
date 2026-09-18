/**
 * @file test/bot-config-v2-retired-keys.test.js
 * @description `saveConfig` drops the keys the app has retired.
 *
 *   Split from bot-config-v2.test.js for the 500-line max-lines cap.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadConfig, saveConfig } = require("../src/bot-config-v2");
const {
  POSITION_KEYS,
  RETIRED_POSITION_KEYS,
} = require("../src/bot-config-keys");

/** Create a temp directory for each test. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bcv2-retired-"));
}

describe("saveConfig drops retired keys", () => {
  /*-
   *  Every entry stored a dollar total for compounded fees. The app
   *  keeps the coins now and prices them where they are shown, so
   *  nothing reads these — they are dead weight in a file operators
   *  open and read.
   */
  const KEY = "pulsechain-0xWALLET-0xCONTRACT-100";

  /*-
   *  Save a slot carrying every retired key, then read it back.
   *  `slippagePct` stands in for whatever real content a slot has:
   *  without it the stripped slot is status-only, which the phantom
   *  purge removes on load — a different mechanism, and not the one
   *  under test here.
   */
  function saveAndReload(extra) {
    const dir = tmpDir();
    const slot = { status: "running", slippagePct: 0.75 };
    for (const k of RETIRED_POSITION_KEYS) slot[k] = 1;
    Object.assign(slot, extra);
    saveConfig({ global: {}, positions: { [KEY]: slot } }, dir);
    const loaded = loadConfig(dir);
    fs.rmSync(dir, { recursive: true });
    return loaded.positions[KEY];
  }

  it("writes none of them to disk", () => {
    const slot = saveAndReload({});
    assert.ok(slot, "the position must survive the save");
    for (const k of RETIRED_POSITION_KEYS)
      assert.equal(slot[k], undefined, `${k} should not survive the save`);
  });

  it("keeps the coins and the settings around them", () => {
    /*-
     *  The strip is by name, so a key whose name merely resembles a
     *  retired one must be untouched — losing the coins here would
     *  cost the very figure the retired keys were replaced by.
     */
    const slot = saveAndReload({
      compoundedAmount0: 12.5,
      compoundedAmount1: 3,
      nftCompoundedAmountsByTokenId: { 100: { amount0: 4, amount1: 1 } },
      autoCompoundThresholdUsd: 5,
    });
    assert.equal(slot.compoundedAmount0, 12.5);
    assert.equal(slot.compoundedAmount1, 3);
    assert.deepEqual(slot.nftCompoundedAmountsByTokenId, {
      100: { amount0: 4, amount1: 1 },
    });
    assert.equal(slot.autoCompoundThresholdUsd, 5);
    assert.equal(slot.status, "running");
  });

  it("names only keys that POST /api/config no longer accepts", () => {
    /*-
     *  A retired key that is still settable would be deleted on every
     *  save right after the operator set it.
     */
    for (const k of RETIRED_POSITION_KEYS)
      assert.ok(!POSITION_KEYS.includes(k), `${k} is still a live key`);
  });
});
