/**
 * @file test/nft-providers.test.js
 * @description Unit tests for src/nft-providers.js and the
 * GET /api/nft-providers route handler. Covers the happy path (valid
 * JSON on disk), missing-file fallback, malformed-JSON fallback,
 * _comment stripping, case-insensitive keying, and the always-200
 * route contract.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const _FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
  "nft-providers.json",
);

let _originalContent = null;

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/nft-providers")];
}

beforeEach(() => {
  if (fs.existsSync(_FILE)) _originalContent = fs.readFileSync(_FILE, "utf8");
  _clearModuleCache();
});

afterEach(() => {
  if (_originalContent !== null) fs.writeFileSync(_FILE, _originalContent);
  _originalContent = null;
  _clearModuleCache();
});

describe("nft-providers.readNftProviders", () => {
  it("returns a label keyed by lowercase address", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        "0xABCDEF0123456789abcdef0123456789ABCDEF01": "Foo v1",
      }),
    );
    const { readNftProviders } = require("../src/nft-providers");
    const out = readNftProviders();
    assert.equal(out["0xabcdef0123456789abcdef0123456789abcdef01"], "Foo v1");
  });

  it("strips the _comment key", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ _comment: "doc", "0xAA": "X" }));
    const { readNftProviders } = require("../src/nft-providers");
    const out = readNftProviders();
    assert.equal(out._comment, undefined);
    assert.equal(out["0xaa"], "X");
  });

  it("skips non-string values and empty labels", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({ "0xAA": 42, "0xBB": "   ", "0xCC": "ok" }),
    );
    const { readNftProviders } = require("../src/nft-providers");
    const out = readNftProviders();
    assert.equal(out["0xaa"], undefined);
    assert.equal(out["0xbb"], undefined);
    assert.equal(out["0xcc"], "ok");
  });

  it("returns empty map when file is missing", () => {
    fs.unlinkSync(_FILE);
    const { readNftProviders } = require("../src/nft-providers");
    assert.deepEqual(readNftProviders(), {});
  });

  it("returns empty map when JSON is malformed", () => {
    fs.writeFileSync(_FILE, "{ not valid json");
    const { readNftProviders } = require("../src/nft-providers");
    assert.deepEqual(readNftProviders(), {});
  });
});

describe("nft-providers.handleNftProviders", () => {
  it("returns 200 with the current map", () => {
    fs.writeFileSync(_FILE, JSON.stringify({ "0xAA": "X v2" }));
    const { handleNftProviders } = require("../src/nft-providers");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleNftProviders({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody["0xaa"], "X v2");
  });

  it("returns 200 with empty map when file missing", () => {
    fs.unlinkSync(_FILE);
    const { handleNftProviders } = require("../src/nft-providers");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleNftProviders({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.deepEqual(gotBody, {});
  });
});
