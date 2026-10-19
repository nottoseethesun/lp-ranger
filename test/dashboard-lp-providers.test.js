"use strict";

/**
 * @file test/dashboard-lp-providers.test.js
 * @description Tests for the browser-side LP-provider composite-key
 *   lookup in `public/dashboard-lp-providers.js`.  Uses jsdom (via
 *   `global-jsdom/register`) so `document`, `fetch`, and other browser
 *   globals are populated with realistic defaults, then imports the
 *   real browser module — no mirror.
 *
 *   Populates the provider map by stubbing `fetch` before calling
 *   `loadLpProviders()` in a `before` hook.  Each `getProvider(unknown)`
 *   test uses a UNIQUE placeholder address so that the module's
 *   dedup-warning Sets (which persist across tests within the same file
 *   because the module is a singleton) never collide.
 *
 *   Scope: composite-key composition + lookup dispatch + supported-chain
 *   check + defensive input handling.  DOM-paint path
 *   (`setProviderLabelFor`) is out of scope for this suite.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { learnActiveChain } = require("./helpers/active-chain");

// ── Fixtures ───────────────────────────────────────────────────────────────

// Real 9mm Pro V3 addresses used by the app so ethers.getAddress
// checksums cleanly.
const FACTORY_9MM = "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68";
const PM_9MM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

function _canonicalKey(f, p) {
  return `${ethers.getAddress(f)}_${ethers.getAddress(p)}`;
}

const _PROVIDER_MAP = {
  [_canonicalKey(FACTORY_9MM, PM_9MM)]: {
    displayName: "9mm Pro V3",
    supportedBlockchainsByLpRangerAndLpProvider: [
      "pulsechain",
      "pulsechain-testnet",
    ],
  },
};

let mod;

before(async () => {
  // Stub fetch BEFORE importing so the module's optional load-time
  // fetch (if any) also uses the stub.  Only intercepts the
  // `/api/lp-providers` endpoint.
  globalThis.fetch = async (url) => {
    if (url === "/api/lp-providers") {
      return {
        ok: true,
        json: async () => _PROVIDER_MAP,
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  mod = await import("../public/dashboard-lp-providers.js");
  await mod.loadLpProviders();
});

// ── Helper: unique unknown pair for each test ──────────────────────────────
//
// The module's `_loggedMissingProviders` Set persists across tests in this
// process.  To keep "the warn fires on first unknown pair" assertions
// robust to prior calls, every test uses a distinct pair.

function _unknownPair(seed) {
  const hex = String(seed).padStart(40, "0");
  const factory = ethers.getAddress("0x" + hex.slice(0, 40));
  const pm = ethers.getAddress("0x" + hex.slice(0, 39) + "1");
  return { factory, pm };
}

// ── getProvider ────────────────────────────────────────────────────────────

describe("getProvider()", () => {
  it("returns the entry when the pair is present", () => {
    const entry = mod.getProvider(FACTORY_9MM, PM_9MM);
    assert.strictEqual(entry?.displayName, "9mm Pro V3");
  });

  it("returns undefined for missing arguments", () => {
    assert.strictEqual(mod.getProvider(undefined, PM_9MM), undefined);
    assert.strictEqual(mod.getProvider(FACTORY_9MM, undefined), undefined);
    assert.strictEqual(mod.getProvider("", PM_9MM), undefined);
    assert.strictEqual(mod.getProvider(FACTORY_9MM, ""), undefined);
  });

  it("returns undefined for non-EIP-55 / malformed addresses", () => {
    assert.strictEqual(mod.getProvider("not-an-address", PM_9MM), undefined);
    assert.strictEqual(mod.getProvider(FACTORY_9MM, "0xNOT"), undefined);
  });

  it("returns undefined for a syntactically-valid pair not in the map", () => {
    const { factory, pm } = _unknownPair("ff0000");
    assert.strictEqual(mod.getProvider(factory, pm), undefined);
  });

  it("checksums input addresses (accepts lower-case forms)", () => {
    const lowerFactory = FACTORY_9MM.toLowerCase();
    const lowerPm = PM_9MM.toLowerCase();
    assert.strictEqual(
      mod.getProvider(lowerFactory, lowerPm)?.displayName,
      "9mm Pro V3",
    );
  });
});

// ── getProviderDisplayName ─────────────────────────────────────────────────

describe("getProviderDisplayName()", () => {
  it("returns the entry's displayName for a present pair", () => {
    assert.strictEqual(
      mod.getProviderDisplayName(FACTORY_9MM, PM_9MM),
      "9mm Pro V3",
    );
  });

  it("returns undefined for unknown pair", () => {
    const { factory, pm } = _unknownPair("ff0001");
    assert.strictEqual(mod.getProviderDisplayName(factory, pm), undefined);
  });
});

// ── isChainSupported ───────────────────────────────────────────────────────

describe("isChainSupported()", () => {
  it("is true when the chainId is in the entry's supported list", () => {
    assert.strictEqual(
      mod.isChainSupported(FACTORY_9MM, PM_9MM, "pulsechain"),
      true,
    );
    assert.strictEqual(
      mod.isChainSupported(FACTORY_9MM, PM_9MM, "pulsechain-testnet"),
      true,
    );
  });

  it("is false when the chainId is not in the entry's supported list", () => {
    assert.strictEqual(
      mod.isChainSupported(FACTORY_9MM, PM_9MM, "solana"),
      false,
    );
  });

  it("is false for missing / empty chainId", () => {
    assert.strictEqual(mod.isChainSupported(FACTORY_9MM, PM_9MM, ""), false);
    assert.strictEqual(
      mod.isChainSupported(FACTORY_9MM, PM_9MM, undefined),
      false,
    );
  });

  it("is false when the pair itself is unknown (short-circuits before the chain check)", () => {
    const { factory, pm } = _unknownPair("ff0002");
    assert.strictEqual(mod.isChainSupported(factory, pm, "pulsechain"), false);
  });
});

// ── getProviderLabel / getProviderFor: from the position's own key ─────────

describe("getProviderLabel() — from the position's contract and the chain", () => {
  /*-
   *  The position manager in a position's key, and the chain the
   *  dashboard learned at startup, name the provider. No address the
   *  status answer carries outside a position's key is read, so an old
   *  address an earlier release saved changes nothing on screen.
   */
  it("names the provider with nothing from the status answer", async () => {
    await learnActiveChain("pulsechain");
    assert.strictEqual(mod.getProviderLabel(PM_9MM), "9mm Pro V3");
    assert.strictEqual(
      mod.getProviderLabel(PM_9MM.toLowerCase()),
      "9mm Pro V3",
    );
  });

  it("names none for a contract the list does not hold", async () => {
    await learnActiveChain("pulsechain");
    const { pm } = _unknownPair("ff0003");
    assert.strictEqual(mod.getProviderLabel(pm), undefined);
  });

  it("names none on a chain the entry is not verified for", async () => {
    await learnActiveChain("some-other-chain");
    try {
      assert.strictEqual(mod.getProviderLabel(PM_9MM), undefined);
    } finally {
      await learnActiveChain("pulsechain");
    }
  });

  it("returns the whole entry, for the Dex Detail Page", async () => {
    await learnActiveChain("pulsechain");
    assert.strictEqual(mod.getProviderFor(PM_9MM).displayName, "9mm Pro V3");
  });
});

describe("a lookup made before the provider list arrives", () => {
  /*-
   *  The position strip's first paint asks for the label before the
   *  list has arrived. That finds nothing and warns of nothing, since
   *  nothing is yet known to be missing, and a contract the list truly
   *  lacks is still reported once the list is in. A fresh instance of
   *  the module, by its own url, is one whose list has not arrived.
   */
  it("finds nothing and warns of nothing, and a real miss is reported after", async (t) => {
    await learnActiveChain("pulsechain");
    const fresh =
      await import("../public/dashboard-lp-providers.js?before-the-list");
    const logMod = await import("../public/dashboard-log.js");
    const warned = [];
    t.mock.method(logMod.log, "warn", (...args) => warned.push(args));
    const { pm } = _unknownPair("ff0004");
    assert.strictEqual(fresh.getProviderLabel(PM_9MM), undefined);
    assert.strictEqual(fresh.getProviderLabel(pm), undefined);
    assert.equal(warned.length, 0, "nothing is known missing yet");
    await fresh.loadLpProviders();
    assert.strictEqual(fresh.getProviderLabel(PM_9MM), "9mm Pro V3");
    assert.strictEqual(fresh.getProviderLabel(pm), undefined);
    assert.equal(warned.length, 1, "the real miss is reported");
    assert.match(warned[0][0], /entries for position manager/);
  });
});
