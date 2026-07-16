/**
 * @file test/lp-providers.test.js
 * @description Unit tests for src/lp-providers.js and the
 * GET /api/lp-providers route handler.  Covers happy-path canonical
 * lookup, case-insensitive lookup via ethers.getAddress, invalid
 * address rejection, unknown-pair handling with dedup'd warning,
 * chain-support gating with dedup'd warning, JSON schema normalization
 * (missing / non-array supportedBlockchainsByLpRangerAndLpProvider,
 * displayName trimming, _comment stripping), and file-error fallbacks.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { _setSinkForTests } = require("../src/log");

const _FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
  "lp-providers.json",
);

// Canonical EIP-55 checksummed addresses used across tests.
const _F = "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68";
const _P = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

let _originalContent = null;
let _warnings = [];
let _restoreSink = null;

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/lp-providers")];
}

function _captureWarnings() {
  _warnings = [];
  _restoreSink = _setSinkForTests({
    warn: (...args) => {
      _warnings.push(args.join(" "));
    },
  });
}

beforeEach(() => {
  if (fs.existsSync(_FILE)) _originalContent = fs.readFileSync(_FILE, "utf8");
  _clearModuleCache();
  _captureWarnings();
});

afterEach(() => {
  if (_originalContent !== null) fs.writeFileSync(_FILE, _originalContent);
  _originalContent = null;
  if (_restoreSink) _restoreSink();
  _restoreSink = null;
  _clearModuleCache();
});

describe("lp-providers.readLpProviders", () => {
  it("returns the entry keyed in canonical EIP-55 casing (unchanged)", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
        },
      }),
    );
    const { readLpProviders } = require("../src/lp-providers");
    const out = readLpProviders();
    assert.equal(out[`${_F}_${_P}`].displayName, "9mm v3");
    assert.deepEqual(
      out[`${_F}_${_P}`].supportedBlockchainsByLpRangerAndLpProvider,
      ["pulsechain"],
    );
  });

  it("strips the _comment key", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        _comment: "doc",
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
        },
      }),
    );
    const { readLpProviders } = require("../src/lp-providers");
    const out = readLpProviders();
    assert.equal(out._comment, undefined);
    assert.equal(out[`${_F}_${_P}`].displayName, "9mm v3");
  });

  it("trims displayName whitespace", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "  9mm v3  ",
          supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
        },
      }),
    );
    const { readLpProviders } = require("../src/lp-providers");
    assert.equal(readLpProviders()[`${_F}_${_P}`].displayName, "9mm v3");
  });

  it("skips entries with missing / empty / non-string displayName", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: { supportedBlockchainsByLpRangerAndLpProvider: ["x"] },
        "0xAA_0xBB": { displayName: "   " },
        "0xCC_0xDD": { displayName: 42 },
      }),
    );
    const { readLpProviders } = require("../src/lp-providers");
    const out = readLpProviders();
    assert.equal(Object.keys(out).length, 0);
  });

  it("normalizes missing supportedBlockchainsByLpRangerAndLpProvider to []", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: { displayName: "9mm v3" },
      }),
    );
    const { readLpProviders } = require("../src/lp-providers");
    assert.deepEqual(
      readLpProviders()[`${_F}_${_P}`]
        .supportedBlockchainsByLpRangerAndLpProvider,
      [],
    );
  });

  it("normalizes non-array supportedBlockchainsByLpRangerAndLpProvider to []", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: "pulsechain",
        },
      }),
    );
    const { readLpProviders } = require("../src/lp-providers");
    assert.deepEqual(
      readLpProviders()[`${_F}_${_P}`]
        .supportedBlockchainsByLpRangerAndLpProvider,
      [],
    );
  });

  it("filters non-string / empty chain ids from the list", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: [
            "pulsechain",
            42,
            "",
            null,
            "ethereum",
          ],
        },
      }),
    );
    const { readLpProviders } = require("../src/lp-providers");
    assert.deepEqual(
      readLpProviders()[`${_F}_${_P}`]
        .supportedBlockchainsByLpRangerAndLpProvider,
      ["pulsechain", "ethereum"],
    );
  });

  it("returns empty map when file is missing", () => {
    fs.unlinkSync(_FILE);
    const { readLpProviders } = require("../src/lp-providers");
    assert.deepEqual(readLpProviders(), {});
  });

  it("returns empty map when JSON is malformed", () => {
    fs.writeFileSync(_FILE, "{ not valid json");
    const { readLpProviders } = require("../src/lp-providers");
    assert.deepEqual(readLpProviders(), {});
  });
});

describe("lp-providers.getLpProvider", () => {
  beforeEach(() => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
        },
      }),
    );
  });

  it("resolves canonical addresses", () => {
    const { getLpProvider } = require("../src/lp-providers");
    assert.equal(getLpProvider(_F, _P).displayName, "9mm v3");
  });

  it("resolves lowercase input (checksums internally)", () => {
    const { getLpProvider } = require("../src/lp-providers");
    assert.equal(
      getLpProvider(_F.toLowerCase(), _P.toLowerCase()).displayName,
      "9mm v3",
    );
  });

  it("returns undefined for invalid EIP-55 addresses (no warn — caller error)", () => {
    const { getLpProvider } = require("../src/lp-providers");
    assert.equal(getLpProvider("0xnotanaddress", _P), undefined);
    assert.equal(
      _warnings.filter((w) => w.includes("no entry")).length,
      0,
      "should not log a lookup-miss warning for a syntactically invalid address",
    );
  });

  it("returns undefined for null / undefined inputs (no warn)", () => {
    const { getLpProvider } = require("../src/lp-providers");
    assert.equal(getLpProvider(null, _P), undefined);
    assert.equal(getLpProvider(_F, undefined), undefined);
    assert.equal(_warnings.length, 0);
  });

  it("logs dedup'd warning for a valid but unknown (factory, PM) pair", () => {
    const { getLpProvider } = require("../src/lp-providers");
    const UNKNOWN_F = "0x0000000000000000000000000000000000000001";
    const UNKNOWN_P = "0x0000000000000000000000000000000000000002";
    assert.equal(getLpProvider(UNKNOWN_F, UNKNOWN_P), undefined);
    assert.equal(getLpProvider(UNKNOWN_F, UNKNOWN_P), undefined);
    const missWarns = _warnings.filter((w) =>
      w.includes("no entry for factory+positionManager pair"),
    );
    assert.equal(missWarns.length, 1, "warning should be dedup'd across calls");
    assert.ok(missWarns[0].includes(`${UNKNOWN_F}_${UNKNOWN_P}`));
  });
});

describe("lp-providers.getLpProviderDisplayName", () => {
  it("returns the trimmed displayName for a known pair", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
        },
      }),
    );
    const { getLpProviderDisplayName } = require("../src/lp-providers");
    assert.equal(getLpProviderDisplayName(_F, _P), "9mm v3");
  });

  it("returns undefined for an unknown pair", () => {
    fs.writeFileSync(_FILE, JSON.stringify({}));
    const { getLpProviderDisplayName } = require("../src/lp-providers");
    assert.equal(getLpProviderDisplayName(_F, _P), undefined);
  });
});

describe("lp-providers.isChainSupported", () => {
  beforeEach(() => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
        },
      }),
    );
  });

  it("returns true when the chain is in the supported list", () => {
    const { isChainSupported } = require("../src/lp-providers");
    assert.equal(isChainSupported(_F, _P, "pulsechain"), true);
    assert.equal(
      _warnings.filter((w) => w.includes("not in supportedBlockchains")).length,
      0,
    );
  });

  it("returns false + dedup'd warn when the chain isn't supported", () => {
    const { isChainSupported } = require("../src/lp-providers");
    assert.equal(isChainSupported(_F, _P, "ethereum"), false);
    assert.equal(isChainSupported(_F, _P, "ethereum"), false);
    const unsupportedWarns = _warnings.filter((w) =>
      w.includes("not in supportedBlockchainsByLpRangerAndLpProvider"),
    );
    assert.equal(unsupportedWarns.length, 1, "warning should be dedup'd");
    assert.ok(unsupportedWarns[0].includes("9mm v3"));
    assert.ok(unsupportedWarns[0].includes(`${_F}_${_P}`));
    assert.ok(unsupportedWarns[0].includes("pulsechain"));
  });

  it("logs distinct warns for different chains against the same entry", () => {
    const { isChainSupported } = require("../src/lp-providers");
    isChainSupported(_F, _P, "ethereum");
    isChainSupported(_F, _P, "polygon");
    const unsupportedWarns = _warnings.filter((w) =>
      w.includes("not in supportedBlockchainsByLpRangerAndLpProvider"),
    );
    assert.equal(unsupportedWarns.length, 2);
  });

  it("returns false for an unknown pair (no chain warn)", () => {
    const { isChainSupported } = require("../src/lp-providers");
    const UNKNOWN_F = "0x0000000000000000000000000000000000000001";
    const UNKNOWN_P = "0x0000000000000000000000000000000000000002";
    assert.equal(isChainSupported(UNKNOWN_F, UNKNOWN_P, "pulsechain"), false);
    const unsupportedWarns = _warnings.filter((w) =>
      w.includes("not in supportedBlockchainsByLpRangerAndLpProvider"),
    );
    assert.equal(unsupportedWarns.length, 0);
  });

  it("returns false for invalid chainId input", () => {
    const { isChainSupported } = require("../src/lp-providers");
    assert.equal(isChainSupported(_F, _P, ""), false);
    assert.equal(isChainSupported(_F, _P, null), false);
    assert.equal(isChainSupported(_F, _P, 42), false);
  });
});

describe("lp-providers.handleLpProviders", () => {
  it("returns 200 with the current map", () => {
    fs.writeFileSync(
      _FILE,
      JSON.stringify({
        [`${_F}_${_P}`]: {
          displayName: "9mm v3",
          supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
        },
      }),
    );
    const { handleLpProviders } = require("../src/lp-providers");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleLpProviders({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.equal(gotBody[`${_F}_${_P}`].displayName, "9mm v3");
    assert.deepEqual(
      gotBody[`${_F}_${_P}`].supportedBlockchainsByLpRangerAndLpProvider,
      ["pulsechain"],
    );
  });

  it("returns 200 with empty map when file missing", () => {
    fs.unlinkSync(_FILE);
    const { handleLpProviders } = require("../src/lp-providers");
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleLpProviders({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.deepEqual(gotBody, {});
  });
});
