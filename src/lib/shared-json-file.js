/**
 * @file src/lib/shared-json-file.js
 * @module sharedJsonFile
 * @description
 * Read and replace a JSON file whole, so a write never leaves it half
 * written: the price caches, which LP Ranger and a tool under util/ that
 * prices through its library can write at once; the P&L epoch cache, the
 * scan caches the shared store keeps, the block-time cache, the token
 * symbols, the NFT mint dates, the pool creation blocks and the LP
 * position list (src/bot/epoch-cache.js, src/lib/cache-store.js,
 * src/bot/block-time-cache.js, src/lib/token-symbol-cache.js,
 * src/bot/position-history-mint.js, src/bot/pool-creation-block.js,
 * src/bot/lp-position-cache.js), which a full disk or a process killed
 * mid-write would otherwise leave cut short, for the next start to stop
 * on; and today's rebalance counts (src/bot/pool-daily-counts-file.js).
 * The text goes first into a folder of its own, which `fs.mkdtempSync`
 * makes beside the file. Node asks the operating system for it, which
 * adds six random characters to the name and creates the folder in the
 * same step, so no other process or write gets the same one. The file is
 * then renamed over the old one. A rename within one filesystem replaces
 * the file in one step (POSIX rename(2)), so a reader finds the old file
 * or the new one, never part of either. Of two processes' renames, the
 * later one wins whole. The folder is beside the file, not in the
 * system's temporary folder, because a rename cannot move a file from one
 * mounted filesystem to another, and `/tmp` is often its own. A file
 * replaced whole is written in full each time either way, so the copy
 * adds no writing to the disk.
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
const { tellFileProblem } = require("./file-problem");

/**
 * The object a JSON file holds: an empty one when the file is missing,
 * is not JSON, or holds something other than an object. A file there
 * that cannot be read as one is told as every caught file failure is
 * (src/lib/file-problem.js).
 * @param {string} filePath
 * @returns {Record<string, *>}
 */
function readJsonObject(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    tellFileProblem({ doing: "read", file: filePath, err });
    return {};
  }
  const isObject =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (isObject) return parsed;
  tellFileProblem({
    doing: "read",
    file: filePath,
    err: { message: "it holds no JSON object", invalidContent: true },
  });
  return {};
}

/**
 * Replace a file with an object's JSON text, whole: written into a new
 * folder beside the file, renamed over it, and the folder removed.
 * @param {string} filePath
 * @param {object} data
 * @param {object} [opts]
 * @param {typeof fs} [opts.fsModule]  The file system; Node's unless a
 *   caller that takes a stand-in for its tests passes it on.
 * @param {(key: string, value: *) => *} [opts.replacer]  As
 *   `JSON.stringify` takes it, for a value JSON has no form for, such as a
 *   BigInt.
 * @throws {Error} When the folder, the write or the rename fails; the file
 *   is then as it was.
 */
function replaceJsonFile(filePath, data, opts = {}) {
  const { fsModule = fs, replacer = null } = opts;
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  fsModule.mkdirSync(dir, { recursive: true });
  const own = fsModule.mkdtempSync(path.join(dir, `.${name}-`));
  try {
    const written = path.join(own, name);
    fsModule.writeFileSync(written, JSON.stringify(data, replacer, 2), "utf8");
    fsModule.renameSync(written, filePath);
  } finally {
    fsModule.rmSync(own, { recursive: true, force: true });
  }
}

module.exports = { readJsonObject, replaceJsonFile };
