/**
 * @file util/test/migration.test.js
 * @description Tests for `util/migration/`, run once after Step Six of
 *   the Update section to bring an updated install's files up to date
 *   with this release.
 *
 *   Each case builds an install in a temp folder of its own, so no
 *   operator file is in reach.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTestTempFolder } = require("../../src/test-temp-folders");
const { runMigration, report } = require("../migration");
const { isOldScanCache } = require("../migration/move-scan-caches");

/** Write `text` to `rel` in `root`, making its folders. */
function put(root, rel, text = "{}") {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Whether `rel` exists in `root`. */
const has = (root, rel) => fs.existsSync(path.join(root, rel));

/** Every cache a release before the move kept in tmp/. */
const OLD_CACHES = [
  "pnl-epochs-cache.json",
  "liquidity-pair-details-cache.json",
  "historical-price-cache.json",
  "block-time-cache.json",
  "gecko-pool-cache.json",
  "token-symbol-cache.json",
  "pool-creation-blocks-cache.json",
  "nft-mint-date-cache.json",
  "event-cache-pulse-cc05bf-4e4484-0d86eb9f-352511c9-10000.json",
  "lp-position-cache-pulse-cc05bf-4e4484.json",
];

describe("moving the scan caches", () => {
  it("moves every old cache from tmp/ to app-data/scan-cache/, and leaves the rest of tmp/", () => {
    const root = makeTestTempFolder("migration");
    for (const name of OLD_CACHES) put(root, `tmp/${name}`, `"${name}"`);
    put(root, "tmp/lp-ranger.pid", "123");
    put(root, "tmp/notes.json");
    runMigration({ root });
    for (const name of OLD_CACHES) {
      assert.equal(has(root, `tmp/${name}`), false, `tmp/${name} moved`);
      assert.equal(
        fs.readFileSync(path.join(root, "app-data/scan-cache", name), "utf8"),
        `"${name}"`,
      );
    }
    assert.equal(has(root, "tmp/lp-ranger.pid"), true);
    assert.equal(has(root, "tmp/notes.json"), true);
  });

  it("keeps a cache this release already wrote, and leaves the old one in tmp/", () => {
    const root = makeTestTempFolder("migration");
    put(root, "tmp/block-time-cache.json", '"old"');
    put(root, "app-data/scan-cache/block-time-cache.json", '"new"');
    const [step] = runMigration({ root });
    assert.equal(
      fs.readFileSync(
        path.join(root, "app-data/scan-cache/block-time-cache.json"),
        "utf8",
      ),
      '"new"',
    );
    assert.equal(has(root, "tmp/block-time-cache.json"), true);
    assert.match(
      step.lines.join("\n"),
      /kept app-data\/scan-cache\/block-time/,
    );
  });

  it("moves nothing on a dry run, and says what it would move", () => {
    const root = makeTestTempFolder("migration");
    put(root, "tmp/gecko-pool-cache.json");
    const results = runMigration({ root, dryRun: true });
    assert.equal(has(root, "tmp/gecko-pool-cache.json"), true);
    assert.equal(has(root, "app-data/scan-cache"), false);
    assert.match(report(results, true), /^Would change \(dry run\):/);
    assert.match(
      report(results, true),
      /would move tmp\/gecko-pool-cache\.json/,
    );
  });

  it("changes nothing when run again", () => {
    const root = makeTestTempFolder("migration");
    put(root, "tmp/token-symbol-cache.json");
    runMigration({ root });
    const again = runMigration({ root });
    assert.equal(
      report(again, false),
      "Nothing to change: this install is up to date.",
    );
  });

  it("takes only the old caches' names", () => {
    for (const name of OLD_CACHES) assert.equal(isOldScanCache(name), true);
    assert.equal(isOldScanCache("lp-ranger.pid"), false);
    assert.equal(isOldScanCache("event-cache-notes.txt"), false);
    assert.equal(isOldScanCache("pnl-epochs-cache.json.bak-1"), false);
  });
});

const CONFIG = "app-config/user-configurable/bot-config.json";
const RECORDS = "app-data/position-records.json";
const KEY =
  "pulsechain-0x1111111111111111111111111111111111111111-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-101";

/** An older release's bot-config.json: settings and records together. */
const OLD_CONFIG = {
  global: { gasFeePct: 1 },
  positions: {
    [KEY]: {
      status: "running",
      slippagePctToken0: 1,
      hodlBaseline: { entryValue: 100 },
      residuals: { "0xPool": { token0: "5", token1: "6" } },
      lastCompoundAt: "2026-10-01T00:00:00.000Z",
    },
  },
};

/** The JSON file at `rel` in `root`. */
const readJson = (root, rel) =>
  JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

describe("moving each position's records", () => {
  it("moves the records out of bot-config.json into the records file", () => {
    const root = makeTestTempFolder("migration");
    put(root, CONFIG, JSON.stringify(OLD_CONFIG));
    runMigration({ root });
    assert.deepEqual(readJson(root, CONFIG), {
      global: { gasFeePct: 1 },
      positions: { [KEY]: { status: "running", slippagePctToken0: 1 } },
    });
    assert.deepEqual(readJson(root, RECORDS), {
      positions: {
        [KEY]: {
          hodlBaseline: { entryValue: 100 },
          residuals: { "0xPool": { token0: "5", token1: "6" } },
          lastCompoundAt: "2026-10-01T00:00:00.000Z",
        },
      },
    });
  });

  it("keeps a copy of the old bot-config.json in tmp/", () => {
    const root = makeTestTempFolder("migration");
    put(root, CONFIG, JSON.stringify(OLD_CONFIG));
    runMigration({ root });
    const copies = fs
      .readdirSync(path.join(root, "tmp"))
      .filter((n) => n.startsWith("bot-config.pre-migration-"));
    assert.equal(copies.length, 1);
    assert.deepEqual(readJson(root, `tmp/${copies[0]}`), OLD_CONFIG);
  });

  it("keeps a record the records file already holds", () => {
    const root = makeTestTempFolder("migration");
    put(root, CONFIG, JSON.stringify(OLD_CONFIG));
    put(
      root,
      RECORDS,
      JSON.stringify({ positions: { [KEY]: { lastCompoundAt: "newer" } } }),
    );
    runMigration({ root });
    assert.equal(
      readJson(root, RECORDS).positions[KEY].lastCompoundAt,
      "newer",
    );
  });

  it("changes nothing on a dry run, or when run again", () => {
    const root = makeTestTempFolder("migration");
    put(root, CONFIG, JSON.stringify(OLD_CONFIG));
    const dry = runMigration({ root, dryRun: true });
    assert.deepEqual(readJson(root, CONFIG), OLD_CONFIG);
    assert.equal(has(root, RECORDS), false);
    assert.match(report(dry, true), /would move 3 record value/);
    runMigration({ root });
    assert.equal(
      report(runMigration({ root }), false),
      "Nothing to change: this install is up to date.",
    );
  });

  it("leaves a bot-config.json that is not JSON as it was, and says so", () => {
    const root = makeTestTempFolder("migration");
    put(root, CONFIG, "{ not json");
    const results = runMigration({ root });
    assert.equal(
      fs.readFileSync(path.join(root, CONFIG), "utf8"),
      "{ not json",
    );
    assert.match(report(results, false), /is not valid JSON .* left as it was/);
  });
});
