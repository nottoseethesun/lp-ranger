/**
 * @file test/composite-key-chain-names.test.js
 * @description `parseCompositeKey` on chains whose names contain a dash,
 *   such as `pulsechain-testnet`, and on keys that only look like
 *   position keys once read from the right.
 *
 *   A position key is `chain-wallet-contract-tokenId`. The parser reads
 *   the last three segments as wallet, contract and tokenId and takes
 *   everything before them as the chain, so a dash inside the chain name
 *   cannot shift the other fields. Split out of bot-config-v2.test.js at
 *   its line cap.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { compositeKey, parseCompositeKey } = require("../src/bot-config-v2");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

describe("parseCompositeKey() and chain names", () => {
  it("round-trips on a chain whose name contains a dash", () => {
    // Read from the left, "testnet" would be taken for the wallet.
    const key = compositeKey("pulsechain-testnet", WALLET, PM, "7");
    assert.deepStrictEqual(parseCompositeKey(key), {
      blockchain: "pulsechain-testnet",
      wallet: WALLET,
      contract: PM,
      tokenId: "7",
    });
  });

  it("still round-trips on a single-word chain", () => {
    const key = compositeKey("pulsechain", WALLET, PM, "99");
    assert.deepStrictEqual(parseCompositeKey(key), {
      blockchain: "pulsechain",
      wallet: WALLET,
      contract: PM,
      tokenId: "99",
    });
  });

  it("rejects a pool key, whose last three segments look like a position", () => {
    /*-
     *  chain-contract-wallet-token0-token1-fee: read from the right,
     *  token0 and token1 pass for wallet and contract, so the address in
     *  the chain part is what gives it away.
     */
    const poolKey = [
      "pulsechain",
      PM,
      WALLET,
      "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
      "0x7b39712EF45F7dcED2bBDF11F3D5046bA61dA719",
      "10000",
    ].join("-");
    assert.equal(parseCompositeKey(poolKey), null);
  });

  it("rejects a key whose chain part is empty", () => {
    assert.equal(parseCompositeKey(`-${WALLET}-${PM}-7`), null);
  });
});
