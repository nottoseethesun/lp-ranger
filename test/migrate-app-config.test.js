/**
 * @file test/migrate-app-config.test.js
 * @description Tests for the one-time app-config migration helper.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  migrateAppConfig,
  _MIGRATION_FILES,
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

  it("fresh install: creates app-config/ and moves nothing", () => {
    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 0);
    assert.equal(result.skipped, 0);
    assert.ok(
      fs.existsSync(path.join(tmp, "app-config")),
      "app-config dir should exist",
    );
  });

  it("upgrade: moves every legacy root file into app-config/", () => {
    // Seed legacy files at root with unique content so we can verify identity.
    const contents = {};
    for (const f of _MIGRATION_FILES) {
      const payload = `content of ${f}`;
      contents[f] = payload;
      fs.writeFileSync(path.join(tmp, f), payload);
    }

    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, _MIGRATION_FILES.length);
    assert.equal(result.skipped, 0);

    for (const f of _MIGRATION_FILES) {
      // Source gone
      assert.equal(
        fs.existsSync(path.join(tmp, f)),
        false,
        `root ${f} should have been moved away`,
      );
      // Dest present with original content
      const destPath = path.join(tmp, "app-config", f);
      assert.ok(fs.existsSync(destPath), `${f} should exist in app-config/`);
      assert.equal(
        fs.readFileSync(destPath, "utf8"),
        contents[f],
        `${f} content should be preserved`,
      );
    }
  });

  it("idempotent: second call is a no-op after successful migration", () => {
    fs.writeFileSync(path.join(tmp, ".bot-config.json"), "first");
    const first = migrateAppConfig(tmp);
    assert.equal(first.moved, 1);

    // Second call — nothing at root, destination already populated
    const second = migrateAppConfig(tmp);
    assert.equal(second.moved, 0);
    assert.equal(second.skipped, 0);

    // Content preserved
    assert.equal(
      fs.readFileSync(path.join(tmp, "app-config", ".bot-config.json"), "utf8"),
      "first",
    );
  });

  it("conflict: refuses to move when destination also exists", () => {
    // Both root and destination exist — migration must NOT overwrite
    fs.mkdirSync(path.join(tmp, "app-config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".bot-config.json"), "from-root");
    fs.writeFileSync(
      path.join(tmp, "app-config", ".bot-config.json"),
      "from-dest",
    );

    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 0);
    assert.equal(result.skipped, 1);

    // Both files still exist untouched
    assert.equal(
      fs.readFileSync(path.join(tmp, ".bot-config.json"), "utf8"),
      "from-root",
      "root file should not have been touched",
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, "app-config", ".bot-config.json"), "utf8"),
      "from-dest",
      "destination file should not have been overwritten",
    );
  });

  it("partial upgrade: moves non-conflicting files and skips conflicts", () => {
    fs.mkdirSync(path.join(tmp, "app-config"), { recursive: true });
    // Conflict on one file only
    fs.writeFileSync(path.join(tmp, ".bot-config.json"), "root1");
    fs.writeFileSync(path.join(tmp, "app-config", ".bot-config.json"), "dest1");
    // Clean migration for another
    fs.writeFileSync(path.join(tmp, ".wallet.json"), "wallet-payload");

    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 1, "wallet should have moved");
    assert.equal(
      result.skipped,
      1,
      ".bot-config.json should have been skipped",
    );

    // Wallet moved
    assert.equal(
      fs.existsSync(path.join(tmp, ".wallet.json")),
      false,
      "root .wallet.json should be gone",
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, "app-config", ".wallet.json"), "utf8"),
      "wallet-payload",
    );

    // Conflict untouched on both sides
    assert.equal(
      fs.readFileSync(path.join(tmp, ".bot-config.json"), "utf8"),
      "root1",
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, "app-config", ".bot-config.json"), "utf8"),
      "dest1",
    );
  });

  it("creates app-config/ even when nothing needs migrating", () => {
    // No files exist anywhere
    const result = migrateAppConfig(tmp);
    assert.equal(result.moved, 0);
    assert.equal(result.skipped, 0);
    const stat = fs.statSync(path.join(tmp, "app-config"));
    assert.ok(stat.isDirectory(), "app-config should be a directory");
  });

  it("_MIGRATION_FILES exports all expected legacy names", () => {
    assert.deepEqual(_MIGRATION_FILES.sort(), [
      ".bot-config.backup.json",
      ".bot-config.json",
      ".bot-config.v1.json",
      ".wallet.json",
      "api-keys.json",
      "rebalance_log.json",
    ]);
  });
});
