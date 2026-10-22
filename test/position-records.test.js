"use strict";

/**
 * @file test/position-records.test.js
 * @description The split of each position's slot between bot-config.json,
 *   which keeps the operator's settings and the position's status, and
 *   app-data/position-records.json, which keeps the bot's records
 *   (src/position-records.js). In memory a slot holds both; `saveConfig`
 *   writes each key to its own file and `loadConfig` merges them back.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");
const { loadConfig, saveConfig } = require("../src/bot-config-v2");
const { RECORD_POSITION_KEYS } = require("../src/bot-config-keys");
const { positionRecordsPath } = require("../src/position-records");

const KEY =
  "pulsechain-0x1111111111111111111111111111111111111111-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-101";

/** A slot holding settings and records, as the bot keeps one in memory. */
const slot = () => ({
  status: "running",
  slippagePctToken0: 1,
  hodlBaseline: { entryValue: 100, hodlAmount0: 1, hodlAmount1: 2 },
  residuals: { "0xPool": { token0: "5", token1: "6" } },
  lastCompoundAt: "2026-10-19T00:00:00.000Z",
});

/** The JSON file at `file`. */
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("saving a position's slot", () => {
  it("writes its settings to bot-config.json and its records to the records file", () => {
    const dir = makeTestTempFolder("records");
    saveConfig({ global: {}, positions: { [KEY]: slot() } }, dir);
    const settings = read(path.join(dir, "bot-config.json")).positions[KEY];
    assert.deepEqual(Object.keys(settings).sort(), [
      "slippagePctToken0",
      "status",
    ]);
    const records = read(positionRecordsPath(dir)).positions[KEY];
    assert.deepEqual(Object.keys(records).sort(), [
      "hodlBaseline",
      "lastCompoundAt",
      "residuals",
    ]);
    for (const k of Object.keys(records))
      assert.ok(RECORD_POSITION_KEYS.includes(k), k);
  });

  it("leaves the slot in memory whole", () => {
    const dir = makeTestTempFolder("records");
    const cfg = { global: {}, positions: { [KEY]: slot() } };
    saveConfig(cfg, dir);
    assert.deepEqual(cfg.positions[KEY], slot());
  });
});

describe("loading a position's slot", () => {
  it("puts its records back beside its settings", () => {
    const dir = makeTestTempFolder("records");
    saveConfig({ global: {}, positions: { [KEY]: slot() } }, dir);
    assert.deepEqual(loadConfig(dir).positions[KEY], slot());
  });

  it("keeps a managed position whose settings are its status alone", () => {
    /*-
     *  A slot holding only `status: "running"` is the phantom signature
     *  the load purges. Here its records are in the records file, so it
     *  is a real position, and the merge comes before the purge.
     */
    const dir = makeTestTempFolder("records");
    const { slippagePctToken0: _ignored, ...onlyStatus } = slot();
    saveConfig({ global: {}, positions: { [KEY]: onlyStatus } }, dir);
    assert.deepEqual(read(path.join(dir, "bot-config.json")).positions[KEY], {
      status: "running",
    });
    assert.equal(loadConfig(dir).positions[KEY]?.status, "running");
  });

  it("still purges a phantom, which has no records either", () => {
    const dir = makeTestTempFolder("records");
    saveConfig(
      { global: {}, positions: { [KEY]: { status: "running" } } },
      dir,
    );
    assert.equal(loadConfig(dir).positions[KEY], undefined);
  });

  it("takes the records file's record over one left in bot-config.json", () => {
    const dir = makeTestTempFolder("records");
    fs.writeFileSync(
      path.join(dir, "bot-config.json"),
      JSON.stringify({
        global: {},
        positions: { [KEY]: { status: "running", lastCompoundAt: "old" } },
      }),
    );
    fs.writeFileSync(
      positionRecordsPath(dir),
      JSON.stringify({ positions: { [KEY]: { lastCompoundAt: "new" } } }),
    );
    assert.equal(loadConfig(dir).positions[KEY].lastCompoundAt, "new");
  });

  it("keeps the records when bot-config.json is gone", () => {
    const dir = makeTestTempFolder("records");
    saveConfig({ global: {}, positions: { [KEY]: slot() } }, dir);
    fs.unlinkSync(path.join(dir, "bot-config.json"));
    const back = loadConfig(dir).positions[KEY];
    assert.deepEqual(back.hodlBaseline, slot().hodlBaseline);
    assert.equal(back.status, undefined, "no settings, so not managed");
  });

  it("copies the records file beside itself", () => {
    const dir = makeTestTempFolder("records");
    saveConfig({ global: {}, positions: { [KEY]: slot() } }, dir);
    loadConfig(dir);
    assert.deepEqual(
      read(path.join(dir, "position-records.backup.json")),
      read(positionRecordsPath(dir)),
    );
  });

  it("copies bot-config.json beside itself", () => {
    const dir = makeTestTempFolder("records");
    saveConfig({ global: {}, positions: { [KEY]: slot() } }, dir);
    loadConfig(dir);
    assert.deepEqual(
      read(path.join(dir, "bot-config.backup.json")),
      read(path.join(dir, "bot-config.json")),
    );
  });

  it("copies neither file when the caller skips the backups", () => {
    const dir = makeTestTempFolder("records");
    saveConfig({ global: {}, positions: { [KEY]: slot() } }, dir);
    const cfg = loadConfig(dir, true);
    assert.deepEqual(cfg.positions[KEY], slot(), "the load itself is whole");
    assert.equal(
      fs.existsSync(path.join(dir, "bot-config.backup.json")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(dir, "position-records.backup.json")),
      false,
    );
  });
});
