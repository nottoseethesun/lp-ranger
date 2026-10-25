"use strict";

/**
 * @file src/lib/test-temp-folders.js
 * @module testTempFolders
 * @description
 * The temp folders a test process makes, and their removal, so a test
 * run leaves none behind.
 *
 * A test that needs a folder of its own takes one from
 * `makeTestTempFolder`. So do `src/lib/bot-config-v2.js` and
 * `src/lib/scan-cache-dir.js`, which under `node --test` resolve the config
 * folder and the scan-cache folder to such folders rather than
 * `app-config/user-configurable/` and `app-data/scan-cache/`, so no test
 * can write the operator's bot-config.json or caches. Each folder
 * belongs to one process: the runner runs test files in parallel
 * processes, which would otherwise overwrite one another's files. The
 * folders are in the system's temp directory (`os.tmpdir()`), outside
 * the install.
 *
 * A folder is named `lp-ranger-test-<purpose>-<pid>-<random>`, for its
 * purpose and its process, and goes when its process exits, whether its
 * tests passed or failed: one exit hook removes every folder whose name
 * gives it to the process, however many it made. A process stopped
 * outright (Ctrl+C, kill -9) cannot remove its own, so `npm run check`
 * calls `removeLeftoverTestTempFolders` before its tests start, removing
 * each folder whose process is no longer running. None accumulates.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const _PREFIX = "lp-ranger-test-";

/**
 * Make a folder for this process, removed when the process exits.
 *
 * The first folder a process makes sets the exit hook that removes them
 * all (`_removeOwnFolders`). One hook rather than one for each folder: a
 * test file can make dozens, and past ten exit hooks Node warns of a
 * leak.
 *
 * @param {string} purpose  What it is for, in its name: letters, digits
 *   and hyphens, e.g. `config`.
 * @returns {string} The folder's path.
 */
function makeTestTempFolder(purpose) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `${_PREFIX}${purpose}-${process.pid}-`),
  );
  if (!process.listeners("exit").includes(_removeOwnFolders))
    process.once("exit", _removeOwnFolders);
  return dir;
}

/**
 * Remove every folder in the system's temp directory whose name gives it
 * to this process.
 */
function _removeOwnFolders() {
  const dir = os.tmpdir();
  for (const name of fs.readdirSync(dir))
    if (_ownerOf(name) === process.pid)
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

/**
 * The process a folder belongs to, read from its name, or null for a
 * name that is not a test folder's. The process number is the
 * next-to-last part: the random end the system adds holds no hyphen.
 * @param {string} name
 * @returns {number|null}
 */
function _ownerOf(name) {
  if (!name.startsWith(_PREFIX)) return null;
  const parts = name.slice(_PREFIX.length).split("-");
  if (parts.length < 3) return null;
  const pid = parts[parts.length - 2];
  return /^\d+$/.test(pid) ? Number(pid) : null;
}

/**
 * Whether a process is running. Signal 0 sends nothing: it only asks.
 * A process of another user's answers EPERM, which still means running.
 * @param {number} pid
 * @returns {boolean}
 */
function _running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Remove every test folder whose process has ended without removing it.
 * A running process's folder is left alone, so a test run under way
 * elsewhere keeps its files.
 * @param {string} [dir]  Where the folders are; the system's temp
 *   directory unless a test points elsewhere.
 * @returns {number} How many were removed.
 */
function removeLeftoverTestTempFolders(dir = os.tmpdir()) {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const pid = _ownerOf(name);
    if (pid === null || _running(pid)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

module.exports = { makeTestTempFolder, removeLeftoverTestTempFolders };
