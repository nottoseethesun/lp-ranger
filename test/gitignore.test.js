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

  it("ignores everything at the top level of app-config/ (glob)", () => {
    // Only the two whitelisted subdirectories (app-defaults-for-user-
    // configurable/ and user-configurable/) are tracked under
    // app-config/.  This glob covers any stray legacy runtime file
    // that drops back at the top level (e.g. from an older release).
    assert.ok(
      lines.includes("app-config/*"),
      "app-config/* should be in .gitignore to cover stray runtime files",
    );
  });

  it("un-ignores app-config/app-defaults-for-user-configurable/ (shipped defaults)", () => {
    assert.ok(
      lines.includes("!app-config/app-defaults-for-user-configurable/"),
      "shipped-defaults directory should be whitelisted",
    );
  });

  it("keeps app-config/user-configurable/ dir tracked but its CONTENTS ignored (so operator runtime files survive tarball upgrade)", () => {
    assert.ok(
      lines.includes("!app-config/user-configurable/"),
      "user-configurable/ dir itself should be whitelisted",
    );
    assert.ok(
      lines.includes("app-config/user-configurable/*"),
      "contents under user-configurable/ should be re-ignored",
    );
    assert.ok(
      lines.includes("!app-config/user-configurable/README.md"),
      "README.md should be whitelisted so the dir is tracked and operators see the override instructions",
    );
  });

  it("keeps app-data/ dir tracked but its CONTENTS ignored (so per-install runtime data survives tarball upgrade)", () => {
    assert.ok(
      lines.includes("app-data/*"),
      "contents under app-data/ should be ignored",
    );
    assert.ok(
      lines.includes("!app-data/README.md"),
      "app-data/README.md should be whitelisted so the dir ships in the release tarball",
    );
  });

  it("ignores logs/ entirely (write-only diagnostic output, auto-created on --log-file)", () => {
    assert.ok(
      lines.some((l) => l === "logs/" || l === "logs"),
      "logs/ should be in .gitignore (the app never reads it back; tarball-excluded; auto-mkdir on first write)",
    );
  });

  it("ignores node_modules", () => {
    assert.ok(
      lines.some((l) => l === "node_modules" || l === "node_modules/"),
      "node_modules should be in .gitignore",
    );
  });
});
