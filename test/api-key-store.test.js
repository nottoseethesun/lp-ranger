"use strict";

/**
 * @file test/api-key-store.test.js
 * @description Where the encrypted api keys are kept (src/lib/api-key-store.js).
 *   Under `node --test`, with no `API_KEYS_FILE_PATH`, a test process's
 *   keys go in a temp folder of its own, so no test reads or writes the
 *   operator's app-config/user-configurable/api-keys.json. Outside tests
 *   the store uses that file, or the one `API_KEYS_FILE_PATH` names:
 *   checked in a child process run without the test runner's marker,
 *   which only asks the store where its file is.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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

/** The operator's file as it stands: its modification time, or null if absent. */
const operatorFileNow = () =>
  fs.existsSync(OPERATOR_FILE) ? fs.statSync(OPERATOR_FILE).mtimeMs : null;

/**
 * Where the store keeps its file in a child process run outside tests,
 * with `API_KEYS_FILE_PATH` set to `named`, or unset.
 * @param {string} [named]
 * @returns {string}
 */
function pathOutsideTests(named) {
  const src = JSON.stringify(
    path.join(__dirname, "..", "src", "lib", "api-key-store"),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.API_KEYS_FILE_PATH;
  if (named !== undefined) env.API_KEYS_FILE_PATH = named;
  const res = spawnSync(
    process.execPath,
    ["-e", `process.stdout.write(require(${src}).apiKeysPath())`],
    { env, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

describe("the api-key store under node --test", () => {
  it("keeps a test process's keys in a temp folder of its own", async () => {
    /*-
     *  Asked first: run as a plain script, without the runner's marker,
     *  the save below would replace the operator's stored key.
     */
    assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined);
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

describe("the api-key store outside tests", () => {
  it("uses app-config/user-configurable/api-keys.json in the install's folder", () => {
    assert.equal(pathOutsideTests(), OPERATOR_FILE);
  });

  it("uses the file API_KEYS_FILE_PATH names, when it names one", () => {
    const named = path.join(os.tmpdir(), "somewhere-else", "api-keys.json");
    assert.equal(pathOutsideTests(named), named);
  });

  it("takes a blank API_KEYS_FILE_PATH as naming none, as readEnv does", () => {
    assert.equal(pathOutsideTests("   "), OPERATOR_FILE);
  });
});
