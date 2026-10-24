"use strict";

/**
 * @file test/shared-json-file.test.js
 * @description Reading and writing a JSON file more than one process may
 *   write (src/lib/shared-json-file.js): a read that finds no object answers an
 *   empty one, and a write replaces the file whole, through a folder of
 *   its own beside it that it removes, and leaves the file as it was when
 *   it fails.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const {
  readJsonObject,
  replaceJsonFile,
} = require("../src/lib/shared-json-file");

/** A path in a new folder of the test process's own. */
const fileIn = (name) => path.join(makeTestTempFolder("shared-json"), name);

describe("readJsonObject", () => {
  it("answers an empty object for a file that is not there", () => {
    assert.deepEqual(readJsonObject(fileIn("cache.json")), {});
  });

  it("answers an empty object for a file that is not JSON", () => {
    const file = fileIn("cache.json");
    fs.writeFileSync(file, '{"cut short":');
    assert.deepEqual(readJsonObject(file), {});
  });

  it("answers an empty object for JSON that is not an object", () => {
    const file = fileIn("cache.json");
    for (const text of ["null", "[1, 2]", "7", '"text"']) {
      fs.writeFileSync(file, text);
      assert.deepEqual(readJsonObject(file), {}, text);
    }
  });

  it("answers the object the file holds", () => {
    const file = fileIn("cache.json");
    fs.writeFileSync(file, JSON.stringify({ a: { priceUsd: 1 } }));
    assert.deepEqual(readJsonObject(file), { a: { priceUsd: 1 } });
  });
});

describe("replaceJsonFile", () => {
  it("writes the object, making the folder it goes in", () => {
    const file = path.join(fileIn("nested"), "cache.json");
    replaceJsonFile(file, { a: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });
  });

  it("replaces the file whole and leaves nothing else beside it", () => {
    const file = fileIn("cache.json");
    fs.writeFileSync(file, JSON.stringify({ old: true, gone: 1 }));
    replaceJsonFile(file, { fresh: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      fresh: true,
    });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["cache.json"]);
  });

  it("leaves the file as it was, and nothing beside it, when the write fails", () => {
    const file = fileIn("cache.json");
    fs.writeFileSync(file, JSON.stringify({ kept: true }));
    assert.throws(() => replaceJsonFile(file, { price: 1n }), TypeError);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      kept: true,
    });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["cache.json"]);
  });
});
