"use strict";

/**
 * @file test/position-records.test.js
 * @description The split of each position's slot between bot-config.json,
 *   which keeps the operator's settings and the position's status, and
 *   app-data/position-records.json, which keeps the bot's records
 *   (src/lib/util/position-records.js). In memory a slot holds both; `saveConfig`
 *   writes each key to its own file and `loadConfig` merges them back.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const {
  loadConfig,
  saveConfig,
  readGlobalSetting,
} = require("../src/lib/bot-config-v2");
const { RECORD_POSITION_KEYS } = require("../src/lib/bot-config-keys");
const {
  positionRecordsPath,
  readPositionRecords,
} = require("../src/lib/util/position-records");
const { handleFileProblemsWith } = require("../src/lib/file-problem");
const { _setSinkForTests } = require("../src/lib/log");

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

/*-
 *  A settings or records file that is not valid JSON, or cannot be read,
 *  is told as every file failure is, with its cause, which stops LP Ranger
 *  (the user's ruling, 2026-11-27: "LP Ranger always exits gracefully ...
 *  if any json file is not valid"). The handler a program sets, its stop,
 *  and the log are stand-ins here, put back after each case.
 */
describe("a settings or records file LP Ranger cannot use", () => {
  /**
   * Run `fn` with the told failures collected and the log kept quiet.
   * @param {() => void} fn
   * @returns {string[]}  The words of each failure told.
   */
  function tellsDuring(fn) {
    const told = [];
    handleFileProblemsWith((words) => told.push(words));
    const restoreLog = _setSinkForTests({
      log: () => {},
      warn: () => {},
      error: () => {},
    });
    try {
      fn();
    } finally {
      handleFileProblemsWith(null);
      restoreLog();
    }
    return told;
  }

  it("tells a records file that is not valid JSON, and reads no records", () => {
    const dir = makeTestTempFolder("records");
    const file = positionRecordsPath(dir);
    fs.writeFileSync(file, '{ "positions": { "cut short');
    let records;
    const told = tellsDuring(() => (records = readPositionRecords(dir)));
    assert.deepEqual(records, {});
    assert.equal(told.length, 1, told.join("\n"));
    assert.ok(
      told[0].startsWith(
        `LP Ranger could not read ${file}: it is not valid JSON (`,
      ),
      told[0],
    );
    assert.doesNotMatch(
      told[0],
      /permission|disk/i,
      "no cause it does not show",
    );
  });

  it("tells, then throws, a records file that cannot be read", () => {
    const dir = makeTestTempFolder("records");
    const file = positionRecordsPath(dir);
    fs.mkdirSync(file); // A folder where the file should be.
    const told = tellsDuring(() =>
      assert.throws(() => readPositionRecords(dir), { code: "EISDIR" }),
    );
    assert.equal(told.length, 1, told.join("\n"));
    assert.ok(
      told[0].startsWith(
        `LP Ranger could not read ${file}: a folder is where the file should be.`,
      ),
      told[0],
    );
  });

  it("tells nothing for a records file not written yet", () => {
    const dir = makeTestTempFolder("records");
    let records;
    const told = tellsDuring(() => (records = readPositionRecords(dir)));
    assert.deepEqual(records, {});
    assert.deepEqual(told, []);
  });

  it("tells an empty bot-config.json as not valid JSON, and loads an empty config", () => {
    const dir = makeTestTempFolder("records");
    const file = path.join(dir, "bot-config.json");
    fs.writeFileSync(file, "");
    let cfg;
    const told = tellsDuring(() => (cfg = loadConfig(dir, true)));
    assert.deepEqual(cfg, { global: {}, positions: {} });
    assert.equal(told.length, 1, told.join("\n"));
    assert.ok(
      told[0].startsWith(
        `LP Ranger could not read ${file}: it is not valid JSON (`,
      ),
      told[0],
    );
  });

  it("tells a bot-config.json that is not valid JSON", () => {
    const dir = makeTestTempFolder("records");
    const file = path.join(dir, "bot-config.json");
    fs.writeFileSync(file, '{ "global": ');
    const told = tellsDuring(() => loadConfig(dir, true));
    assert.equal(told.length, 1, told.join("\n"));
    assert.ok(
      told[0].startsWith(
        `LP Ranger could not read ${file}: it is not valid JSON (`,
      ),
      told[0],
    );
  });

  it("tells a bot-config.json gone bad to a global setting read while LP Ranger runs, and not to the read as it loads", () => {
    const dir = makeTestTempFolder("records");
    const file = path.join(dir, "bot-config.json");
    fs.writeFileSync(file, '{ "global": { "rpcUrls": ');
    /*-
     *  As src/lib/config.js loads, before the startup check, nothing is
     *  told: the check, right after, refuses the file with every other
     *  problem.
     */
    const quiet = tellsDuring(() =>
      assert.equal(readGlobalSetting("rpcUrls", dir), undefined),
    );
    assert.deepEqual(quiet, []);
    // GET /api/rpc-endpoints reads while LP Ranger runs, and tells.
    const told = tellsDuring(() =>
      assert.equal(readGlobalSetting("rpcUrls", dir, true), undefined),
    );
    assert.equal(told.length, 1, told.join("\n"));
    assert.ok(
      told[0].startsWith(
        `LP Ranger could not read ${file}: it is not valid JSON (`,
      ),
      told[0],
    );
    // An empty file is not valid JSON either, read while LP Ranger runs.
    fs.writeFileSync(file, "");
    const empty = tellsDuring(() => readGlobalSetting("rpcUrls", dir, true));
    assert.equal(empty.length, 1, empty.join("\n"));
  });
});
