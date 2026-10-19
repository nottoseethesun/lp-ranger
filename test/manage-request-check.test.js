/**
 * @file test/manage-request-check.test.js
 * @description What a Manage request must carry before anything starts,
 * decided by src/manage-request-check.js: a numeric tokenId, no contract
 * but this server's position manager, a wallet and a key. The route's
 * own tests (test/server-positions.test.js) cover that it asks.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config");
const { manageRequestRefusal } = require("../src/manage-request-check");

const WALLET = "0x1111111111111111111111111111111111111111";
const PK = "0xkey";

/** The refusal for `body` with a wallet and key present. */
function refusalOf(body) {
  return manageRequestRefusal(body, WALLET, PK);
}

describe("manageRequestRefusal", () => {
  it("lets a well-formed request through", () => {
    assert.equal(refusalOf({ tokenId: "123" }), null);
  });

  it("refuses a missing or non-numeric tokenId", () => {
    for (const tokenId of [undefined, null, "", "abc", "12a", -1, 1.5, ["5"]])
      assert.match(refusalOf({ tokenId }).error, /tokenId/, String(tokenId));
  });

  it("takes a tokenId sent as a number", () => {
    assert.equal(refusalOf({ tokenId: 123 }), null);
  });

  it("refuses a contract that is not this server's position manager", () => {
    /*-
     *  The bot drives the configured position manager only, so a slot
     *  keyed on another contract would be running and read by nothing.
     */
    const r = refusalOf({ tokenId: "123", contract: "0x" + "ab".repeat(20) });
    assert.equal(r.status, 400);
    assert.match(r.error, /not this server's position manager/);
  });

  it("takes this server's position manager in any letter case", () => {
    // EIP-55 capitals are a checksum; the address is the same either way.
    const pm = config.POSITION_MANAGER;
    for (const contract of [pm, pm.toLowerCase(), pm.toUpperCase()])
      assert.equal(refusalOf({ tokenId: "123", contract }), null, contract);
  });

  it("takes no contract at all as this server's", () => {
    assert.equal(refusalOf({ tokenId: "123", contract: null }), null);
  });

  it("refuses a contract that is not a string", () => {
    const r = refusalOf({ tokenId: "123", contract: 42 });
    assert.match(r.error, /not this server's position manager/);
  });

  it("refuses without a wallet, then without a key", () => {
    assert.match(
      manageRequestRefusal({ tokenId: "1" }, null, PK).error,
      /wallet/,
    );
    assert.match(
      manageRequestRefusal({ tokenId: "1" }, WALLET, null).error,
      /private key/,
    );
  });
});
