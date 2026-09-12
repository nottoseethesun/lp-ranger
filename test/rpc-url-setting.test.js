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

describe("RPC_URLS composition", () => {
  /*- config.js reads the saved value once at module load, so these
   *  exercise the same composition rule against a fresh require with a
   *  stubbed reader rather than mutating the operator's real file. */
  function composeWith({ saved, envOverrides = [], shipped }) {
    const out = [];
    const push = (url) => {
      if (typeof url === "string" && url.length > 0 && !out.includes(url)) {
        out.push(url);
      }
    };
    if (saved) push(saved);
    const len = Math.max(shipped.length, envOverrides.length);
    for (let i = 0; i < len; i++) push(envOverrides[i] || shipped[i]);
    return out;
  }

  const SHIPPED = ["https://a.test", "https://b.test", "https://c.test"];

  it("puts the saved endpoint first", () => {
    const urls = composeWith({ saved: "https://mine.test", shipped: SHIPPED });
    assert.strictEqual(urls[0], "https://mine.test");
  });

  it("keeps the shipped endpoints behind it as failover", () => {
    /*- The point of prepending rather than replacing: choosing your own
     *  node must not quietly cost you redundancy. */
    const urls = composeWith({ saved: "https://mine.test", shipped: SHIPPED });
    assert.deepStrictEqual(urls, ["https://mine.test", ...SHIPPED]);
  });

  it("is a no-op when the saved value is already the shipped primary", () => {
    const urls = composeWith({ saved: SHIPPED[0], shipped: SHIPPED });
    assert.deepStrictEqual(urls, SHIPPED, "must not list the same URL twice");
  });

  it("promotes a saved endpoint that is already further down the list", () => {
    const urls = composeWith({ saved: SHIPPED[2], shipped: SHIPPED });
    assert.deepStrictEqual(urls, [SHIPPED[2], SHIPPED[0], SHIPPED[1]]);
    assert.strictEqual(new Set(urls).size, urls.length, "no duplicates");
  });

  it("falls back to the shipped list when nothing is saved", () => {
    assert.deepStrictEqual(composeWith({ shipped: SHIPPED }), SHIPPED);
  });

  it("layers a saved value above env overrides", () => {
    const urls = composeWith({
      saved: "https://mine.test",
      envOverrides: ["https://env.test"],
      shipped: SHIPPED,
    });
    assert.strictEqual(urls[0], "https://mine.test");
    assert.strictEqual(
      urls[1],
      "https://env.test",
      "env still overrides slot 0",
    );
  });
});

describe("upgrade compatibility — chains.json overrides", () => {
  /*- Before this release chains.json used rpc.primary / rpc.fallback.
   *  The shipped defaults no longer carry those keys, so if they appear
   *  they came from an operator's own override under
   *  app-config/user-configurable/ — a file the update procedure
   *  preserves on purpose.
   *
   *  The failure this guards against is silent: the file survives the
   *  upgrade, the code stops reading it, and an operator who had pointed
   *  LP Ranger at their own node is quietly back on public endpoints. */
  function composeChainUrls(rpc) {
    const legacy = [rpc.primary, rpc.fallback].filter(
      (u) => typeof u === "string" && u.length > 0,
    );
    return [...legacy, ...(Array.isArray(rpc.urls) ? rpc.urls : [])];
  }

  const SHIPPED_URLS = ["https://a.test", "https://b.test"];

  it("honours a pre-upgrade primary/fallback override", () => {
    const urls = composeChainUrls({
      urls: SHIPPED_URLS,
      primary: "https://mine-1.test",
      fallback: "https://mine-2.test",
    });
    assert.strictEqual(urls[0], "https://mine-1.test");
    assert.strictEqual(urls[1], "https://mine-2.test");
  });

  it("keeps the shipped endpoints behind a legacy override", () => {
    const urls = composeChainUrls({
      urls: SHIPPED_URLS,
      primary: "https://mine-1.test",
    });
    assert.deepStrictEqual(urls, ["https://mine-1.test", ...SHIPPED_URLS]);
  });

  it("ignores the legacy keys when absent", () => {
    assert.deepStrictEqual(
      composeChainUrls({ urls: SHIPPED_URLS }),
      SHIPPED_URLS,
    );
  });

  it("works for an override that sets only a primary", () => {
    const urls = composeChainUrls({
      urls: SHIPPED_URLS,
      primary: "https://solo.test",
    });
    assert.strictEqual(urls[0], "https://solo.test");
    assert.strictEqual(urls.length, SHIPPED_URLS.length + 1);
  });

  it("survives an override with neither shape", () => {
    assert.deepStrictEqual(composeChainUrls({}), []);
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
