"use strict";

/**
 * @file test/env-file-setting-removal.test.js
 * @description Removing settings from a `.env` file
 *   (`removeEnvFileSettings`, src/lib/env-settings.js), as Clear Wallet
 *   removes PRIVATE_KEY and WALLET_PASSWORD and `npm run reset-wallet`
 *   WALLET_PASSWORD. Every line dotenv would read as setting one goes, an
 *   `export` before it, spaces around the `=` or a `NAME: value` colon
 *   included, and a value running over several lines goes whole, read
 *   by dotenv's own rule: a quote left open runs on to the first later
 *   line holding the same quote, when only spaces or a `#` comment follow
 *   it there; otherwise the value is its first line alone, the opening
 *   quote included. Every other line stays as it was; the file keeps its
 *   mode; a link to it is followed and left a link. Runs over files of
 *   this test's own.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const {
  removeEnvFileSettings,
  envFileSets,
  loadEnvFile,
  setBeforeEnvFile,
  _setEnvBeforeFileForTests,
} = require("../src/lib/env-settings");

const DIR = makeTestTempFolder("env-file-setting-removal");

/** A `.env` file of this test's own holding `text`. */
function envFileWith(text, name = ".env") {
  const file = path.join(DIR, name);
  fs.writeFileSync(file, text);
  return file;
}

/**
 * What dotenv reads from `text`, less `names`: what the file must read as
 * once they are removed.
 */
function dotenvWithout(text, names) {
  const parsed = dotenv.parse(text);
  for (const name of names) delete parsed[name];
  return parsed;
}

describe("removeEnvFileSettings", () => {
  it("removes each line setting a name, as dotenv reads one, and keeps the rest", () => {
    const file = envFileWith(
      [
        "# a comment naming PRIVATE_KEY=0x0",
        "PRIVATE_KEY=0xabc",
        "CHAIN_NAME=pulsechain",
        "export PRIVATE_KEY=0xdef",
        "PRIVATE_KEY = 0x123",
        "PRIVATE_KEY: 0x456",
        "PRIVATE_KEY_EXTRA=kept",
        "",
      ].join("\n"),
    );
    assert.deepEqual(removeEnvFileSettings(file, ["PRIVATE_KEY"]), [
      "PRIVATE_KEY",
    ]);
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "# a comment naming PRIVATE_KEY=0x0\nCHAIN_NAME=pulsechain\nPRIVATE_KEY_EXTRA=kept\n",
    );
  });

  it("removes several names in one rewrite, naming those it removed in the order given", () => {
    const file = envFileWith("WALLET_PASSWORD=pw\nA=1\nPRIVATE_KEY=0xabc\n");
    assert.deepEqual(
      removeEnvFileSettings(file, ["PRIVATE_KEY", "WALLET_PASSWORD", "NONE"]),
      ["PRIVATE_KEY", "WALLET_PASSWORD"],
    );
    assert.equal(fs.readFileSync(file, "utf8"), "A=1\n");
  });

  it("removes a value running over several lines whole", () => {
    const file = envFileWith(
      'A=1\nWALLET_PASSWORD="first line\nsecond line"\nB=2\n',
    );
    removeEnvFileSettings(file, ["WALLET_PASSWORD"]);
    assert.equal(fs.readFileSync(file, "utf8"), "A=1\nB=2\n");
  });

  it("removes only its own line for a quote never closed, as dotenv reads it", () => {
    /*-
     *  dotenv reads `'s3cr3t` as one line, the quote kept. Read as
     *  running to the end of the file, the lines after it were deleted.
     */
    const text =
      "WALLET_PASSWORD='s3cr3t\nRPC_URL=https://rpc.example\nPORT=5555\n";
    const file = envFileWith(text);
    removeEnvFileSettings(file, ["WALLET_PASSWORD"]);
    const now = fs.readFileSync(file, "utf8");
    assert.equal(now, "RPC_URL=https://rpc.example\nPORT=5555\n");
    assert.deepEqual(
      dotenv.parse(now),
      dotenvWithout(text, ["WALLET_PASSWORD"]),
    );
  });

  it("removes only its own line when a later quote is followed by other text", () => {
    // Not a closing quote to dotenv: `'b' c` cannot end a quoted value.
    const text = "WALLET_PASSWORD='a\nNOTE='b' c\nPORT=5555\n";
    const file = envFileWith(text);
    removeEnvFileSettings(file, ["WALLET_PASSWORD"]);
    const now = fs.readFileSync(file, "utf8");
    assert.equal(now, "NOTE='b' c\nPORT=5555\n");
    assert.deepEqual(
      dotenv.parse(now),
      dotenvWithout(text, ["WALLET_PASSWORD"]),
    );
  });

  it("runs on to a later line whose closing quote only a comment follows", () => {
    const text = 'A=1\nWALLET_PASSWORD="x\ny"  # the old one\nB=2\n';
    const file = envFileWith(text);
    removeEnvFileSettings(file, ["WALLET_PASSWORD"]);
    const now = fs.readFileSync(file, "utf8");
    assert.equal(now, "A=1\nB=2\n");
    assert.deepEqual(
      dotenv.parse(now),
      dotenvWithout(text, ["WALLET_PASSWORD"]),
    );
  });

  it("does not take an escaped quote for the closing one", () => {
    const text = 'WALLET_PASSWORD="a\\"\nb"\nC=3\n';
    const file = envFileWith(text);
    removeEnvFileSettings(file, ["WALLET_PASSWORD"]);
    const now = fs.readFileSync(file, "utf8");
    assert.equal(now, "C=3\n");
    assert.deepEqual(
      dotenv.parse(now),
      dotenvWithout(text, ["WALLET_PASSWORD"]),
    );
  });

  it("keeps the file's mode, and leaves no copy behind", () => {
    const file = envFileWith("PRIVATE_KEY=0xabc\nA=1\n", ".env-mode");
    fs.chmodSync(file, 0o600);
    removeEnvFileSettings(file, ["PRIVATE_KEY"]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it("leaves no partial copy when writing the copy fails, as on a full disk", () => {
    // The part written can hold a secret.
    const file = envFileWith("PRIVATE_KEY=0xabc\nA=1\n", ".env-full");
    /*-
     *  TEST-ONLY global swap: the copy's write creates the file, writes
     *  part of it, then fails as a full disk does. Put back in the
     *  `finally` below, immediately after the call.
     */
    const savedWrite = fs.writeFileSync;
    fs.writeFileSync = (p, data, opts) => {
      savedWrite(p, String(data).slice(0, 4), opts);
      throw Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
    };
    try {
      assert.throws(
        () => removeEnvFileSettings(file, ["PRIVATE_KEY"]),
        /ENOSPC/,
      );
    } finally {
      fs.writeFileSync = savedWrite;
    }
    assert.equal(fs.existsSync(`${file}.tmp`), false, "no partial copy");
    assert.equal(
      fs.readFileSync(file, "utf8"),
      "PRIVATE_KEY=0xabc\nA=1\n",
      "the file as it was",
    );
  });

  it("rewrites the file a link names, and leaves the link a link", () => {
    const target = envFileWith("PRIVATE_KEY=0xabc\nA=1\n", "real.env");
    const link = path.join(DIR, ".env-link");
    fs.symlinkSync(target, link);
    removeEnvFileSettings(link, ["PRIVATE_KEY"]);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "still a link");
    assert.equal(fs.readFileSync(target, "utf8"), "A=1\n");
  });

  it("changes nothing, naming none, when no line sets a name", () => {
    const file = envFileWith("A=1\n", ".env-absent");
    assert.deepEqual(removeEnvFileSettings(file, ["PRIVATE_KEY"]), []);
    assert.equal(fs.readFileSync(file, "utf8"), "A=1\n");
  });

  it("answers null when there is no file", () => {
    assert.equal(
      removeEnvFileSettings(path.join(DIR, "none"), ["PRIVATE_KEY"]),
      null,
    );
  });
});

describe("envFileSets", () => {
  it("says whether a file sets a name, as dotenv reads it", () => {
    const file = envFileWith(
      "export PRIVATE_KEY = 0xabc\nWALLET_PASSWORD: pw\n",
      ".env-sets",
    );
    assert.equal(envFileSets(file, "PRIVATE_KEY"), true);
    assert.equal(envFileSets(file, "WALLET_PASSWORD"), true);
    assert.equal(envFileSets(file, "PORT"), false);
    assert.equal(envFileSets(path.join(DIR, "none"), "PORT"), false);
  });
});

describe("what the environment set before .env was read", () => {
  it("is noted by the first load only, since a later one finds .env's own values set", () => {
    /*-
     *  `loadEnvFile` runs more than once as the app loads. Noted again,
     *  every setting `.env` gave would read as the shell's, and a Clear
     *  would warn of each. Under the test runner it reads no
     *  `.env`, so only the noting is exercised.
     *
     *  TEST-ONLY global swap: the record and two variables of this
     *  process's environment, put back in the `finally`.
     */
    const savedRecord = _setEnvBeforeFileForTests(null);
    process.env.LP_RANGER_TEST_SET_BEFORE = "x";
    try {
      loadEnvFile();
      assert.equal(setBeforeEnvFile("LP_RANGER_TEST_SET_BEFORE"), true);
      process.env.LP_RANGER_TEST_SET_AFTER = "y";
      loadEnvFile();
      assert.equal(
        setBeforeEnvFile("LP_RANGER_TEST_SET_AFTER"),
        false,
        "a later load notes nothing more",
      );
    } finally {
      delete process.env.LP_RANGER_TEST_SET_BEFORE;
      delete process.env.LP_RANGER_TEST_SET_AFTER;
      _setEnvBeforeFileForTests(savedRecord === null ? null : [...savedRecord]);
    }
  });

  it("names nothing before the first load", () => {
    const savedRecord = _setEnvBeforeFileForTests(null);
    try {
      assert.equal(setBeforeEnvFile("PATH"), false);
    } finally {
      _setEnvBeforeFileForTests(savedRecord === null ? null : [...savedRecord]);
    }
  });
});
