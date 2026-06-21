/**
 * @file test/migrate-app-config.test.js
 * @description Tests for the one-time root → app-config/user-configurable
 * (and app-data) migration helper.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  migrateAppConfig,
  _MIGRATIONS,
  _DROP,
} = require("../src/migrate-app-config");

/** Create a fresh isolated temp dir per test. */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "migrate-app-config-"));
}

/** Recursively remove a directory tree, ignoring errors. */
function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe("migrateAppConfig", () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmp);
  });

  it("fresh install: no legacy files anywhere → no-op", () => {
    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.dropped, 0);
  });

  it("upgrade: moves every legacy root file into its new home", () => {
    // Seed legacy root files with unique content so we can verify identity.
    const contents = {};
    for (const m of _MIGRATIONS) {
      contents[m.src] = `content of ${m.src}`;
      fs.writeFileSync(path.join(tmp, m.src), contents[m.src]);
    }

    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, _MIGRATIONS.length);
    assert.equal(result.skipped, 0);
    assert.equal(result.dropped, 0);

    for (const m of _MIGRATIONS) {
      // Source gone
      assert.equal(
        fs.existsSync(path.join(tmp, m.src)),
        false,
        `root ${m.src} should have been moved away`,
      );
      // Dest present with original content
      const destPath = path.join(tmp, m.dest);
      assert.ok(fs.existsSync(destPath), `${m.dest} should exist`);
      assert.equal(
        fs.readFileSync(destPath, "utf8"),
        contents[m.src],
        `${m.src} content should be preserved at ${m.dest}`,
      );
    }
  });

  it("upgrade: drops every legacy file in the _DROP list", () => {
    for (const f of _DROP) {
      fs.writeFileSync(path.join(tmp, f), `content of ${f}`);
    }

    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.dropped, _DROP.length);

    for (const f of _DROP) {
      assert.equal(
        fs.existsSync(path.join(tmp, f)),
        false,
        `dropped ${f} should be gone`,
      );
    }
  });

  it("idempotent: second call is a no-op after successful migration", () => {
    fs.writeFileSync(path.join(tmp, ".bot-config.json"), "first");
    fs.writeFileSync(path.join(tmp, ".bot-config.backup.json"), "snap");
    const first = migrateAppConfig(tmp);
    assert.equal(first.moved, 1);
    assert.equal(first.dropped, 1);

    // Second call — nothing at root, destinations already populated
    const second = migrateAppConfig(tmp);
    assert.equal(second.moved, 0);
    assert.equal(second.skipped, 0);
    assert.equal(second.dropped, 0);

    // Migrated content preserved
    const m = _MIGRATIONS.find((x) => x.src === ".bot-config.json");
    assert.equal(fs.readFileSync(path.join(tmp, m.dest), "utf8"), "first");
  });

  it("conflict: refuses to move when destination also exists", () => {
    const m = _MIGRATIONS.find((x) => x.src === ".bot-config.json");
    fs.mkdirSync(path.join(tmp, path.dirname(m.dest)), { recursive: true });
    fs.writeFileSync(path.join(tmp, m.src), "from-root");
    fs.writeFileSync(path.join(tmp, m.dest), "from-dest");

    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.dropped, 0);

    // Both files still exist untouched
    assert.equal(
      fs.readFileSync(path.join(tmp, m.src), "utf8"),
      "from-root",
      "root file should not have been touched",
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, m.dest), "utf8"),
      "from-dest",
      "destination file should not have been overwritten",
    );
  });

  it("partial upgrade: moves non-conflicting files and skips conflicts", () => {
    const conflict = _MIGRATIONS.find((x) => x.src === ".bot-config.json");
    const clean = _MIGRATIONS.find((x) => x.src === ".wallet.json");
    fs.mkdirSync(path.join(tmp, path.dirname(conflict.dest)), {
      recursive: true,
    });
    // Conflict on one file
    fs.writeFileSync(path.join(tmp, conflict.src), "root1");
    fs.writeFileSync(path.join(tmp, conflict.dest), "dest1");
    // Clean migration for another
    fs.writeFileSync(path.join(tmp, clean.src), "wallet-payload");

    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 1, "wallet should have moved");
    assert.equal(result.skipped, 1, "bot-config should have been skipped");

    // Wallet moved
    assert.equal(
      fs.existsSync(path.join(tmp, clean.src)),
      false,
      `root ${clean.src} should be gone`,
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, clean.dest), "utf8"),
      "wallet-payload",
    );

    // Conflict untouched on both sides
    assert.equal(
      fs.readFileSync(path.join(tmp, conflict.src), "utf8"),
      "root1",
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, conflict.dest), "utf8"),
      "dest1",
    );
  });

  it("creates destination parent dirs on the fly", () => {
    // app-data/ does not exist yet
    const reb = _MIGRATIONS.find((x) => x.src === "rebalance_log.json");
    fs.writeFileSync(path.join(tmp, reb.src), "events");
    assert.equal(fs.existsSync(path.join(tmp, "app-data")), false);

    migrateAppConfig(tmp);

    assert.equal(
      fs.readFileSync(path.join(tmp, reb.dest), "utf8"),
      "events",
      "log should land at app-data/rebalance_log.json",
    );
  });

  it("_MIGRATIONS covers the four expected legacy names", () => {
    const sources = _MIGRATIONS.map((m) => m.src).sort();
    assert.deepEqual(sources, [
      ".bot-config.json",
      ".wallet.json",
      "api-keys.json",
      "rebalance_log.json",
    ]);
  });

  it("_MIGRATIONS destinations only live under app-config/user-configurable/ or app-data/", () => {
    for (const m of _MIGRATIONS) {
      const ok =
        m.dest.startsWith(
          path.join("app-config", "user-configurable") + path.sep,
        ) || m.dest.startsWith("app-data" + path.sep);
      assert.ok(
        ok,
        `${m.src} → ${m.dest} must land under app-config/user-configurable/ or app-data/`,
      );
    }
  });

  it("_DROP lists the two legacy files with no destination", () => {
    assert.deepEqual(_DROP.sort(), [
      ".bot-config.backup.json",
      ".bot-config.v1.json",
    ]);
  });
});
