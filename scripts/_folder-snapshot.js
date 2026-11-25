/**
 * @file scripts/_folder-snapshot.js
 * @description What a folder holds, for `npm run check`'s check that the
 *   tests leave the install's folders as they found them
 *   (scripts/check.js): the shipped settings folder, the operator's
 *   settings folder and app-data/. A test that writes or removes a file
 *   in one, even for a moment, can fail another test reading it, and a
 *   test run outside the gate would leave the operator's own files
 *   changed. A check of the tests' sources cannot see every way a test
 *   can write, so the gate compares what the folders hold before the
 *   tests and after them.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * What `dir` and its subfolders hold: each file's size and modification
 * time, and each folder's own modification time, which moves when an
 * entry is created, removed or renamed in it, even one that came and
 * went.
 * @param {string} dir
 * @returns {Record<string, string>} Each entry's path within `dir`
 *   ("." for `dir` itself) to what was read of it; empty for a missing
 *   `dir`.
 */
function folderSnapshot(dir) {
  const held = {};
  const walk = (folder, rel) => {
    held[rel] = `folder, ${fs.statSync(folder).mtimeMs}`;
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      const p = path.join(folder, e.name);
      const r = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else {
        const s = fs.statSync(p);
        held[r] = `${s.size} bytes, ${s.mtimeMs}`;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, ".");
  return held;
}

/**
 * How a folder changed between two snapshots, in words: each entry
 * created, removed or written, and each folder in which a file came and
 * went; sorted, since a folder lists its entries in no set order.
 * @param {string} label  The folder, as the words name it.
 * @param {Record<string, string>} before  `folderSnapshot` before.
 * @param {Record<string, string>} after   `folderSnapshot` after.
 * @returns {string[]}
 */
function snapshotChanges(label, before, after) {
  const changes = [];
  const named = (k) => (k === "." ? label : `${label}/${k}`);
  for (const k of Object.keys(after))
    if (!(k in before)) changes.push(`${named(k)} was created`);
  for (const k of Object.keys(before)) {
    if (!(k in after)) changes.push(`${named(k)} was removed`);
    else if (before[k] !== after[k])
      changes.push(
        before[k].startsWith("folder")
          ? `${named(k)}: a file was created or removed in it`
          : `${named(k)} was written`,
      );
  }
  return changes.sort();
}

module.exports = { folderSnapshot, snapshotChanges };
