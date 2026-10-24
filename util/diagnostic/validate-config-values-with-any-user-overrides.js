"use strict";

/**
 * @file util/diagnostic/validate-config-values-with-any-user-overrides.js
 * @description
 * Check every setting this install runs on, and list each problem: the
 * JSON settings files with the operator's copies in
 * `app-config/user-configurable/` over them, `.env`, bot-config.json, and
 * the bot's records beside it in `app-data/position-records.json`.
 *
 * It holds them to the rules the server and the bot hold them to at
 * startup, where any problem stops them: both ask the same library,
 * src/lib/settings-check.js, so this tool's verdict is startup's. The test
 * suite checks only the files that ship, so its answer is the same on
 * every machine; this is how an install's own values are checked, before
 * a restart or after an upgrade.
 *
 * It reads files and nothing else: no network, no log file, and none of
 * the app's own config, which would stop at its first problem rather than
 * list them all. So it is safe to run while the server is up. Run it from
 * the install's folder, where `.env` and bot-config.json are.
 *
 * Exit status is 0 when every setting passes and 1 otherwise, so it can
 * gate a shell script.
 *
 * Usage:
 *   node util/diagnostic/validate-config-values-with-any-user-overrides.js
 */

const { Command } = require("commander");
const {
  settingsProblems,
  problemsReport,
} = require("../../src/lib/settings-check");

/**
 * The command, declared once, so Commander both parses it and renders
 * its help from the same declaration. Built per call, so a test can
 * parse several argument lists without options accumulating.
 *
 * @returns {Command}  Configured, not yet parsed.
 */
function buildProgram() {
  return new Command()
    .name("validate-config-values-with-any-user-overrides")
    .description(
      "Check every setting this install runs on, and list each problem.\n\n" +
        "The JSON settings files with your copies in\n" +
        "app-config/user-configurable/ over them, .env, bot-config.json and\n" +
        "the records in app-data/position-records.json, held to the rules\n" +
        "the server and the bot hold them to at startup.\n" +
        "Run it from the install's folder.",
    )
    .addHelpText(
      "after",
      "\nExit status: 0 when every setting passes, 1 when any does not.",
    );
}

/**
 * Check the settings and print the verdict.
 *
 * @param {string[]} [argv]  Arguments after the node/script pair.
 * @param {object} [o]       Test seams.
 * @param {(text: string) => void} [o.print]  Where the verdict goes.
 * @param {object} [o.where]  Where to read the settings from, as for
 *   `settingsProblems`; the install's own places otherwise.
 * @returns {number} The exit status: 0 when every setting passes.
 */
function main(
  argv = process.argv.slice(2),
  { print = console.log, where } = {},
) {
  /*-
   *  `from: "user"` because argv is already stripped of the node and
   *  script entries. Commander handles --help and -h itself, printing to
   *  stdout and exiting 0, and refuses an unknown option.
   */
  buildProgram().parse(argv, { from: "user" });
  const problems = settingsProblems(where);
  if (problems.length === 0) {
    print(
      "Every setting passes: the JSON settings files with your copies, " +
        ".env, bot-config.json and the records file.",
    );
    return 0;
  }
  print(problemsReport(problems));
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildProgram, main };
