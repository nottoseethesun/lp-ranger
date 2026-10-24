"use strict";

/**
 * @file util/migration/settings-copies.js
 * @description
 * What the migration's steps share for the operator's copies of the
 * shipped settings files, in `app-config/user-configurable/`.
 *
 * An operator overrides a shipped settings file with a copy of it, whole
 * or in part, and LP Ranger checks every copy against its file's JSON
 * Schema at startup. A step that changes a copy reads it, changes it in
 * place, and answers a line for each change (`updateSettingsCopy`). The
 * old file is kept in the install's `tmp/` first, so each change can be
 * undone, and the copy is written back atomically. A dry run reports the
 * changes and makes none. Runs on Node built-ins only, like the rest of
 * the migration.
 */

const fs = require("fs");
const path = require("path");

/** Where the operator's copies are, in an install's folder. */
const USER_DIR = path.join("app-config", "user-configurable");

/** Whether `v` is a plain object. */
const isGroup = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Read a JSON file, or null when there is none. */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text);
}

/** Write a JSON file atomically. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(file + ".tmp", file);
}

/**
 * Take `keys` out of `group`, a line for each one taken. `at` names the
 * group in the file, and `v` gives the verb: done, or would be done.
 */
function dropKeys(group, keys, why, v, at = "") {
  if (!isGroup(group)) return [];
  return keys
    .filter((k) => Object.hasOwn(group, k))
    .map((k) => {
      delete group[k];
      return `${v("removed", "would remove")} ${at}${k}: ${why}`;
    });
}

/**
 * Copy `file` into the install's `tmp/`, before it is changed. Two steps
 * of one run can change the same file in the same millisecond, and so
 * name their copies alike: the copy already there is then the older
 * file, and stays.
 */
function keepCopy(root, file, stamp) {
  const name = path.basename(file, ".json");
  const copy = path.join(root, "tmp", `${name}.pre-migration-${stamp}.json`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  try {
    fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  return `kept a copy of the old ${path.basename(file)} at tmp/${path.basename(copy)}`;
}

/**
 * What a step's changes go by: whether this is a dry run, the stamp
 * naming the copies it keeps, and the verb each change is reported with.
 * @param {boolean} dryRun
 * @returns {{dryRun: boolean, stamp: string, verb: Function}}
 */
function migrationOptions(dryRun) {
  return {
    dryRun,
    stamp: new Date().toISOString().replace(/[:.]/g, "-"),
    verb: (done, would) => (dryRun ? would : done),
  };
}

/**
 * One copy's changes, made unless this is a dry run.
 * @param {string} root  The install's folder.
 * @param {string} file  The settings file's name.
 * @param {Function} change  Changes the copy in place, `(copy, verb)`, and
 *   answers a line for each change.
 * @param {object} o  From `migrationOptions`.
 * @returns {string[]}  The report's lines for this copy, or none.
 */
function updateSettingsCopy(root, file, change, o) {
  const at = path.join(root, USER_DIR, file);
  let copy;
  try {
    copy = readJson(at);
  } catch (err) {
    return [`${file}: not valid JSON (${err.message}); left as it was`];
  }
  if (!isGroup(copy)) return [];
  const lines = change(copy, o.verb).map((l) => `${file}: ${l}`);
  if (lines.length === 0 || o.dryRun) return lines;
  lines.push(keepCopy(root, at, o.stamp));
  writeJson(at, copy);
  return lines;
}

module.exports = {
  USER_DIR,
  isGroup,
  readJson,
  writeJson,
  dropKeys,
  keepCopy,
  migrationOptions,
  updateSettingsCopy,
};
