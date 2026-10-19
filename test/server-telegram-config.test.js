"use strict";

/**
 * @file test/server-telegram-config.test.js
 * @description POST /api/telegram/config holds the alert choices to the
 *   rule the settings check holds the saved set to at startup
 *   (`alertChoicesProblem`, src/telegram-notifications/telegram-events.js)
 *   before it saves anything. A set the next start would refuse is
 *   refused here instead, and the bot token sent with it is not saved
 *   either. GET /api/telegram/config quotes the Position Balanced band
 *   as configured. Driven through the route's own handlers, with the
 *   encrypted key store and the operator's settings folder redirected
 *   into test folders; the band there is moved off its shipped 2.5.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const KEYS_FILE = path.join(makeTestTempFolder("tg-route"), "api-keys.json");
process.env.API_KEYS_FILE_PATH = KEYS_FILE;

// A band whose percent, rebuilt from a fraction, would read 7.000000000000001.
const BAND_PCT = 7;
const USER_DIR = makeTestTempFolder("tg-route-settings");
fs.writeFileSync(
  path.join(USER_DIR, "bot-config-defaults.json"),
  JSON.stringify({ positionBalancedBandPct: BAND_PCT }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = USER_DIR;

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createTelegramHandlers,
} = require("../src/telegram-notifications/server-telegram");
const telegram = require("../src/telegram-notifications/telegram");
const {
  EVENT_DEFAULTS,
} = require("../src/telegram-notifications/telegram-events");

let diskConfig, saves, answer, handlers;

beforeEach(() => {
  diskConfig = { global: { telegramEvents: { ...EVENT_DEFAULTS } } };
  saves = 0;
  answer = null;
  handlers = createTelegramHandlers({
    readJsonBody: async (req) => req.body,
    jsonResponse: (_res, status, body) => {
      answer = { status, body };
    },
    getSessionPassword: () => "session-password",
    diskConfig,
    saveConfig: () => {
      saves++;
    },
  });
});

/** Send a save with this body and return the route's answer. */
async function save(body) {
  await handlers.handleTelegramConfig({ body }, {});
  return answer;
}

describe("POST /api/telegram/config", () => {
  it("refuses an alert LP Ranger does not send, saving nothing", async () => {
    const { status, body } = await save({
      botToken: "123:abc",
      enabledEvents: { oorTimeout: true, noSuchAlert: true },
    });
    assert.equal(status, 400);
    assert.match(body.error, /noSuchAlert/);
    assert.equal(fs.existsSync(KEYS_FILE), false, "no token saved");
    assert.equal(saves, 0);
    assert.deepEqual(diskConfig.global.telegramEvents, EVENT_DEFAULTS);
  });

  it("refuses a choice that is not true or false", async () => {
    const { status, body } = await save({
      enabledEvents: { oorTimeout: "yes" },
    });
    assert.equal(status, 400);
    assert.match(body.error, /oorTimeout must be true or false/);
    assert.equal(saves, 0);
  });

  it("saves choices the startup check accepts", async () => {
    const chosen = { ...EVENT_DEFAULTS, rebalanceSuccess: true };
    const { status } = await save({ enabledEvents: chosen });
    assert.equal(status, 200);
    assert.equal(saves, 1);
    assert.deepEqual(diskConfig.global.telegramEvents, chosen);
    assert.equal(telegram.getEnabledEvents().rebalanceSuccess, true);
  });

  it("keeps the saved choices when a save leaves them out", async () => {
    const before = { ...diskConfig.global.telegramEvents };
    const { status } = await save({});
    assert.equal(status, 200);
    assert.equal(saves, 0);
    assert.deepEqual(diskConfig.global.telegramEvents, before);
  });
});

describe("GET /api/telegram/config", () => {
  it("quotes the Position Balanced band exactly as configured", () => {
    handlers.handleTelegramStatus({}, {});
    assert.equal(answer.status, 200);
    assert.equal(answer.body.balancedThresholdPct, BAND_PCT);
  });
});
