/**
 * @file test/rpc-endpoints.test.js
 * @description Tests for `GET /api/rpc-endpoints`, which feeds the RPC
 *   endpoint list in Bot Settings → Network and the Add RPC dialog.
 *
 * Hardcoding the list in index.html would let the menu offer an
 * endpoint that is not in the failover chain, advertising something the
 * bot would never use. Serving it from the same config the failover
 * walks makes that impossible — but only if this route reports the
 * configured order faithfully, so that is what these tests pin.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const {
  readRpcEndpoints,
  handleRpcEndpoints,
  _describe,
  readSavedRpcUrls,
} = require("../src/rpc-endpoints");
const config = require("../src/config");

describe("_describe — how one endpoint is presented", () => {
  it("labels the first endpoint as the primary", () => {
    const e = _describe("https://rpc-pulsechain.g4mm4.io", 0);
    assert.strictEqual(e.host, "rpc-pulsechain.g4mm4.io");
    assert.strictEqual(e.label, "rpc-pulsechain.g4mm4.io (primary)");
    assert.strictEqual(e.primary, true);
  });

  it("numbers the rest by their position in the failover order", () => {
    /*- The ordinal is the useful part: the raw URL does not tell an
     *  operator what the bot will do with it. */
    assert.strictEqual(
      _describe("https://rpc.pulsechain.com", 1).label,
      "rpc.pulsechain.com (fallback 1)",
    );
    assert.strictEqual(
      _describe("https://rpc.pulsechain.box", 2).label,
      "rpc.pulsechain.box (fallback 2)",
    );
    assert.strictEqual(_describe("https://x.test", 2).primary, false);
  });

  it("keeps the full URL alongside the display host", () => {
    /*- The list shows the host; the title attribute carries the whole
     *  URL, so both have to survive. */
    const e = _describe("https://rpc.example.com/v1/abc", 1);
    assert.strictEqual(e.url, "https://rpc.example.com/v1/abc");
    assert.strictEqual(e.host, "rpc.example.com");
  });

  it("shows an unparseable entry verbatim rather than hiding it", () => {
    /*- An operator who configured something odd should see it, not find
     *  it silently missing from the list. */
    const e = _describe("not a url", 1);
    assert.strictEqual(e.url, "not a url");
    assert.strictEqual(e.host, "not a url");
  });
});

describe("readRpcEndpoints — the served list", () => {
  it("returns one entry per configured endpoint, in order", () => {
    const list = readRpcEndpoints();
    assert.deepStrictEqual(
      list.map((e) => e.url),
      config.RPC_URLS,
      "the list must be the same one, in the same order, that failover walks",
    );
  });

  it("marks exactly one entry primary, and it is the first", () => {
    const list = readRpcEndpoints();
    const primaries = list.filter((e) => e.primary);
    assert.strictEqual(primaries.length, 1);
    assert.strictEqual(primaries[0].url, list[0].url);
  });

  it("gives every entry a non-empty label", () => {
    for (const e of readRpcEndpoints()) {
      assert.ok(e.label && e.label.length > 0, `no label for ${e.url}`);
    }
  });
});

describe("handleRpcEndpoints — the route", () => {
  /** Capture what the handler would send. */
  function capture() {
    const sent = {};
    const jsonResponse = (_res, status, body) => {
      sent.status = status;
      sent.body = body;
    };
    handleRpcEndpoints({}, {}, jsonResponse);
    return sent;
  }

  it("always answers 200 with an endpoints array", () => {
    /*- The dashboard treats a failure here as "no list", which costs
     *  the display rather than the ability to run — so this route has
     *  no reason to ever return an error status. */
    const sent = capture();
    assert.strictEqual(sent.status, 200);
    assert.ok(Array.isArray(sent.body.endpoints));
  });

  it("serves the same list readRpcEndpoints computes", () => {
    assert.deepStrictEqual(capture().body.endpoints, readRpcEndpoints());
  });

  it("reports the operator-added endpoints separately", () => {
    /*- The Add RPC dialog prepends to THIS list, not to `endpoints`.
     *  Sending the composed list back instead would make the first save
     *  copy the shipped endpoints into saved config, where they would
     *  then stop tracking chains.json. */
    const sent = capture();
    assert.ok(Array.isArray(sent.body.saved));
    assert.deepStrictEqual(sent.body.saved, readSavedRpcUrls());
  });

  it("reports no added endpoints on a fresh install", () => {
    assert.deepStrictEqual(readSavedRpcUrls(), []);
  });
});
