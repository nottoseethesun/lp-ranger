#!/usr/bin/env node
/**
 * @file scripts/audit.js
 * @description
 * Runs the two security passes over the canonical target lists from
 * `scripts/lint-targets.js`.  Backs `npm run audit:security`
 * (`--security`) and `npm run audit:secrets` (`--secrets`).
 *
 * Why a script rather than inline npm scripts: the standalone command
 * and the `npm run check` gate need identical target lists, and a list
 * spelled out in both places can differ without either reporting it —
 * each pass succeeds on whatever it was given.  Importing the lists
 * from `lint-targets.js` makes them one list.
 *
 * Usage:
 *   node scripts/audit.js --security
 *   node scripts/audit.js --secrets
 *
 * Exit codes:
 *   0 — clean
 *   1 — bad arguments
 *   the underlying tool's exit code otherwise
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { SECURITY_TARGETS, SECRET_TARGETS } = require("./lint-targets");

const ROOT = path.resolve(__dirname, "..");

/** Resolve a binary from node_modules/.bin — never `npx`. */
function bin(name) {
  return path.join(ROOT, "node_modules", ".bin", name);
}

function main() {
  const mode = process.argv[2];
  let cmd;
  let args;
  if (mode === "--security") {
    cmd = bin("eslint");
    args = [
      "-c",
      "eslint-security.config.js",
      ...SECURITY_TARGETS,
      "--max-warnings",
      "0",
    ];
  } else if (mode === "--secrets") {
    cmd = bin("secretlint");
    args = [...SECRET_TARGETS];
  } else {
    console.error("usage: node scripts/audit.js --security|--secrets");
    process.exit(1);
  }
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  process.exit(res.status === null ? 1 : res.status);
}

main();
