#!/usr/bin/env node
/**
 * @file scripts/markdownlint.js
 * @description
 * Runs markdownlint-cli2 over the canonical Markdown target list from
 * `scripts/lint-targets.js`. Backs both `npm run lint` (check) and
 * `npm run lint:fix` (`--fix`).
 *
 * Why a script rather than an inline npm script: the list was written
 * out by hand in three places and drifted. `lint:fix` was missing
 * `docs/architecture.md`, `docs/configuration.md` and
 * `docs/engineering.md`, so the check pass reported violations in files
 * the fix pass would never touch. Imported once, the two passes cannot
 * cover different files. Mirrors `scripts/format.js` and
 * `scripts/audit.js`, which centralise their lists the same way.
 *
 * Usage:
 *   node scripts/markdownlint.js          # check
 *   node scripts/markdownlint.js --fix    # rewrite in place
 *
 * Exit code: markdownlint-cli2's own.
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { MARKDOWN_TARGETS } = require("./lint-targets");

const ROOT = path.resolve(__dirname, "..");

/** Resolve a binary from node_modules/.bin — never `npx`. */
function bin(name) {
  return path.join(ROOT, "node_modules", ".bin", name);
}

function main() {
  const fix = process.argv.includes("--fix");
  const args = fix ? ["--fix", ...MARKDOWN_TARGETS] : [...MARKDOWN_TARGETS];
  const res = spawnSync(bin("markdownlint-cli2"), args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  process.exit(res.status === null ? 1 : res.status);
}

main();
