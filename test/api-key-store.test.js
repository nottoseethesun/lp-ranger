"use strict";

/**
 * @file test/api-key-store.test.js
 * @description Where the encrypted api keys are kept under `node --test`
 *   (src/lib/api-key-store.js). With no `API_KEYS_FILE_PATH`, a test
 *   process's keys go in a temp folder of its own, so no test reads or
 *   writes the operator's app-config/user-configurable/api-keys.json,
 *   whether or not the run moved the operator's files aside first.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  saveEncryptedKey,
  loadEncryptedKey,
  hasEncryptedKey,
} = require("../src/lib/api-key-store");

const OPERATOR_FILE = path.join(
  process.cwd(),
  "app-config",
  "user-configurable",
  "api-keys.json",
);

/** The operator's file as it stands: its change time, or null if absent. */
const operatorFileNow = () =>
  fs.existsSync(OPERATOR_FILE) ? fs.statSync(OPERATOR_FILE).mtimeMs : null;

describe("the api-key store under node --test", () => {
  it("keeps a test process's keys in a temp folder of its own", async () => {
    assert.equal(process.env.API_KEYS_FILE_PATH, undefined);
    const before = operatorFileNow();
    await saveEncryptedKey("moralis", "test-key", "test-password");
    assert.equal(hasEncryptedKey("moralis"), true);
    assert.equal(
      await loadEncryptedKey("moralis", "test-password"),
      "test-key",
    );
    const mine = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith(`lp-ranger-test-api-keys-${process.pid}-`));
    assert.equal(mine.length, 1, mine.join(", "));
    assert.ok(fs.existsSync(path.join(os.tmpdir(), mine[0], "api-keys.json")));
    assert.equal(operatorFileNow(), before, "the operator's file untouched");
  });
});
