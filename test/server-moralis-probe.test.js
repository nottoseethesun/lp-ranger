/**
 * @file test/server-moralis-probe.test.js
 * @description A Moralis key is checked by pricing the active chain's
 *   wrapped native token, both named in chains.json, so nothing in the
 *   check names a chain of its own.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const { setApiKey } = require("../src/api-key-holder");
const {
  moralisProbeUrl,
  handleApiKeyStatus,
} = require("../src/server-moralis");
const CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

describe("moralisProbeUrl", () => {
  it("prices the chain's wrapped native token under the chain's Moralis id", () => {
    const chain = CHAINS.pulsechain;
    const url = moralisProbeUrl(chain);
    assert.ok(url.includes(`/${chain.nativeWrappedToken}/price`), url);
    assert.ok(url.endsWith(`?chain=${chain.priceServices.moralisChain}`), url);
  });

  it("has nothing to probe on a chain Moralis does not cover", () => {
    assert.equal(moralisProbeUrl(CHAINS["pulsechain-testnet"]), null);
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
