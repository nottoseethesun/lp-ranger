#!/usr/bin/env node
/**
 * @file util/migration/index.js
 * @description
 * Bring an updated install's files up to date with this release. Run
 * once, from the new install's folder, straight after Step Six of the
 * Update section in README.md has copied the old install's files across.
 *
 * A release can move a file, split one, or retire a setting. The files
 * Step Six copies are the old release's, so each such change is a step
 * here, in the order the releases made them, and each says what it
 * changed. Each step is a file in a folder named for the release it
 * updates from (`from-0.9.9/`, `from-0.9.10/`); what steps share is in
 * this folder (`settings-copies.js`, `env-file.js`). Every step is safe
 * to run again: one that finds nothing left to change says nothing.
 *
 * Runs on Node built-ins only, so it works before `npm ci` has installed
 * anything, as Step Six's copy does.
 *
 * The CLI is self-documenting — run with `--help` for the full
 * reference.
 */

"use strict";

const path = require("path");
const { moveScanCaches } = require("./from-0.9.9/move-scan-caches");
const { movePositionRecords } = require("./from-0.9.9/move-position-records");
const {
  update099SettingCopies,
} = require("./from-0.9.9/update-099-setting-copies");
const { update099Env } = require("./from-0.9.9/update-099-env");
const {
  retirePriceMoveRetries,
} = require("./from-0.9.10/retire-price-move-retries");
const {
  dropOldGentleStopInterval,
} = require("./from-0.9.10/drop-old-gentle-stop-interval");

/** The steps, in the order the releases made their changes. */
const STEPS = Object.freeze([
  {
    title: "Scan caches move from tmp/ to app-data/scan-cache/",
    run: moveScanCaches,
  },
  {
    title:
      "Each position's records move from bot-config.json to app-data/position-records.json",
    run: movePositionRecords,
  },
  {
    title:
      "Copies of the settings files, as 0.9.9 laid them out, take this release's layout",
    run: update099SettingCopies,
  },
  {
    title: ".env, as 0.9.9 read it, is written as this release reads it",
    run: update099Env,
  },
  {
    title:
      "The settings for retrying a rebalance the price outran come out of app-runtime.json and .env",
    run: retirePriceMoveRetries,
  },
  {
    title:
      "A gentle-stop interval longer than this release allows comes out of app-runtime.json",
    run: dropOldGentleStopInterval,
  },
]);

const HELP_TEXT = `
migration — bring an updated install's files up to date with this release

USAGE
  cd lp-ranger-<new-version>
  node ./util/migration [options]

Run it once, straight after util/update/migrate-app-state.js (Step Six of
the Update section in README.md). It changes only files in this folder,
and prints each change. Running it again changes nothing more.

OPTIONS
  --dry-run   Report what would change, change nothing.
  --help      Show this text.
`.trim();

/**
 * Run every step over the install at `root`.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} [o.dryRun]  Report only.
 * @returns {Array<{title: string, lines: string[]}>}  What each step
 *   changed, or would change.
 */
function runMigration({ root, dryRun = false }) {
  return STEPS.map((s) => ({ title: s.title, lines: s.run({ root, dryRun }) }));
}

/** The report, as the CLI prints it. */
function report(results, dryRun) {
  const out = [];
  for (const { title, lines } of results) {
    if (lines.length === 0) continue;
    out.push(`${title}:`, ...lines.map((l) => `  ${l}`));
  }
  if (out.length === 0) return "Nothing to change: this install is up to date.";
  return [dryRun ? "Would change (dry run):" : "Changed:", ...out].join("\n");
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`Unrecognized argument: ${unknown[0]}\n\n${HELP_TEXT}`);
    process.exitCode = 2;
    return;
  }
  const dryRun = args.includes("--dry-run");
  console.log(
    report(runMigration({ root: path.resolve("."), dryRun }), dryRun),
  );
}

if (require.main === module) main(process.argv);

module.exports = { runMigration, report, STEPS, HELP_TEXT };
