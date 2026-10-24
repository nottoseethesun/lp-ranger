"use strict";

/**
 * @file test/il-guard-message-figures.test.js
 * @description The Impermanent Loss Guard's Telegram alert quotes the
 *   retry ceiling and the gas share the bot runs on, an operator's
 *   override included.
 *
 *   Both are read from bot-config-defaults.json with the operator's copy
 *   on top. The copy here moves each off its shipped value, three days
 *   and 0.8% rather than a week and 0.5%, so a word like "a week" written
 *   into the message fails. Kept apart from `il-guard.test.js`, whose
 *   cases check the shipped defaults themselves.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const SETTINGS_DIR = makeTestTempFolder("il-guard-message-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "bot-config-defaults.json"),
  JSON.stringify({
    ilGuardRetry: { maxMs: 3 * 24 * 3_600_000 },
    rebalanceGasDeferPct: 0.8,
  }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { _ilGuardMessage } = require("../src/lib/il-guard");

describe("the Telegram message", () => {
  it("quotes the retry ceiling and the gas share the bot runs on", () => {
    const m = _ilGuardMessage(
      {
        projectedValueUsd: 2788.65,
        holdValueUsd: 3947.23,
        guardPct: 50,
        floorUsd: 1973.62,
        lossPct: 29.4,
        nextCheckHours: "4",
      },
      { link: true },
    );
    assert.ok(m.includes("up to 3 days."), m);
    assert.ok(m.includes("more than 0.8% of"), m);
  });
});
