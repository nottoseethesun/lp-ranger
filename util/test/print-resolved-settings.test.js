/**
 * @file util/test/print-resolved-settings.test.js
 * @description
 * Tests for `print-resolved-settings.js`, the diagnostic that prints the
 * settings an install runs on: the `.env` variables LP Ranger reads, with
 * the environment over them, then each JSON settings file, the
 * operator's copy over the shipped one. It must print the reading the
 * validation diagnostic checks, `resolveSettings` in
 * src/lib/settings-check.js, and never a secret's value. Each install is a
 * fixture in a temporary folder, with an environment of the test's own,
 * so the machine running the suite cannot change the answer.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildProgram, main } = require("../diagnostic/print-resolved-settings");
const { resolveSettings } = require("../../src/lib/settings-check");
const { makeTestTempFolder } = require("../../src/lib/test-temp-folders");

const SECRET_KEY = "not-a-real-key-for-the-test";
const SECRET_PASSWORD = "not-a-real-password-for-the-test";

/**
 * An install whose operator's folder holds a copy of csrf.json moving
 * one value, with the given `.env` text and environment.
 */
function install(envText, env) {
  const dir = makeTestTempFolder("print-settings");
  const userDir = path.join(dir, "user-configurable");
  fs.mkdirSync(userDir);
  fs.writeFileSync(
    path.join(userDir, "csrf.json"),
    JSON.stringify({ refreshIntervalMs: 240000 }),
  );
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, envText);
  return {
    userDir,
    envFile,
    botConfigFile: path.join(userDir, "bot-config.json"),
    env,
  };
}

/** Run the command on an install, answering its output. */
function run(where) {
  const printed = [];
  main([], { print: (t) => printed.push(t), where });
  return printed.join("\n");
}

const WHERE = install(
  `PORT=5999\nDRY_RUN=true\nPRIVATE_KEY=${SECRET_KEY}\n` +
    `WALLET_PASSWORD=${SECRET_PASSWORD}\n`,
  { DRY_RUN: "false" },
);

describe("print-resolved-settings", () => {
  it("names itself and says what it prints in its help", () => {
    let help = "";
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => (help += s) });
    // Commander answers --help by exiting, which exitOverride turns into a throw.
    assert.throws(() => program.parse(["--help"], { from: "user" }), {
      code: "commander.helpDisplayed",
    });
    assert.match(help, /print-resolved-settings/);
    assert.match(help, /never shown/);
    assert.match(help, /-h, --help/);
  });

  it("prints the .env variables LP Ranger reads, the environment over them", () => {
    const text = run(WHERE);
    assert.match(text, /^ {2}PORT=5999$/m);
    assert.match(text, /^ {2}DRY_RUN=false$/m, "the environment stands");
  });

  it("names each secret as set, and never prints its value", () => {
    const text = run(WHERE);
    assert.match(text, /PRIVATE_KEY is set; its value is not shown/);
    assert.match(text, /WALLET_PASSWORD is set; its value is not shown/);
    assert.ok(!text.includes(SECRET_KEY), "no private key");
    assert.ok(!text.includes(SECRET_PASSWORD), "no wallet password");
  });

  it("prints each settings file as the validation diagnostic reads it, your copy over the shipped one", () => {
    const text = run(WHERE);
    const { resolved, shipped } = resolveSettings(WHERE);
    for (const [file, settings] of Object.entries(resolved))
      assert.ok(
        text.includes(`${file}:\n${JSON.stringify(settings, null, 2)}`),
        file,
      );
    const csrf = resolved["csrf.json"];
    assert.equal(csrf.refreshIntervalMs, 240000, "your copy's value");
    assert.equal(csrf.tokenTtlMs, shipped["csrf.json"].tokenTtlMs, "shipped");
  });
});
