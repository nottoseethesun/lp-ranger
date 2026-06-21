"use strict";

/**
 * @file test/gitignore.test.js
 * @description Ensures .gitignore contains rules for sensitive files
 * (env files, keyfiles, rebalance logs) so they are never committed.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const GITIGNORE_PATH = path.join(__dirname, "..", ".gitignore");

describe(".gitignore safety", () => {
  const content = fs.readFileSync(GITIGNORE_PATH, "utf8");
  const lines = content.split("\n").map((l) => l.trim());

  it("ignores .env files", () => {
    assert.ok(lines.includes(".env"), ".env should be in .gitignore");
    assert.ok(lines.includes(".env.*"), ".env.* should be in .gitignore");
  });

  it("allows .env.example", () => {
    assert.ok(
      lines.includes("!.env.example"),
      ".env.example should be whitelisted",
    );
  });

  it("ignores encrypted keyfiles", () => {
    assert.ok(
      lines.some((l) => l.includes("keyfile") && !l.startsWith("#")),
      "keyfile patterns should be in .gitignore",
    );
  });

  it("ignores runtime files inside app-config/ (glob)", () => {
    // app-config/.wallet.json, .bot-config.json, api-keys.json, etc.
    // are all covered by this glob. The matching un-ignore rules below
    // keep app-defaults-for-user-configurable/, user-configurable/
    // (the dir itself), and api-keys.example.json tracked.
    assert.ok(
      lines.includes("app-config/*"),
      "app-config/* should be in .gitignore to cover runtime state files",
    );
  });

  it("un-ignores app-config/app-defaults-for-user-configurable/ (shipped defaults)", () => {
    assert.ok(
      lines.includes("!app-config/app-defaults-for-user-configurable/"),
      "shipped-defaults directory should be whitelisted",
    );
  });

  it("keeps app-config/user-configurable/ dir tracked but its CONTENTS ignored (so user overrides survive tarball upgrade)", () => {
    assert.ok(
      lines.includes("!app-config/user-configurable/"),
      "user-configurable/ dir itself should be whitelisted",
    );
    assert.ok(
      lines.includes("app-config/user-configurable/*"),
      "contents under user-configurable/ should be re-ignored",
    );
    assert.ok(
      lines.includes("!app-config/user-configurable/.gitkeep"),
      ".gitkeep should be whitelisted so the empty dir is tracked",
    );
  });

  it("un-ignores app-config/api-keys.example.json (tracked template)", () => {
    assert.ok(
      lines.includes("!app-config/api-keys.example.json"),
      "app-config/api-keys.example.json should be whitelisted (tracked template)",
    );
  });

  it("ignores node_modules", () => {
    assert.ok(
      lines.some((l) => l === "node_modules" || l === "node_modules/"),
      "node_modules should be in .gitignore",
    );
  });
});
