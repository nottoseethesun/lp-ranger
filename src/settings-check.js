"use strict";

/**
 * @file src/settings-check.js
 * @module settings-check
 * @description
 * Every problem with the settings an install runs on, found at once: the
 * JSON settings files with the operator's copies over them, `.env`,
 * bot-config.json, and the bot's records beside it in
 * app-data/position-records.json.
 *
 * Each is held to the rules the test suite holds the shipped files to:
 * the JSON Schema of each JSON settings file (src/settings-file-rules.js),
 * the list of variables LP Ranger reads for `.env`
 * (src/env-settings.js), and src/bot-config-checks.js for bot-config.json,
 * whose JSON Schema holds each setting to the rule a save is held to, and
 * for the records. A problem is a value of the wrong kind or outside its
 * range, a setting LP Ranger does not read, a file that is not valid
 * JSON, or a copy in the operator's folder of a file the app never reads
 * from there. The `validate-config-values-with-any-user-overrides`
 * diagnostic lists them, and the server and the bot refuse to start
 * while there is any (`refuseToStartOnBadSettings`), rather than run on a
 * value nobody chose.
 *
 * It reads files and nothing else: no network, no log file, and none of
 * the app's own config, which stops at its first problem rather than
 * listing them all.
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
  DEFAULTS_DIR,
  USER_DIR,
  stripDocKeys,
  deepMerge,
} = require("./load-merged-defaults");
const {
  SETTINGS_FILE_SCHEMAS,
  NEVER_OVERRIDDEN,
  settingsFileProblems,
  agreementProblems,
} = require("./settings-file-rules");
const { envProblems, envFileProblems } = require("./env-settings");
const {
  botConfigProblems,
  positionRecordsProblems,
} = require("./bot-config-checks");
const { botConfigPath } = require("./bot-config-v2");
const { positionRecordsPath } = require("./position-records");

/*-
 *  Files the app keeps in the operator's folder that are not copies of a
 *  shipped settings file.
 */
const _APP_FILES = Object.freeze([
  "bot-config.json",
  "bot-config.backup.json",
  "wallet.json",
  "api-keys.json",
]);

/** A path as the operator would find it: from the install's folder. */
const _shown = (p) => path.relative(process.cwd(), p) || p;

/** A file's text, or undefined when there is no such file. */
function _read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
}

/** Whether the app reads an operator's copy of this file. */
const _overridable = (file) =>
  Object.hasOwn(SETTINGS_FILE_SCHEMAS, file) && !NEVER_OVERRIDDEN[file];

/**
 * Every JSON file in the operator's folder that the app does not read
 * from there: a copy of a file it never takes a copy of, or a file no
 * setting lives in.
 */
function _strayFiles(userDir) {
  let names;
  try {
    names = fs.readdirSync(userDir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !_overridable(f) && !_APP_FILES.includes(f))
    .map(
      (f) => `${_shown(path.join(userDir, f))} is not a file LP Ranger reads`,
    );
}

/**
 * Each settings file as an install resolves it, the operator's copy over
 * the shipped one, with every copy that is not valid JSON reported and
 * the shipped file standing in for it.
 */
function _resolveFiles(shippedDir, userDir, problems) {
  const shipped = {};
  const resolved = {};
  for (const file of Object.keys(SETTINGS_FILE_SCHEMAS)) {
    // A shipped file that is not JSON is a broken install, and throws.
    shipped[file] = stripDocKeys(
      JSON.parse(fs.readFileSync(path.join(shippedDir, file), "utf8")),
    );
    const copyPath = path.join(userDir, file);
    const text = _overridable(file) ? _read(copyPath) : undefined;
    resolved[file] = shipped[file];
    if (text === undefined) continue;
    try {
      resolved[file] = deepMerge(shipped[file], stripDocKeys(JSON.parse(text)));
    } catch (err) {
      problems.push(`${_shown(copyPath)} is not valid JSON: ${err.message}`);
    }
  }
  return { shipped, resolved };
}

/**
 * The settings an install runs on, read as the app reads them: each
 * JSON settings file with the operator's copy over the shipped one,
 * `.env`'s values with the environment over them, and bot-config.json's
 * text. `settingsProblems` checks what this returns, and the
 * `print-resolved-settings` diagnostic prints it.
 *
 * @param {object} [o]  Where to read from; the install's own places
 *   unless a test points elsewhere.
 * @param {string} [o.shippedDir]     The shipped settings files.
 * @param {string} [o.userDir]        The operator's copies of them.
 * @param {string} [o.envFile]        The `.env` file.
 * @param {object} [o.env]            The environment, over `.env`'s values
 *   as it is when the app loads `.env`.
 * @param {string} [o.botConfigFile]  bot-config.json.
 * @param {string} [o.recordsFile]    The records file,
 *   app-data/position-records.json (src/position-records.js).
 * @returns {{shipped: object, resolved: object, envText: (string|undefined),
 *   env: object, botText: (string|undefined),
 *   recordsText: (string|undefined), problems: string[]}}
 *   `resolved` holds each settings file by name; `problems` names each
 *   copy that is not valid JSON (the shipped file stands in for it) and
 *   each file in the operator's folder the app never reads.
 */
function resolveSettings({
  shippedDir = DEFAULTS_DIR,
  userDir = USER_DIR,
  envFile = path.resolve(".env"),
  env = process.env,
  botConfigFile = botConfigPath(),
  recordsFile = positionRecordsPath(),
} = {}) {
  const problems = [];
  const { shipped, resolved } = _resolveFiles(shippedDir, userDir, problems);
  problems.push(..._strayFiles(userDir));
  const envText = _read(envFile);
  // As the app loads `.env`: what the environment already sets stands.
  const fileEnv = envText === undefined ? {} : dotenv.parse(envText);
  return {
    shipped,
    resolved,
    envText,
    env: { ...fileEnv, ...env },
    botText: _read(botConfigFile),
    recordsText: _read(recordsFile),
    problems,
  };
}

/**
 * Every problem with an install's settings.
 *
 * @param {object} [where]  Where to read from, as for `resolveSettings`.
 * @returns {string[]}
 */
function settingsProblems(where) {
  const { resolved, envText, env, botText, recordsText, problems } =
    resolveSettings(where);
  const chains = resolved["chains.json"];
  for (const file of Object.keys(SETTINGS_FILE_SCHEMAS))
    problems.push(...settingsFileProblems(file, resolved[file]));
  problems.push(...agreementProblems((file) => resolved[file]));
  if (envText !== undefined) problems.push(...envFileProblems(envText));
  problems.push(
    ...envProblems(env, {
      chains,
      appRuntime: resolved["app-runtime.json"],
      botDefaults: resolved["bot-config-defaults.json"],
    }),
  );
  const botCtx = {
    compoundMinFeeUsd: resolved["app-runtime.json"]?.compound?.minFeeUsd,
  };
  if (botText !== undefined)
    problems.push(...botConfigProblems(botText, botCtx));
  if (recordsText !== undefined)
    problems.push(...positionRecordsProblems(recordsText));
  return problems;
}

/**
 * The report of an install's problems, as startup and the diagnostic
 * print it.
 * @param {string[]} problems
 * @returns {string}
 */
function problemsReport(problems) {
  const n = problems.length;
  return [
    `Found ${n} problem${n === 1 ? "" : "s"} in the settings:`,
    ...problems.map((p) => `  - ${p}`),
    "Correct each one, or remove the setting to use its default.",
  ].join("\n");
}

/**
 * Refuse to start while any setting is wrong: print every problem and
 * exit. The server and the bot call this before they read a setting, so
 * the app never runs on a value nobody chose. `npm stop` and
 * `npm run gentle-stop` do not, so a bad setting never keeps an operator
 * from stopping a server that is running.
 *
 * @param {object} [o]  Test seams; the process's own otherwise.
 * @param {(text: string) => void} [o.print]
 * @param {(code: number) => void} [o.exit]
 * @param {object} [o.where]  As for `settingsProblems`.
 */
function refuseToStartOnBadSettings({
  print = (text) => process.stderr.write(`${text}\n`),
  exit = (code) => process.exit(code),
  where = {},
} = {}) {
  const problems = settingsProblems(where);
  if (problems.length === 0) return;
  print(
    `[config] LP Ranger cannot start. ${problemsReport(problems)} Then ` +
      "start it again.",
  );
  exit(1);
}

module.exports = {
  resolveSettings,
  settingsProblems,
  problemsReport,
  refuseToStartOnBadSettings,
};
