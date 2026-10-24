"use strict";

/**
 * @file test/price-fetcher-gate-backups.test.js
 * @description The price library reads its three cache lifetimes only when
 *   a program's entry point calls `readPriceCacheSettings`, never when the
 *   library is loaded, and a tool under util/ can make that read without
 *   touching LP Ranger's backups of its settings files.
 *
 *   The read goes through `loadConfig`, which copies bot-config.json and
 *   the records file over their backups unless the caller passes
 *   `skipBackups`. The server and the bot make those copies as they start,
 *   so a copy made by a tool would replace the app's while LP Ranger runs.
 *   A read made as the library loaded could not be told to skip them.
 *
 *   Under `node --test` both files live in the test process's own folders
 *   (src/lib/test-temp-folders.js), so the operator's are never read.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { botConfigPath } = require("../src/lib/bot-config-v2");
const { positionRecordsPath } = require("../src/lib/position-records");
const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");

const KEY =
  "pulsechain-0x1111111111111111111111111111111111111111-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-101";

/** A price-cache lifetime no default has, so a test can tell it was read. */
const SET_TTL_MS = 777_000;

/** A token for the lookup test; no price service is asked about it. */
const TOKEN = "0x2222222222222222222222222222222222222222";

/** What the last start's backups hold before each test. */
const LAST_START = "the last start's copy";

/** The backup beside a settings file. */
const backupOf = (file) => file.replace(".json", ".backup.json");

/** Put a position and a set lifetime in both files, and the last start's backups. */
function seed() {
  const settings = botConfigPath();
  const records = positionRecordsPath();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(records), { recursive: true });
  const settingsFile = {
    global: { priceCacheTtlMs: SET_TTL_MS },
    positions: { [KEY]: { status: "running" } },
  };
  const recordsFile = { positions: { [KEY]: { lastCompoundAt: "now" } } };
  fs.writeFileSync(settings, JSON.stringify(settingsFile));
  fs.writeFileSync(records, JSON.stringify(recordsFile));
  fs.writeFileSync(backupOf(settings), LAST_START);
  fs.writeFileSync(backupOf(records), LAST_START);
  return { settings, records };
}

/** Load the price library afresh, as a program that prices with it does. */
function loadLibrary() {
  delete require.cache[require.resolve("../src/lib/price-fetcher-gate")];
  delete require.cache[require.resolve("../src/lib/price-fetcher")];
  const fetcher = require("../src/lib/price-fetcher");
  const gate = require("../src/lib/price-fetcher-gate");
  return { fetcher, gate };
}

/** What each backup holds, the settings file's first. */
function backups({ settings, records }) {
  return [
    fs.readFileSync(backupOf(settings), "utf8"),
    fs.readFileSync(backupOf(records), "utf8"),
  ];
}

describe("the price library's cache settings", () => {
  it("are not read when the library is loaded", () => {
    const files = seed();
    const { gate } = loadLibrary();
    const ttl = gate.getPriceCacheTtlMs();
    const shipped = readBotConfigDefaults().priceCacheTtlMs;
    assert.equal(ttl, shipped, "the default, not the settings' value");
    const kept = backups(files);
    assert.deepEqual(kept, [LAST_START, LAST_START]);
  });

  it("are read leaving the backups alone when the caller skips them", () => {
    const files = seed();
    const { gate } = loadLibrary();
    gate.readPriceCacheSettings(true);
    const ttl = gate.getPriceCacheTtlMs();
    assert.equal(ttl, SET_TTL_MS);
    const kept = backups(files);
    assert.deepEqual(kept, [LAST_START, LAST_START]);
  });

  it("replace both backups when read as the server and the bot read them", () => {
    const files = seed();
    const { gate } = loadLibrary();
    gate.readPriceCacheSettings();
    const ttl = gate.getPriceCacheTtlMs();
    assert.equal(ttl, SET_TTL_MS);
    const kept = backups(files);
    const current = [
      fs.readFileSync(files.settings, "utf8"),
      fs.readFileSync(files.records, "utf8"),
    ];
    assert.deepEqual(kept, current);
  });

  it("are the lifetimes a price lookup uses once read", async () => {
    seed();
    const { fetcher, gate } = loadLibrary();
    gate.readPriceCacheSettings(true);
    /*-
     *  Older than the default lifetime and younger than the one read, so
     *  only a lookup that asks the gate at the time finds it fresh.
     */
    const shipped = readBotConfigDefaults().priceCacheTtlMs;
    const entry = { price: 1.5, ts: Date.now() - shipped - 1000 };
    fetcher._cache.set(`pulsechain-${TOKEN.toLowerCase()}`, entry);
    const realFetch = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async () => {
      asked++;
      throw new Error("no price service is asked in this test");
    };
    try {
      const price = await fetcher.fetchTokenPriceUsd(TOKEN);
      assert.equal(price, 1.5, "the cached price");
      assert.equal(asked, 0, "no price service asked");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
