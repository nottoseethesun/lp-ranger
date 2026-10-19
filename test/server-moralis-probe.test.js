/**
 * @file test/server-moralis-probe.test.js
 * @description A Moralis key is checked by pricing the active chain's
 *   wrapped native token, both named in chains.json, so nothing in the
 *   check names a chain of its own.
 *
 *   The service's address is an operator's own here, and the chain's
 *   token and Moralis id are moved off what ships, so a url written out
 *   in the code fails.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const MORALIS_BASE = "https://moralis.example.org/api/v9";
const SETTINGS_DIR = makeTestTempFolder("moralis-probe-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "price-services.json"),
  JSON.stringify({ moralis: { baseUrl: MORALIS_BASE } }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const { setApiKey } = require("../src/api-key-holder");
const {
  moralisProbeUrl,
  handleApiKeyStatus,
} = require("../src/server-moralis");
const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

const TOKEN = "0x" + "12".repeat(20);

/** PulseChain's entry, with its Moralis id replaced. */
const withMoralisId = (moralisChain) => ({
  ...CHAINS.pulsechain,
  priceServices: { ...CHAINS.pulsechain.priceServices, moralisChain },
});

describe("moralisProbeUrl", () => {
  it("prices the chain's wrapped native token under the chain's Moralis id", () => {
    const chain = { ...withMoralisId("0x9a"), nativeWrappedToken: TOKEN };
    assert.equal(
      moralisProbeUrl(chain),
      `${MORALIS_BASE}/erc20/${TOKEN}/price?chain=0x9a`,
    );
  });

  it("has nothing to probe on a chain Moralis does not cover", () => {
    // It still names a wrapped native token, so only the missing id counts.
    assert.equal(moralisProbeUrl(withMoralisId("")), null);
  });

  it("has nothing to probe on a chain with no wrapped native token", () => {
    const chain = { ...CHAINS.pulsechain, nativeWrappedToken: "" };
    assert.equal(moralisProbeUrl(chain), null);
  });
});

describe("the key status on a chain Moralis does not cover", () => {
  it("reports a stored key as unsupported, not as missing", async () => {
    /*-
     *  "none" would tell the operator their key had vanished. It is
     *  there; the chain is what leaves it unused.
     */
    const saved = config.CHAIN;
    config.CHAIN = CHAINS["pulsechain-testnet"];
    setApiKey("moralis", "a-stored-key");
    let sent;
    try {
      await handleApiKeyStatus({}, {}, (_res, status, body) => {
        sent = { status, body };
      });
    } finally {
      config.CHAIN = saved;
      setApiKey("moralis", null);
    }
    assert.deepEqual(sent, { status: 200, body: { moralis: "unsupported" } });
  });
});
