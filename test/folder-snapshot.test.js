"use strict";

/**
 * @file test/folder-snapshot.test.js
 * @description What `npm run check` compares to tell that the tests left
 *   the install's folders as they found them (scripts/_folder-snapshot.js):
 *   a file created, removed or written is named, and so is a folder in
 *   which a file came and went, the way a test's fixture written and
 *   removed again in the shipped settings folder once failed other tests
 *   now and then. Each case works in a temp folder of its own.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  folderSnapshot,
  snapshotChanges,
} = require("../scripts/_folder-snapshot");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

/** A temp folder holding `a.json`, and `cache/b.json` in a subfolder. */
function folderWithFiles() {
  const dir = makeTestTempFolder("snapshot");
  fs.writeFileSync(path.join(dir, "a.json"), "{}");
  fs.mkdirSync(path.join(dir, "cache"));
  fs.writeFileSync(path.join(dir, "cache", "b.json"), "{}");
  return dir;
}

describe("a folder's snapshot", () => {
  it("names no change when nothing changed", () => {
    const dir = folderWithFiles();
    const before = folderSnapshot(dir);
    assert.deepEqual(snapshotChanges("f", before, folderSnapshot(dir)), []);
  });

  it("names a file created in a subfolder, and the subfolder", () => {
    const dir = folderWithFiles();
    const before = folderSnapshot(dir);
    fs.writeFileSync(path.join(dir, "cache", "c.json"), "{}");
    assert.deepEqual(snapshotChanges("f", before, folderSnapshot(dir)), [
      "f/cache/c.json was created",
      "f/cache: a file was created or removed in it",
    ]);
  });

  it("names a file written", () => {
    const dir = folderWithFiles();
    const before = folderSnapshot(dir);
    fs.writeFileSync(path.join(dir, "a.json"), '{ "x": 1 }');
    assert.deepEqual(snapshotChanges("f", before, folderSnapshot(dir)), [
      "f/a.json was written",
    ]);
  });

  it("names a file removed, and the folder", () => {
    const dir = folderWithFiles();
    const before = folderSnapshot(dir);
    fs.unlinkSync(path.join(dir, "a.json"));
    assert.deepEqual(snapshotChanges("f", before, folderSnapshot(dir)), [
      "f/a.json was removed",
      "f: a file was created or removed in it",
    ]);
  });

  it("names the folder a file came and went in", () => {
    const dir = folderWithFiles();
    const before = folderSnapshot(dir);
    fs.writeFileSync(path.join(dir, "fixture.json"), "{}");
    fs.unlinkSync(path.join(dir, "fixture.json"));
    assert.deepEqual(snapshotChanges("f", before, folderSnapshot(dir)), [
      "f: a file was created or removed in it",
    ]);
  });

  it("is empty for a missing folder", () => {
    const dir = path.join(makeTestTempFolder("snapshot"), "missing");
    assert.deepEqual(folderSnapshot(dir), {});
  });
});
