"use strict";

/**
 * @file util/diagnostic/print-resolved-settings.js
 * @description
 * Print the settings this install runs on, resolved: the `.env`
 * variables LP Ranger reads, with the environment over them, then each
 * JSON settings file by name, the operator's copy in
 * `app-config/user-configurable/` over the shipped one, as raw JSON. A
 * secret (`PRIVATE_KEY`, `WALLET_PASSWORD`) is named as set, never
 * shown.
 *
 * It reads the settings through `resolveSettings` (src/lib/settings-check.js),
 * the reading the `validate-config-values-with-any-user-overrides`
 * diagnostic checks, so what it prints is what that check judges. It
 * reads files and nothing else, so it is safe to run while the server is
 * up. Run it from the install's folder, where `.env` is.
 *
 * Usage:
 *   node util/diagnostic/print-resolved-settings.js
 */

const { Command } = require("commander");
const { resolveSettings } = require("../../src/lib/settings-check");
const { ENV_SETTINGS } = require("../../src/lib/env-settings");

/**
 * The command, declared once, so Commander both parses it and renders
 * its help from the same declaration. Built per call, so a test can
 * parse several argument lists without options accumulating.
 *
 * @returns {Command}  Configured, not yet parsed.
 */
function buildProgram() {
  return new Command()
    .name("print-resolved-settings")
    .description(
      "Print the settings this install runs on, resolved.\n\n" +
        "The .env variables LP Ranger reads, with the environment over\n" +
        "them (a secret is named as set, never shown), then each JSON\n" +
        "settings file with your copy in app-config/user-configurable/\n" +
        "over the shipped one. Run it from the install's folder.",
    );
}

/**
 * One line for each variable LP Ranger reads that has a value.
 * @param {object} env  `.env`'s values with the environment over them.
 * @returns {string[]}
 */
function _envLines(env) {
  const lines = [];
  for (const [name, setting] of Object.entries(ENV_SETTINGS)) {
    const value = env[name];
    if (value === undefined) continue;
    if (setting.secret !== true) lines.push(`${name}=${value}`);
    else if (value === "") lines.push(`${name} is empty`);
    else lines.push(`${name} is set; its value is not shown`);
  }
  return lines;
}

/**
 * Print the resolved settings.
 *
 * @param {string[]} [argv]  Arguments after the node/script pair.
 * @param {object} [o]       Test seams.
 * @param {(text: string) => void} [o.print]  Where the settings go.
 * @param {object} [o.where]  Where to read the settings from, as for
 *   `resolveSettings`; the install's own places otherwise.
 * @returns {number} The exit status: 0.
 */
function main(
  argv = process.argv.slice(2),
  { print = console.log, where } = {},
) {
  // Commander answers --help itself and refuses an unknown option.
  buildProgram().parse(argv, { from: "user" });
  const { resolved, env, problems } = resolveSettings(where);
  const lines = _envLines(env);
  print(".env, with the environment over it:");
  print(
    lines.length === 0 ? "  (none set)" : lines.map((l) => `  ${l}`).join("\n"),
  );
  for (const [file, settings] of Object.entries(resolved)) {
    print(`\n${file}:`);
    print(JSON.stringify(settings, null, 2));
  }
  if (problems.length > 0)
    print(
      `\nRead with problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  return 0;
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
