/**
 * @file test/rpc-url-setting.test.js
 * @description Tests that endpoints added with Bot Settings → Network →
 *   Add RPC actually reach the server, and reach it immediately.
 *
 * The control this replaced was a free-text combo box whose value was
 * written to localStorage and to `bot-config.json` and read back by
 * nothing — the bot used `.env` / `chains.json` regardless. A setting
 * that silently does nothing is worse than an absent one, because the
 * operator believes they have acted.
 *
 * Four behaviours are worth pinning:
 *   - added endpoints are honoured, and come FIRST;
 *   - the most recently added is the primary;
 *   - the shipped endpoints stay behind them, so choosing a private
 *     node does not silently cost you failover;
 *   - the change applies without a restart.
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
      global: { rpcUrls: ["https://my-node.local"] },
      positions: {},
    });
    assert.deepStrictEqual(readGlobalSetting("rpcUrls", dir), [
      "https://my-node.local",
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a key that was never set", () => {
    const dir = withConfigDir({ global: {}, positions: {} });
    assert.strictEqual(readGlobalSetting("rpcUrls", dir), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats an explicit null as unset", () => {
    /*- The dashboard can round-trip a cleared field as null; that means
     *  "no override", not "use the string null". */
    const dir = withConfigDir({ global: { rpcUrls: null }, positions: {} });
    assert.strictEqual(readGlobalSetting("rpcUrls", dir), undefined);
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
      assert.strictEqual(readGlobalSetting("rpcUrls", dir), undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe("composeRpcUrls", () => {
  /*- Drives the real exported function rather than re-implementing the
   *  composition rule locally.  A local copy is a mirror: it keeps
   *  passing after the real rule changes. */
  const SHIPPED = ["https://a.test", "https://b.test", "https://c.test"];

  it("puts an added endpoint first", () => {
    const urls = composeRpcUrls({
      saved: ["https://mine.test"],
      chainUrls: SHIPPED,
    });
    assert.strictEqual(urls[0], "https://mine.test");
  });

  it("keeps the shipped endpoints behind it as failover", () => {
    /*- The point of prepending rather than replacing: choosing your own
     *  node must not quietly cost you redundancy. */
    const urls = composeRpcUrls({
      saved: ["https://mine.test"],
      chainUrls: SHIPPED,
    });
    assert.deepStrictEqual(urls, ["https://mine.test", ...SHIPPED]);
  });

  it("makes the most recently added endpoint the primary", () => {
    /*- The Add RPC dialog prepends, so index 0 is the newest.  Pinned
     *  because "newest wins" is the whole contract of that button. */
    const urls = composeRpcUrls({
      saved: ["https://newest.test", "https://older.test"],
      chainUrls: SHIPPED,
    });
    assert.deepStrictEqual(urls, [
      "https://newest.test",
      "https://older.test",
      ...SHIPPED,
    ]);
  });

  it("is a no-op when the added endpoint is already the shipped primary", () => {
    const urls = composeRpcUrls({ saved: [SHIPPED[0]], chainUrls: SHIPPED });
    assert.deepStrictEqual(urls, SHIPPED, "must not list the same URL twice");
  });

  it("promotes an endpoint already further down the list", () => {
    const urls = composeRpcUrls({ saved: [SHIPPED[2]], chainUrls: SHIPPED });
    assert.deepStrictEqual(urls, [SHIPPED[2], SHIPPED[0], SHIPPED[1]]);
    assert.strictEqual(new Set(urls).size, urls.length, "no duplicates");
  });

  it("drops a repeat of an already-added endpoint", () => {
    /*- Re-adding one the operator already added promotes it rather than
     *  listing it twice — failing over to the endpoint just left is a
     *  wasted round-trip. */
    const urls = composeRpcUrls({
      saved: ["https://mine.test", "https://other.test", "https://mine.test"],
      chainUrls: SHIPPED,
    });
    assert.deepStrictEqual(urls, [
      "https://mine.test",
      "https://other.test",
      ...SHIPPED,
    ]);
  });

  it("falls back to the shipped list when nothing was added", () => {
    assert.deepStrictEqual(composeRpcUrls({ chainUrls: SHIPPED }), SHIPPED);
    assert.deepStrictEqual(
      composeRpcUrls({ saved: [], chainUrls: SHIPPED }),
      SHIPPED,
    );
  });

  it("ignores blank and whitespace-only entries", () => {
    assert.deepStrictEqual(
      composeRpcUrls({ saved: ["   ", ""], chainUrls: SHIPPED }),
      SHIPPED,
    );
  });

  it("trims an added value", () => {
    const urls = composeRpcUrls({
      saved: ["  https://mine.test  "],
      chainUrls: SHIPPED,
    });
    assert.strictEqual(urls[0], "https://mine.test");
  });

  it("layers added endpoints above env overrides", () => {
    const urls = composeRpcUrls({
      saved: ["https://mine.test"],
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

describe("an added RPC takes effect without a restart", () => {
  const sendTx = require("../src/send-transaction");
  const config = require("../src/config");

  class StubProvider {
    constructor(url) {
      this._url = url;
    }
    async send() {
      return "0x1";
    }
  }
  const LIB = { JsonRpcProvider: StubProvider };

  function bootedAtDefaults() {
    sendTx._resetForTests();
    sendTx.init({ urls: config.RPC_URLS_BASE }, LIB);
  }

  it("puts the new endpoint in use immediately", () => {
    bootedAtDefaults();
    const urls = composeRpcUrls({
      saved: ["https://my-node.local"],
      chainUrls: config.RPC_URLS_BASE,
    });
    assert.strictEqual(sendTx.setRpcUrls(urls, LIB), true);
    assert.strictEqual(
      sendTx.getCurrentRPC()._url,
      "https://my-node.local",
      "the very next on-chain read must use it",
    );
  });

  it("keeps the shipped endpoints behind it as failover", () => {
    bootedAtDefaults();
    const urls = composeRpcUrls({
      saved: ["https://my-node.local"],
      chainUrls: config.RPC_URLS_BASE,
    });
    sendTx.setRpcUrls(urls, LIB);
    assert.strictEqual(sendTx.failoverToNextRPC(), true);
    assert.strictEqual(sendTx.getCurrentRPC()._url, config.RPC_URLS_BASE[0]);
  });

  it("does not rebuild when the list has not changed", () => {
    /*- An unrelated config save must not reset a failover window that
     *  is doing its job. */
    bootedAtDefaults();
    assert.strictEqual(
      sendTx.setRpcUrls([...config.RPC_URLS_BASE], LIB),
      false,
    );
  });

  it("refuses an empty list rather than leaving no endpoints", () => {
    bootedAtDefaults();
    assert.throws(() => sendTx.setRpcUrls([], LIB), /non-empty/);
    assert.strictEqual(sendTx.getCurrentRPC()._url, config.RPC_URLS_BASE[0]);
  });
});

describe("config.setRpcUrls keeps the live list truthful", () => {
  /*- `GET /api/rpc-endpoints`, `rebalancer-pools` and
   *  `server-can-reopen` all read `config.RPC_URLS` directly, so the
   *  live list has to change in place.  A rebind would leave all three
   *  walking the endpoints the process started with — which is exactly
   *  the "saved but not in use" failure this whole feature exists to
   *  remove. */
  const config = require("../src/config");
  const { readRpcEndpoints } = require("../src/rpc-endpoints");

  it("updates what the endpoints route reports", () => {
    const original = [...config.RPC_URLS];
    try {
      config.setRpcUrls(["https://added.test", ...config.RPC_URLS_BASE]);
      const eps = readRpcEndpoints();
      assert.strictEqual(eps[0].url, "https://added.test");
      assert.strictEqual(eps[0].primary, true);
      assert.strictEqual(eps[1].primary, false);
    } finally {
      config.setRpcUrls(original);
    }
  });

  it("is the same array object, not a replacement", () => {
    const before = config.RPC_URLS;
    const original = [...config.RPC_URLS];
    try {
      config.setRpcUrls(["https://added.test"]);
      assert.strictEqual(config.RPC_URLS, before, "captured refs must see it");
      assert.deepStrictEqual(config.RPC_URLS, ["https://added.test"]);
    } finally {
      config.setRpcUrls(original);
    }
  });

  it("refuses an empty list", () => {
    assert.throws(() => config.setRpcUrls([]), /non-empty/);
    assert.ok(config.RPC_URLS.length > 0);
  });

  it("keeps a later sendTx.init() from throwing after a change", () => {
    /*- The sharp edge.  `sendTx.init` throws when handed a list that
     *  differs from the one it already holds, and bot-loop.js and
     *  position-manager.js call it on EVERY position start with
     *  `config.RPC_URLS`.  So the two have to move together: updating
     *  only sendTx would leave config stale, and the next Manage would
     *  hand init a mismatched list and take down the start path.
     *
     *  Driven through the real modules, in the real order, because the
     *  failure is an interaction between them and neither one looks
     *  wrong on its own. */
    const sendTx = require("../src/send-transaction");
    class StubProvider {
      constructor(url) {
        this._url = url;
      }
      async send() {
        return "0x1";
      }
    }
    const LIB = { JsonRpcProvider: StubProvider };
    const original = [...config.RPC_URLS];
    try {
      sendTx._resetForTests();
      sendTx.init({ urls: config.RPC_URLS }, LIB);

      const composed = composeRpcUrls({
        saved: ["https://added.test"],
        chainUrls: config.RPC_URLS_BASE,
      });
      config.setRpcUrls(composed);
      sendTx.setRpcUrls(composed, LIB);

      assert.doesNotThrow(
        () => sendTx.init({ urls: config.RPC_URLS }, LIB),
        "a position start after an RPC change must not throw",
      );
      assert.strictEqual(sendTx.getCurrentRPC()._url, "https://added.test");
    } finally {
      config.setRpcUrls(original);
      sendTx._resetForTests();
    }
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

  it("exposes the shipped list separately from the composed one", () => {
    /*- The server recomposes from RPC_URLS_BASE.  If that quietly
     *  became the same array as RPC_URLS, every save would re-seed the
     *  operator's own endpoints into the base and they could never be
     *  removed. */
    const config = require("../src/config");
    assert.ok(Array.isArray(config.RPC_URLS_BASE));
    assert.ok(config.RPC_URLS_BASE.length > 0);
    assert.notStrictEqual(config.RPC_URLS_BASE, config.RPC_URLS);
  });
});
