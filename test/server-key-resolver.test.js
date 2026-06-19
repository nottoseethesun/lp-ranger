/**
 * @file test/server-key-resolver.test.js
 * @description Unit tests for `resolveLiveKey` + `wasMigratedFrom` in
 * src/server-key-resolver.js.  Pure-function coverage; no DOM, no fs.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveLiveKey,
  wasMigratedFrom,
} = require("../src/server-key-resolver");

/*- Minimal positionMgr stub: backed by a plain Map keyed by composite
 *  key; entry objects carry { key, tokenId, status } only. */
function mkPositionMgr(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.key, e);
  return {
    get: (k) => map.get(k),
    getAll: () => Array.from(map.values()),
  };
}

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const CONTRACT = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const key = (tokenId) => `pulsechain-${WALLET}-${CONTRACT}-${tokenId}`;

describe("resolveLiveKey", () => {
  it("returns originalKey on null/empty inputs", () => {
    assert.equal(resolveLiveKey(null, key("100")), key("100"));
    assert.equal(resolveLiveKey({}, ""), "");
  });

  it("fast path: returns entry.key when positionMgr has the originalKey", () => {
    const pm = mkPositionMgr([
      { key: key("100"), tokenId: "100", status: "running" },
    ]);
    assert.equal(resolveLiveKey(pm, key("100")), key("100"));
  });

  it("fast path: returns entry.key (which may be the post-migration key) ", () => {
    /*- positionMgr.migrateKey mutates entry.key in place, so if the
     *  caller's originalKey IS already the migrated key, the fast path
     *  returns the same value — confirming the helper is identity-safe. */
    const pm = mkPositionMgr([
      { key: key("200"), tokenId: "200", status: "running" },
    ]);
    assert.equal(resolveLiveKey(pm, key("200")), key("200"));
  });

  it("slow path: finds migrated entry via rebalanceEvents chain", () => {
    /*- The user holds an old `key(100)` from a stale poll.  Position
     *  migrated 100 → 200 server-side.  positionMgr now has key(200);
     *  bot state for key(200) has a rebalanceEvents entry with
     *  oldTokenId=100. */
    const pm = mkPositionMgr([
      { key: key("200"), tokenId: "200", status: "running" },
    ]);
    const states = new Map([
      [
        key("200"),
        { rebalanceEvents: [{ oldTokenId: "100", newTokenId: "200" }] },
      ],
    ]);
    const live = resolveLiveKey(pm, key("100"), (k) => states.get(k));
    assert.equal(live, key("200"));
  });

  it("slow path: multi-hop chain (100 → 150 → 200) — events preserved", () => {
    /*- After 100→150 then 150→200, only the key(200) entry remains
     *  in positionMgr, but its state.rebalanceEvents array contains
     *  both transition events (the bot state object survives both
     *  rekey hops, accumulating events). */
    const pm = mkPositionMgr([
      { key: key("200"), tokenId: "200", status: "running" },
    ]);
    const states = new Map([
      [
        key("200"),
        {
          rebalanceEvents: [
            { oldTokenId: "100", newTokenId: "150" },
            { oldTokenId: "150", newTokenId: "200" },
          ],
        },
      ],
    ]);
    assert.equal(
      resolveLiveKey(pm, key("100"), (k) => states.get(k)),
      key("200"),
    );
    assert.equal(
      resolveLiveKey(pm, key("150"), (k) => states.get(k)),
      key("200"),
    );
  });

  it("falls back to originalKey when no rebalanceEvents prove migration", () => {
    /*- Two unrelated positions in the same wallet/contract; no
     *  rebalanceEvents link.  Caller's stale key(100) is not the same
     *  position as key(200) — resolver should not falsely match them. */
    const pm = mkPositionMgr([
      { key: key("200"), tokenId: "200", status: "running" },
    ]);
    const states = new Map([[key("200"), { rebalanceEvents: [] }]]);
    assert.equal(
      resolveLiveKey(pm, key("100"), (k) => states.get(k)),
      key("100"),
    );
  });

  it("falls back to originalKey when positionMgr is empty", () => {
    const pm = mkPositionMgr([]);
    assert.equal(resolveLiveKey(pm, key("100")), key("100"));
  });

  it("does not match across different wallet/contract", () => {
    const otherWallet = "0x1111111111111111111111111111111111111111";
    const pm = mkPositionMgr([
      {
        key: `pulsechain-${otherWallet}-${CONTRACT}-200`,
        tokenId: "200",
        status: "running",
      },
    ]);
    const states = new Map([
      [
        `pulsechain-${otherWallet}-${CONTRACT}-200`,
        { rebalanceEvents: [{ oldTokenId: "100", newTokenId: "200" }] },
      ],
    ]);
    /*- Even though the rebalanceEvents claim 100→200, the wallet
     *  differs — must NOT match.  This guard prevents cross-wallet
     *  leakage. */
    assert.equal(
      resolveLiveKey(pm, key("100"), (k) => states.get(k)),
      key("100"),
    );
  });

  it("handles unparseable originalKey by returning it as-is", () => {
    const pm = mkPositionMgr([]);
    assert.equal(
      resolveLiveKey(pm, "not-a-composite-key"),
      "not-a-composite-key",
    );
  });
});

describe("wasMigratedFrom", () => {
  it("returns false when getBotState is absent or returns nothing", () => {
    assert.equal(wasMigratedFrom("k", "100"), false);
    assert.equal(
      wasMigratedFrom("k", "100", () => undefined),
      false,
    );
  });

  it("returns false when state has no rebalanceEvents", () => {
    assert.equal(
      wasMigratedFrom("k", "100", () => ({})),
      false,
    );
  });

  it("returns true when an event's oldTokenId matches", () => {
    assert.equal(
      wasMigratedFrom("k", "100", () => ({
        rebalanceEvents: [{ oldTokenId: "100", newTokenId: "200" }],
      })),
      true,
    );
  });

  it("string/number tolerant on tokenId comparison", () => {
    assert.equal(
      wasMigratedFrom("k", 100, () => ({
        rebalanceEvents: [{ oldTokenId: "100", newTokenId: "200" }],
      })),
      true,
    );
    assert.equal(
      wasMigratedFrom("k", "100", () => ({
        rebalanceEvents: [{ oldTokenId: 100, newTokenId: 200 }],
      })),
      true,
    );
  });

  it("returns false on no match in events", () => {
    assert.equal(
      wasMigratedFrom("k", "999", () => ({
        rebalanceEvents: [{ oldTokenId: "100", newTokenId: "200" }],
      })),
      false,
    );
  });
});
