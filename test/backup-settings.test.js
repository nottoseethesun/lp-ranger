"use strict";

/**
 * @file test/backup-settings.test.js
 * @description The safety copies of bot-config.json and the records file
 *   (`backUpSettings`, src/lib/bot-config-v2.js): each file is copied
 *   beside itself when it holds something, and a file that holds nothing,
 *   or is missing, leaves its copy as it was. A load makes the copies
 *   unless asked not to; the server asks not to, and makes them once it
 *   holds its port (test/wallet-file-settle.test.js checks where).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const {
  backUpSettings,
  botConfigPath,
  loadConfig,
} = require("../src/lib/bot-config-v2");
const { positionRecordsPath } = require("../src/lib/util/position-records");
const { createBot } = require("../src/bot/bot-interface");

const KEY =
  "pulsechain-0x1111111111111111111111111111111111111111-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-1";
const SETTINGS = JSON.stringify({
  global: {},
  positions: { [KEY]: { status: "running" } },
});
const RECORDS = JSON.stringify({
  positions: { [KEY]: { compoundedAmount0: "1" } },
});

/**
 * A folder holding the two files with the given text (null for none).
 * @param {string|null} settings
 * @param {string|null} records
 * @returns {string}
 */
function folderWith(settings, records) {
  const dir = makeTestTempFolder("backup-settings");
  if (settings !== null)
    fs.writeFileSync(path.join(dir, "bot-config.json"), settings);
  if (records !== null)
    fs.writeFileSync(path.join(dir, "position-records.json"), records);
  return dir;
}

/** The text of a file in `dir`, or null when there is none. */
const textOf = (dir, name) => {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};

describe("the settings' safety copies", () => {
  it("copies each file that holds something", () => {
    const dir = folderWith(SETTINGS, RECORDS);
    backUpSettings(dir);
    assert.equal(textOf(dir, "bot-config.backup.json"), SETTINGS);
    assert.equal(textOf(dir, "position-records.backup.json"), RECORDS);
  });

  it("leaves a copy as it was when its file holds nothing", () => {
    const dir = folderWith(
      JSON.stringify({ global: {}, positions: {} }),
      JSON.stringify({ positions: {} }),
    );
    fs.writeFileSync(path.join(dir, "bot-config.backup.json"), "kept");
    fs.writeFileSync(path.join(dir, "position-records.backup.json"), "kept");
    backUpSettings(dir);
    assert.equal(textOf(dir, "bot-config.backup.json"), "kept");
    assert.equal(textOf(dir, "position-records.backup.json"), "kept");
  });

  it("makes no copy, and does not throw, when the files are missing", () => {
    const dir = folderWith(null, null);
    backUpSettings(dir);
    assert.equal(textOf(dir, "bot-config.backup.json"), null);
    assert.equal(textOf(dir, "position-records.backup.json"), null);
  });

  it("a load makes them, unless asked not to", () => {
    const skipped = folderWith(SETTINGS, RECORDS);
    loadConfig(skipped, true);
    assert.equal(textOf(skipped, "bot-config.backup.json"), null);
    assert.equal(textOf(skipped, "position-records.backup.json"), null);
    const made = folderWith(SETTINGS, RECORDS);
    loadConfig(made);
    assert.equal(textOf(made, "bot-config.backup.json"), SETTINGS);
    assert.equal(textOf(made, "position-records.backup.json"), RECORDS);
  });

  it("the bot built for the server makes none; built without the skip, it makes them", () => {
    /*-
     *  Building the bot reads the price library's settings with a load of
     *  its own. The server passes `skipBackups`, so a second start, which
     *  fails on the port, leaves the running server's copies alone. Under
     *  `node --test` the files are in this process's own folders.
     */
    const files = [botConfigPath(), positionRecordsPath()];
    const backupOf = (file) => file.replace(".json", ".backup.json");
    const copies = () => files.map((f) => fs.readFileSync(backupOf(f), "utf8"));
    fs.mkdirSync(path.dirname(files[0]), { recursive: true });
    fs.mkdirSync(path.dirname(files[1]), { recursive: true });
    fs.writeFileSync(files[0], SETTINGS);
    fs.writeFileSync(files[1], RECORDS);
    for (const file of files) fs.writeFileSync(backupOf(file), "kept");
    const opts = {
      diskConfig: { global: {}, positions: {} },
      walletManager: { getAddress: () => null },
    };

    createBot({ ...opts, skipBackups: true });
    assert.deepEqual(copies(), ["kept", "kept"]);

    createBot(opts);
    assert.deepEqual(copies(), [SETTINGS, RECORDS]);
  });
});
