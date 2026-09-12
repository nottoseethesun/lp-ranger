/**
 * @file test/dex-detail-page-url-generator.test.js
 * @description Tests for the Dex Detail Page URL generator — the module
 * that composes the LP provider's own pair-page deep link from config
 * alone (provider FQDN + swapProtocolVersion, per-chain blockchain
 * slug, literal path segments, and the client-substituted pool id).
 *
 * The fail-closed cases carry the weight here: a half-resolved URL
 * would send the user to some other pool's page, which is worse than
 * no link at all.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const {
  buildDexDetailPageUrlTemplate,
  readDexDetailPageName,
} = require("../src/dex-detail-page-url-generator");
const { _withDexDetailPage } = require("../src/lp-providers");

/** A provider entry shaped like the shipped 9mm v3 one. */
function entry(overrides = {}) {
  return {
    displayName: "9mm v3",
    supportedBlockchainsByLpRangerAndLpProvider: ["pulsechain"],
    swapProtocolVersion: "v3",
    dexDetailPage: {
      name: "Dex Detail Page",
      scheme: "https",
      domain: "dex.9mm.pro",
      pathSegments: [
        "info",
        "{swapProtocolVersion}",
        "{blockchain}",
        "pairs",
        "{poolId}",
      ],
    },
    ...overrides,
  };
}

/** Same, but with a patched dexDetailPage sub-object. */
function withPage(patch) {
  const e = entry();
  return { ...e, dexDetailPage: { ...e.dexDetailPage, ...patch } };
}

describe("dex-detail-page-url-generator — happy path", () => {
  it("composes the documented 9mm URL, leaving {poolId} for the client", () => {
    assert.strictEqual(
      buildDexDetailPageUrlTemplate(entry(), "pulsechain"),
      "https://dex.9mm.pro/info/v3/pulsechain/pairs/{poolId}",
    );
  });

  it("matches the user's example once the pool id is substituted", () => {
    const tpl = buildDexDetailPageUrlTemplate(entry(), "pulsechain");
    const pool = "0x82db51c694578a28da6545975bbda61e4c12b8e4";
    assert.strictEqual(
      tpl.replace("{poolId}", pool),
      `https://dex.9mm.pro/info/v3/pulsechain/pairs/${pool}`,
    );
  });

  it("takes the version from the entry, not from a hard-coded 'v3'", () => {
    const tpl = buildDexDetailPageUrlTemplate(
      entry({ swapProtocolVersion: "v4" }),
      "pulsechain",
    );
    assert.strictEqual(
      tpl,
      "https://dex.9mm.pro/info/v4/pulsechain/pairs/{poolId}",
    );
  });

  it("takes the domain from the entry, not from a hard-coded host", () => {
    const tpl = buildDexDetailPageUrlTemplate(
      withPage({ domain: "dex.example.io" }),
      "pulsechain",
    );
    assert.ok(tpl.startsWith("https://dex.example.io/"));
  });

  it("builds without a version segment when the path never asks for one", () => {
    const e = withPage({ pathSegments: ["pairs", "{blockchain}", "{poolId}"] });
    delete e.swapProtocolVersion;
    assert.strictEqual(
      buildDexDetailPageUrlTemplate(e, "pulsechain"),
      "https://dex.9mm.pro/pairs/pulsechain/{poolId}",
    );
  });
});

describe("dex-detail-page-url-generator — fails closed", () => {
  const cases = [
    ["no entry at all", null, "pulsechain"],
    ["a non-object entry", "nope", "pulsechain"],
    [
      "no dexDetailPage block",
      entry({ dexDetailPage: undefined }),
      "pulsechain",
    ],
    ["a blank scheme", withPage({ scheme: "" }), "pulsechain"],
    ["a blank domain", withPage({ domain: "" }), "pulsechain"],
    [
      "non-array pathSegments",
      withPage({ pathSegments: "info/v3" }),
      "pulsechain",
    ],
    ["an unknown chain", entry(), "ethereum"],
    ["a blank chain name", entry(), ""],
  ];

  for (const [label, providerEntry, chain] of cases) {
    it(`returns null given ${label}`, () => {
      assert.strictEqual(
        buildDexDetailPageUrlTemplate(providerEntry, chain),
        null,
      );
    });
  }

  it("returns null when a chain has no slug configured (testnet)", () => {
    /*- pulsechain-testnet ships `dexPairDetailPageUrl.blockchain: ""`,
     *  the same empty-slot convention chains.json uses for its unknown
     *  testnet addresses. An empty slug must not yield `//`. */
    assert.strictEqual(
      buildDexDetailPageUrlTemplate(entry(), "pulsechain-testnet"),
      null,
    );
  });

  it("returns null when a segment needs a version the entry lacks", () => {
    const e = entry();
    delete e.swapProtocolVersion;
    assert.strictEqual(buildDexDetailPageUrlTemplate(e, "pulsechain"), null);
  });

  it("returns null when swapProtocolVersion is blank", () => {
    assert.strictEqual(
      buildDexDetailPageUrlTemplate(
        entry({ swapProtocolVersion: "" }),
        "pulsechain",
      ),
      null,
    );
  });

  it("returns null when the path yields no {poolId}", () => {
    const e = withPage({ pathSegments: ["info", "{blockchain}"] });
    assert.strictEqual(buildDexDetailPageUrlTemplate(e, "pulsechain"), null);
  });

  it("never emits an empty path segment", () => {
    const e = withPage({ pathSegments: ["info", "", "{poolId}"] });
    assert.strictEqual(buildDexDetailPageUrlTemplate(e, "pulsechain"), null);
  });
});

describe("readDexDetailPageName", () => {
  it("returns the configured label", () => {
    assert.strictEqual(readDexDetailPageName(entry()), "Dex Detail Page");
  });

  it("trims surrounding whitespace", () => {
    assert.strictEqual(
      readDexDetailPageName(withPage({ name: "  Dex Detail Page  " })),
      "Dex Detail Page",
    );
  });

  for (const [label, value] of [
    ["blank", "   "],
    ["missing", undefined],
    ["non-string", 42],
  ]) {
    it(`returns null for a ${label} name`, () => {
      assert.strictEqual(
        readDexDetailPageName(withPage({ name: value })),
        null,
      );
    });
  }

  it("returns null for a missing entry", () => {
    assert.strictEqual(readDexDetailPageName(undefined), null);
  });
});

describe("lp-providers payload enrichment", () => {
  const KEY = "0xFactory_0xManager";

  it("attaches the resolved name + template for a configured provider", () => {
    const out = _withDexDetailPage({ [KEY]: entry() }, "pulsechain");
    assert.strictEqual(out[KEY].dexDetailPageName, "Dex Detail Page");
    assert.strictEqual(
      out[KEY].dexDetailPageUrlTemplate,
      "https://dex.9mm.pro/info/v3/pulsechain/pairs/{poolId}",
    );
  });

  it("preserves the original fields", () => {
    const out = _withDexDetailPage({ [KEY]: entry() }, "pulsechain");
    assert.strictEqual(out[KEY].displayName, "9mm v3");
    assert.deepStrictEqual(
      out[KEY].supportedBlockchainsByLpRangerAndLpProvider,
      ["pulsechain"],
    );
  });

  it("attaches neither key when the provider has no detail page", () => {
    const bare = { displayName: "other", swapProtocolVersion: "v3" };
    const out = _withDexDetailPage({ [KEY]: bare }, "pulsechain");
    assert.ok(!("dexDetailPageUrlTemplate" in out[KEY]));
    assert.ok(!("dexDetailPageName" in out[KEY]));
  });

  it("attaches neither key on a chain with no slug", () => {
    const out = _withDexDetailPage({ [KEY]: entry() }, "pulsechain-testnet");
    assert.ok(!("dexDetailPageUrlTemplate" in out[KEY]));
  });

  it("passes an empty map through unchanged", () => {
    assert.deepStrictEqual(_withDexDetailPage({}, "pulsechain"), {});
  });
});

describe("shipped config wires end to end", () => {
  it("the real lp-providers.json + chains.json produce the 9mm URL", () => {
    /*- Guards the config itself, not just the pure functions: a typo in
     *  either JSON file breaks the link with no other signal. */
    const { readLpProviders } = require("../src/lp-providers");
    const enriched = _withDexDetailPage(readLpProviders(), "pulsechain");
    const hit = Object.values(enriched).find(
      (e) => typeof e.dexDetailPageUrlTemplate === "string",
    );
    assert.ok(hit, "no shipped provider yielded a dex detail page URL");
    assert.strictEqual(
      hit.dexDetailPageUrlTemplate,
      "https://dex.9mm.pro/info/v3/pulsechain/pairs/{poolId}",
    );
    assert.strictEqual(hit.dexDetailPageName, "Dex Detail Page");
  });
});
