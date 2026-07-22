"use strict";

/**
 * @file test/dashboard-lp-providers.test.js
 * @description Tests for the browser-side LP-provider composite-key
 *   lookup in `public/dashboard-lp-providers.js`.  Mirrored in CJS
 *   because the module imports `./ethers-adapter.js` (browser adapter
 *   around the ethers npm package) and touches `global.fetch` /
 *   `console.warn` in ways that are easier to stub than to run.
 *   Mirror is kept intentionally close to the source — if the browser
 *   file changes shape, change this file too.
 *
 *   Scope: composite-key composition + lookup dispatch + supported-chain
 *   check + dedup'd warning behavior.  Fetch / DOM-paint paths are out
 *   of scope for this suite.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

// ── In-test replica of the module's pure lookup surface ────────────────────

let _providerMap;
let _factory;
let _loggedMissingProviders;
let _loggedUnsupportedChains;
let _warnCalls;

function _compositeKey(factory, positionManager) {
  try {
    return `${ethers.getAddress(factory)}_${ethers.getAddress(positionManager)}`;
  } catch {
    return null;
  }
}

function setFactoryContext(factory) {
  if (typeof factory === "string" && factory.length > 0) _factory = factory;
}

function getProvider(factory, positionManager) {
  if (
    typeof factory !== "string" ||
    factory.length === 0 ||
    typeof positionManager !== "string" ||
    positionManager.length === 0
  )
    return undefined;
  const key = _compositeKey(factory, positionManager);
  if (key === null) return undefined;
  const entry = _providerMap[key];
  if (
    (entry === null || entry === undefined) &&
    !_loggedMissingProviders.has(key)
  ) {
    _loggedMissingProviders.add(key);
    _warnCalls.push(["missing", key]);
  }
  return entry;
}

function getProviderDisplayName(factory, positionManager) {
  return getProvider(factory, positionManager)?.displayName;
}

function isChainSupported(factory, positionManager, chainId) {
  const entry = getProvider(factory, positionManager);
  if (entry === null || entry === undefined) return false;
  if (typeof chainId !== "string" || chainId.length === 0) return false;
  const supported = Array.isArray(
    entry.supportedBlockchainsByLpRangerAndLpProvider,
  )
    ? entry.supportedBlockchainsByLpRangerAndLpProvider
    : [];
  if (supported.includes(chainId)) return true;
  const dedupKey = `${_compositeKey(factory, positionManager)}::${chainId}`;
  if (!_loggedUnsupportedChains.has(dedupKey)) {
    _loggedUnsupportedChains.add(dedupKey);
    _warnCalls.push(["unsupported-chain", dedupKey]);
  }
  return false;
}

function getProviderLabel(positionManager) {
  if (_factory === null) return undefined;
  return getProviderDisplayName(_factory, positionManager);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

// Real 9mm Pro V3 addresses used by the app so ethers.getAddress
// checksums cleanly.
const FACTORY_9MM = "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68";
const PM_9MM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

// Random valid EIP-55 pair not present in the fixtures.
const FACTORY_OTHER = "0x0000000000000000000000000000000000000001";
const PM_OTHER = "0x0000000000000000000000000000000000000002";

function _canonicalKey(f, p) {
  return `${ethers.getAddress(f)}_${ethers.getAddress(p)}`;
}

beforeEach(() => {
  _providerMap = {
    [_canonicalKey(FACTORY_9MM, PM_9MM)]: {
      displayName: "9mm Pro V3",
      supportedBlockchainsByLpRangerAndLpProvider: [
        "pulsechain",
        "pulsechain-testnet",
      ],
    },
  };
  _factory = null;
  _loggedMissingProviders = new Set();
  _loggedUnsupportedChains = new Set();
  _warnCalls = [];
});

// ── getProvider ────────────────────────────────────────────────────────────

describe("getProvider()", () => {
  it("returns the entry when the pair is present", () => {
    const entry = getProvider(FACTORY_9MM, PM_9MM);
    assert.strictEqual(entry?.displayName, "9mm Pro V3");
  });

  it("returns undefined for missing arguments", () => {
    assert.strictEqual(getProvider(undefined, PM_9MM), undefined);
    assert.strictEqual(getProvider(FACTORY_9MM, undefined), undefined);
    assert.strictEqual(getProvider("", PM_9MM), undefined);
    assert.strictEqual(getProvider(FACTORY_9MM, ""), undefined);
    // No warning for invalid input — dedup fires on syntactically-valid
    // pairs only.
    assert.deepStrictEqual(_warnCalls, []);
  });

  it("returns undefined for non-EIP-55 addresses (garbage in → null → undefined)", () => {
    assert.strictEqual(getProvider("not-an-address", PM_9MM), undefined);
    assert.strictEqual(getProvider(FACTORY_9MM, "0xNOT"), undefined);
  });

  it(
    "logs a dedup'd 'missing' warn for a valid pair that isn't in the map, " +
      "and only ONCE per pair",
    () => {
      const before = _warnCalls.length;
      getProvider(FACTORY_OTHER, PM_OTHER);
      getProvider(FACTORY_OTHER, PM_OTHER);
      getProvider(FACTORY_OTHER, PM_OTHER);
      const after = _warnCalls.length;
      assert.strictEqual(after - before, 1, "warn must fire exactly once");
      assert.strictEqual(_warnCalls.at(-1)[0], "missing");
    },
  );

  it("checksums input addresses (accepts lower-case and mixed-case forms)", () => {
    // ethers.getAddress normalises casing; the same lookup should hit
    // regardless of input casing.
    const lowerFactory = FACTORY_9MM.toLowerCase();
    const lowerPm = PM_9MM.toLowerCase();
    assert.strictEqual(
      getProvider(lowerFactory, lowerPm)?.displayName,
      "9mm Pro V3",
    );
  });
});

// ── getProviderDisplayName ─────────────────────────────────────────────────

describe("getProviderDisplayName()", () => {
  it("returns the entry's displayName for a present pair", () => {
    assert.strictEqual(
      getProviderDisplayName(FACTORY_9MM, PM_9MM),
      "9mm Pro V3",
    );
  });

  it("returns undefined for unknown pair", () => {
    assert.strictEqual(
      getProviderDisplayName(FACTORY_OTHER, PM_OTHER),
      undefined,
    );
  });
});

// ── isChainSupported ───────────────────────────────────────────────────────

describe("isChainSupported()", () => {
  it("is true when the chainId is in the entry's supported list", () => {
    assert.strictEqual(
      isChainSupported(FACTORY_9MM, PM_9MM, "pulsechain"),
      true,
    );
    assert.strictEqual(
      isChainSupported(FACTORY_9MM, PM_9MM, "pulsechain-testnet"),
      true,
    );
  });

  it(
    "is false when the chainId is not supported, and logs a dedup'd " +
      "'unsupported-chain' warn only once per (pair, chainId)",
    () => {
      isChainSupported(FACTORY_9MM, PM_9MM, "solana");
      isChainSupported(FACTORY_9MM, PM_9MM, "solana");
      const unsupportedWarns = _warnCalls.filter(
        (c) => c[0] === "unsupported-chain",
      );
      assert.strictEqual(unsupportedWarns.length, 1);
    },
  );

  it("is false for missing / empty chainId", () => {
    assert.strictEqual(isChainSupported(FACTORY_9MM, PM_9MM, ""), false);
    assert.strictEqual(isChainSupported(FACTORY_9MM, PM_9MM, undefined), false);
  });

  it("is false when the pair itself is unknown (short-circuits before the chain check)", () => {
    assert.strictEqual(
      isChainSupported(FACTORY_OTHER, PM_OTHER, "pulsechain"),
      false,
    );
  });
});

// ── getProviderLabel (legacy single-arg wrapper) ───────────────────────────

describe("getProviderLabel()", () => {
  it("returns undefined before setFactoryContext has been called", () => {
    assert.strictEqual(_factory, null);
    assert.strictEqual(getProviderLabel(PM_9MM), undefined);
  });

  it("returns the displayName once factory context is set", () => {
    setFactoryContext(FACTORY_9MM);
    assert.strictEqual(getProviderLabel(PM_9MM), "9mm Pro V3");
  });

  it("setFactoryContext ignores non-string / empty input (defensive)", () => {
    setFactoryContext(null);
    setFactoryContext("");
    setFactoryContext(undefined);
    // _factory remains null → getProviderLabel still returns undefined.
    assert.strictEqual(_factory, null);
    assert.strictEqual(getProviderLabel(PM_9MM), undefined);
  });
});
