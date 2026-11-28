"use strict";

/**
 * @file test/scan-caches-written-whole.test.js
 * @description Every scan cache is replaced whole through a copy
 *   (src/lib/shared-json-file.js), so a write a full disk or a crash cuts
 *   short leaves the last copy whole: a cache cut short could not be read,
 *   and a file LP Ranger cannot read stops it (src/lib/file-problem.js).
 *   The diagnostic log and the rebalance log are not caches, and stay
 *   written in place (the user's rulings, 2026-11-27).
 *
 *   The caches a test can drive without the chain are driven: a write
 *   that lands part of its text and then fails, as on a full disk, leaves
 *   the file as it was. Every scan cache's source is held to the copy too,
 *   since two of them save only after a read of the chain. Each file is
 *   the test process's own (src/lib/scan-cache-dir.js), or a stand-in fs.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { _setSinkForTests } = require("../src/lib/log");

/*-
 *  Two caches take their file from a variable before the scan-cache
 *  folder (BLOCK_TIME_CACHE_PATH, TOKEN_SYMBOL_CACHE_PATH), and the gate
 *  passes the shell's on: each is pointed at a folder of this test's own,
 *  before either module loads, so an operator's exported path is never
 *  seeded over.
 */
process.env.BLOCK_TIME_CACHE_PATH = path.join(
  makeTestTempFolder("written-whole-block-times"),
  "block-time-cache.json",
);
process.env.TOKEN_SYMBOL_CACHE_PATH = path.join(
  makeTestTempFolder("written-whole-symbols"),
  "token-symbol-cache.json",
);

let restoreSink;
beforeEach(() => {
  // TEST-ONLY: the failure's log line, kept off the output; put back after.
  restoreSink = _setSinkForTests({
    log: () => {},
    warn: () => {},
    error: () => {},
  });
});
afterEach(() => restoreSink());

/**
 * Run `fn` while every fs.writeFileSync writes the first ten characters
 * of its text and then fails, as on a full disk.
 * TEST-ONLY global swap: fs.writeFileSync, put back in the `finally`;
 * these caches have no seam for their file system.
 */
async function withWritesCutShort(fn) {
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, data, ...rest) => {
    realWrite(p, String(data).slice(0, 10), ...rest);
    throw Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
    });
  };
  try {
    await fn();
  } finally {
    fs.writeFileSync = realWrite;
  }
}

/** Seed `file` with `data` as JSON, and answer its text. */
function seed(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(file, text);
  return text;
}

describe("a scan cache whose write is cut short", () => {
  it("block times: the last copy stays whole", async () => {
    const btc = require("../src/bot/block-time-cache");
    const before = seed(btc._CACHE_PATH, { "seeded-1": 100 });
    btc._resetForTest();
    const provider = { getBlock: async () => ({ timestamp: 200 }) };
    await btc.getBlockTimestamp(provider, "pulsechain", 7);
    await withWritesCutShort(() => btc.flushBlockTimeCache());
    assert.equal(fs.readFileSync(btc._CACHE_PATH, "utf8"), before);
  });

  it("token symbols: the last copy stays whole", async () => {
    const tsc = require("../src/lib/token-symbol-cache");
    const before = seed(tsc._SYM_CACHE_PATH, { "seeded-0xa": "AAA" });
    tsc._resetSymbolCache();
    tsc.setTokenSymbol("0x00000000000000000000000000000000000000b1", "BBB");
    await withWritesCutShort(() => tsc.flushSymbolCache());
    assert.equal(fs.readFileSync(tsc._SYM_CACHE_PATH, "utf8"), before);
  });

  it("the LP-position list: the last copy stays whole", () => {
    const {
      saveLpPositionCache,
      lpPositionCachePath,
    } = require("../src/bot/lp-position-cache");
    const files = {};
    const memFs = {
      mkdirSync() {},
      // Part of the text lands, then the write fails, as on a full disk.
      writeFileSync(p, data) {
        files[p] = String(data).slice(0, 10);
        throw new Error("ENOSPC: no space left on device");
      },
      mkdtempSync: (prefix) => prefix + "XXXXXX",
      renameSync(from, to) {
        files[to] = files[from];
      },
      rmSync() {},
    };
    const opts = { blockchain: "pulsechain", fsModule: memFs };
    const wallet = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
    const file = lpPositionCachePath(wallet, "pulsechain");
    files[file] = '{"positions":[],"lastBlock":1}';
    saveLpPositionCache(wallet, [{ tokenId: 2n }], 9, opts);
    assert.equal(files[file], '{"positions":[],"lastBlock":1}');
  });
});

describe("every scan cache, as written", () => {
  /*-
   *  The P&L epoch cache and the store's caches are driven in their own
   *  tests (test/epoch-cache.test.js, test/cache-store.test.js); NFT mint
   *  dates and pool creation blocks save only after a read of the chain.
   */
  for (const file of [
    "src/bot/epoch-cache.js",
    "src/lib/cache-store.js",
    "src/bot/block-time-cache.js",
    "src/bot/position-history-mint.js",
    "src/bot/pool-creation-block.js",
    "src/lib/token-symbol-cache.js",
    "src/bot/lp-position-cache.js",
  ])
    it(`${file} replaces its file whole through a copy, never in place`, () => {
      const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
      assert.match(src, /replaceJsonFile\(/);
      assert.doesNotMatch(src, /writeFileSync\(/);
    });
});
