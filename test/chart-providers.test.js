/**
 * @file test/chart-providers.test.js
 * @description Unit tests for src/chart-providers.js and the
 * GET /api/chart-providers route handler. Covers the happy path
 * against the real chains.json on disk, per-chain blockchain-slug
 * substitution (DexTools' "pulse" vs DexScreener's "pulsechain"),
 * URL-template shape, malformed-entry filtering (via the pure
 * `_buildProvidersList` helper so we never mutate chains.json on
 * disk and race other parallel test files), and the always-200
 * route contract.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  readChartProviders,
  handleChartProviders,
  _buildProvidersList,
} = require("../src/chart-providers");

describe("chart-providers.readChartProviders — happy path", () => {
  it("returns DexScreener / GeckoTerminal / DexTools entries for pulsechain", () => {
    const out = readChartProviders("pulsechain");
    const keys = out.map((p) => p.key);
    assert.deepEqual(keys, ["dexscreener", "geckoterminal", "dextools"]);
  });

  it("substitutes the pulsechain slug into DexScreener's URL", () => {
    const ds = readChartProviders("pulsechain").find(
      (p) => p.key === "dexscreener",
    );
    assert.equal(ds.urlTemplate, "https://dexscreener.com/pulsechain/{poolId}");
  });

  it("substitutes the pulsechain slug into GeckoTerminal's URL", () => {
    const gt = readChartProviders("pulsechain").find(
      (p) => p.key === "geckoterminal",
    );
    assert.equal(
      gt.urlTemplate,
      "https://www.geckoterminal.com/pulsechain/pools/{poolId}",
    );
  });

  it("uses DexTools' 'pulse' slug, not 'pulsechain'", () => {
    const dt = readChartProviders("pulsechain").find(
      (p) => p.key === "dextools",
    );
    assert.equal(
      dt.urlTemplate,
      "https://www.dextools.io/app/pulse/pair-explorer/{poolId}",
    );
  });

  it("preserves the {poolId} placeholder for the client to fill in", () => {
    for (const p of readChartProviders("pulsechain")) {
      assert.ok(
        p.urlTemplate.includes("{poolId}"),
        `template for ${p.key} should still contain {poolId}`,
      );
    }
  });

  it("returns the human-readable name for each provider", () => {
    const names = Object.fromEntries(
      readChartProviders("pulsechain").map((p) => [p.key, p.name]),
    );
    assert.deepEqual(names, {
      dexscreener: "DexScreener",
      geckoterminal: "GeckoTerminal",
      dextools: "DexTools",
    });
  });

  it("falls back to pulsechain when chain name is unknown", () => {
    const out = readChartProviders("not-a-real-chain");
    assert.equal(out.length, 3);
  });
});

describe("chart-providers._buildProvidersList — malformed entries", () => {
  /*- Pure-helper tests that exercise edge cases without mutating
      app-config/static-tunables/chains.json on disk. The previous
      file-mutation approach raced other test files that also read
      chains.json (via `require("./runtime-flags")`), causing flaky
      failures when node --test ran files in parallel. */

  it("drops entries missing the name", () => {
    const out = _buildProvidersList({
      ok: {
        name: "OK",
        scheme: "https",
        domain: "ok.example",
        blockchain: "x",
        pathSegments: ["{poolId}"],
      },
      noName: {
        scheme: "https",
        domain: "noname.example",
        blockchain: "x",
        pathSegments: ["{poolId}"],
      },
    });
    assert.deepEqual(
      out.map((p) => p.key),
      ["ok"],
    );
  });

  it("drops entries missing the scheme", () => {
    const out = _buildProvidersList({
      noScheme: {
        name: "Bad",
        domain: "bad.example",
        blockchain: "x",
        pathSegments: ["{poolId}"],
      },
    });
    assert.deepEqual(out, []);
  });

  it("drops entries missing the domain", () => {
    const out = _buildProvidersList({
      noDomain: {
        name: "Bad",
        scheme: "https",
        blockchain: "x",
        pathSegments: ["{poolId}"],
      },
    });
    assert.deepEqual(out, []);
  });

  it("drops entries missing the blockchain slug", () => {
    const out = _buildProvidersList({
      noBlockchain: {
        name: "Bad",
        scheme: "https",
        domain: "bad.example",
        pathSegments: ["{poolId}"],
      },
    });
    assert.deepEqual(out, []);
  });

  it("drops entries with non-array pathSegments", () => {
    const out = _buildProvidersList({
      bad: {
        name: "Bad",
        scheme: "https",
        domain: "bad.example",
        blockchain: "x",
        pathSegments: "{blockchain}/{poolId}",
      },
    });
    assert.deepEqual(out, []);
  });

  it("drops entries whose path has no {poolId} placeholder", () => {
    const out = _buildProvidersList({
      noPoolId: {
        name: "Bad",
        scheme: "https",
        domain: "bad.example",
        blockchain: "x",
        pathSegments: ["pools"],
      },
    });
    assert.deepEqual(out, []);
  });

  it("returns empty list when given null / undefined / empty", () => {
    assert.deepEqual(_buildProvidersList(null), []);
    assert.deepEqual(_buildProvidersList(undefined), []);
    assert.deepEqual(_buildProvidersList({}), []);
  });

  it("substitutes {blockchain} into multi-segment paths in order", () => {
    const out = _buildProvidersList({
      multi: {
        name: "Multi",
        scheme: "https",
        domain: "multi.example",
        blockchain: "alpha",
        pathSegments: ["app", "{blockchain}", "pair", "{poolId}"],
      },
    });
    assert.equal(
      out[0].urlTemplate,
      "https://multi.example/app/alpha/pair/{poolId}",
    );
  });
});

describe("chart-providers.handleChartProviders", () => {
  it("returns 200 with { providers: [...] } for the active chain", () => {
    let gotStatus = null;
    let gotBody = null;
    const jsonResponse = (_res, status, body) => {
      gotStatus = status;
      gotBody = body;
    };
    handleChartProviders({}, {}, jsonResponse);
    assert.equal(gotStatus, 200);
    assert.ok(Array.isArray(gotBody.providers));
    assert.ok(gotBody.providers.length >= 1);
  });
});
