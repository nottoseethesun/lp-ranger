/**
 * @file test/rpc-url-setting.test.js
 * @description Tests that the RPC URL saved in Bot Settings actually
 *   reaches the server.
 *
 * It did not, for a long time. The dashboard wrote the value to
 * localStorage and to `bot-config.json`, the help text promised a
 * restart would apply it, and nothing ever read it back — the bot used
 * `.env` / `chains.json` regardless. A setting that silently does
 * nothing is worse than an absent one, because the operator believes
 * they have acted.
 *
 * Two behaviours are worth pinning:
 *   - the saved value is honoured, and comes FIRST;
 *   - the shipped endpoints stay behind it, so choosing a private node
 *     does not silently cost you failover.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readGlobalSetting } = require("../src/bot-config-v2");
const { composeRpcUrls } = require("../src/rpc-url-list");

/** Write a bot-config.json into a throwaway directory. */
function withConfigDir(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-setting-"));
  if (contents !== null) {
    fs.writeFileSync(
      path.join(dir, "bot-config.json"),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return dir;
}

describe("readGlobalSetting", () => {
  it("reads a saved global value", () => {
    const dir = withConfigDir({
      global: { rpcUrl: "https://my-node.local" },
      positions: {},
    });
    assert.strictEqual(
      readGlobalSetting("rpcUrl", dir),
      "https://my-node.local",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a key that was never set", () => {
    const dir = withConfigDir({ global: {}, positions: {} });
    assert.strictEqual(readGlobalSetting("rpcUrl", dir), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats an explicit null as unset", () => {
    /*- The dashboard can round-trip a cleared field as null; that means
     *  "no override", not "use the string null". */
    const dir = withConfigDir({ global: { rpcUrl: null }, positions: {} });
    assert.strictEqual(readGlobalSetting("rpcUrl", dir), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /*- The three ways a config file can be unusable.  None may throw:
   *  this runs during config.js module init, so a throw here would take
   *  down every import of config — including the ones that have nothing
   *  to do with RPC. */
  for (const [label, contents] of [
    ["a malformed file", "{ not json"],
    ["an empty file", ""],
    ["no file at all", null],
  ]) {
    it(`returns undefined for ${label}, without throwing`, () => {
      const dir = withConfigDir(contents);
      assert.strictEqual(readGlobalSetting("rpcUrl", dir), undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe("composeRpcUrls", () => {
  /*- Drives the real exported function.  This block used to re-implement
   *  the composition rule locally, which is a mirror: it would have gone
   *  on passing after the real rule changed. */
  const SHIPPED = ["https://a.test", "https://b.test", "https://c.test"];

  it("puts the saved endpoint first", () => {
    const urls = composeRpcUrls({
      saved: "https://mine.test",
      chainUrls: SHIPPED,
    });
    assert.strictEqual(urls[0], "https://mine.test");
  });

  it("keeps the shipped endpoints behind it as failover", () => {
    /*- The point of prepending rather than replacing: choosing your own
     *  node must not quietly cost you redundancy. */
    const urls = composeRpcUrls({
      saved: "https://mine.test",
      chainUrls: SHIPPED,
    });
    assert.deepStrictEqual(urls, ["https://mine.test", ...SHIPPED]);
  });

  it("is a no-op when the saved value is already the shipped primary", () => {
    const urls = composeRpcUrls({ saved: SHIPPED[0], chainUrls: SHIPPED });
    assert.deepStrictEqual(urls, SHIPPED, "must not list the same URL twice");
  });

  it("promotes a saved endpoint already further down the list", () => {
    const urls = composeRpcUrls({ saved: SHIPPED[2], chainUrls: SHIPPED });
    assert.deepStrictEqual(urls, [SHIPPED[2], SHIPPED[0], SHIPPED[1]]);
    assert.strictEqual(new Set(urls).size, urls.length, "no duplicates");
  });

  it("falls back to the shipped list when nothing is saved", () => {
    assert.deepStrictEqual(composeRpcUrls({ chainUrls: SHIPPED }), SHIPPED);
  });

  it("ignores a blank or whitespace-only saved value", () => {
    assert.deepStrictEqual(
      composeRpcUrls({ saved: "   ", chainUrls: SHIPPED }),
      SHIPPED,
    );
  });

  it("trims a saved value", () => {
    const urls = composeRpcUrls({
      saved: "  https://mine.test  ",
      chainUrls: SHIPPED,
    });
    assert.strictEqual(urls[0], "https://mine.test");
  });

  it("layers a saved value above env overrides", () => {
    const urls = composeRpcUrls({
      saved: "https://mine.test",
      envOverrides: ["https://env.test"],
      chainUrls: SHIPPED,
    });
    assert.strictEqual(urls[0], "https://mine.test");
    assert.strictEqual(urls[1], "https://env.test", "env overrides slot 0");
  });

  it("lets a blank env entry fall through to the shipped endpoint", () => {
    const urls = composeRpcUrls({
      envOverrides: ["", "https://env-two.test"],
      chainUrls: SHIPPED,
    });
    assert.deepStrictEqual(urls, [
      SHIPPED[0],
      "https://env-two.test",
      SHIPPED[2],
    ]);
  });

  it("returns an empty list when there is nothing to compose", () => {
    assert.deepStrictEqual(composeRpcUrls(), []);
    assert.deepStrictEqual(composeRpcUrls({}), []);
  });
});

describe("the live config", () => {
  it("exposes a non-empty ordered endpoint list", () => {
    const config = require("../src/config");
    assert.ok(Array.isArray(config.RPC_URLS));
    assert.ok(config.RPC_URLS.length > 0);
    assert.strictEqual(config.RPC_URL, config.RPC_URLS[0]);
  });

  it("contains no duplicate endpoints", () => {
    const config = require("../src/config");
    assert.strictEqual(
      new Set(config.RPC_URLS).size,
      config.RPC_URLS.length,
      "failing over to the endpoint we just left is a wasted round-trip",
    );
  });
});
