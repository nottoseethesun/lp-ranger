/**
 * @file src/shared-json-file.js
 * @module sharedJsonFile
 * @description
 * Read and write a JSON file that more than one process may write at
 * once: the price caches, which LP Ranger and a tool under util/ that
 * prices through its library can write together.
 *
 * A write never leaves the file half written. The text goes first into a
 * folder of its own, which `fs.mkdtempSync` makes beside the file. Node
 * asks the operating system for it, which adds six random characters to
 * the name and creates the folder in the same step, so no other process
 * or write gets the same one. The file is then renamed over the old one.
 * A rename within one filesystem replaces the file in one step (POSIX
 * rename(2)), so a reader finds the old file or the new one, never part
 * of either. Of two processes' renames, the later one wins whole. The
 * folder is beside the file, not in the system's temporary folder,
 * because a rename cannot move a file from one mounted filesystem to
 * another, and `/tmp` is often its own.
 *
 * A whole-file write still drops what another process wrote since this
 * one read the file. So a writer merges first: it reads the file as it is
 * at that moment (`readJsonObject`), lays its own entries over it, and
 * writes the result (`replaceJsonFile`). The read and the rename are two
 * steps: an entry another process writes after this one's read and
 * before its rename is dropped from the file. A writer that lays all of
 * its entries over the file, not only its newest, puts them back with its
 * next write.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * The object a JSON file holds: an empty one when the file is missing,
 * is not JSON, or holds something other than an object.
 * @param {string} filePath
 * @returns {Record<string, *>}
 */
function readJsonObject(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
  const isObject =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  return isObject ? parsed : {};
}

/**
 * Replace a file with an object's JSON text, whole: written into a new
 * folder beside the file, renamed over it, and the folder removed.
 * @param {string} filePath
 * @param {object} data
 * @throws {Error} When the folder, the write or the rename fails; the file
 *   is then as it was.
 */
function replaceJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const own = fs.mkdtempSync(path.join(dir, `.${name}-`));
  try {
    const written = path.join(own, name);
    fs.writeFileSync(written, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(written, filePath);
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
}

module.exports = { readJsonObject, replaceJsonFile };
