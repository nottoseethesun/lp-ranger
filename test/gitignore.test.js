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
    // app-config/.wallet.json, .bot-config.json, api-keys.json, etc. are
    // all covered by this glob. The matching un-ignore rules below keep
    // static-tunables/ and api-keys.example.json tracked.
    assert.ok(
      lines.includes("app-config/*"),
      "app-config/* should be in .gitignore to cover runtime state files",
    );
  });

  it("un-ignores app-config/static-tunables/ (tracked tunables)", () => {
    assert.ok(
      lines.includes("!app-config/static-tunables/"),
      "app-config/static-tunables/ should be whitelisted (tracked tunables)",
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
