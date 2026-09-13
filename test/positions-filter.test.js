/**
 * @file test/positions-filter.test.js
 * @description Tests for the LP Position Browser filter matcher.
 *
 * The matcher lives in `public/positions-filter.js` as a pure-JS module
 * with zero browser dependencies (no DOM, no localStorage), so it can be
 * loaded into Node tests via dynamic ESM import.
 *
 * The haystack must include `token0Symbol` and `token1Symbol`: the pair
 * name is what a user types into the LP browser filter (e.g. "CRO" or
 * "dwb"), and omitting the symbols makes that search match nothing
 * while every other field still works.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

describe("matchesPosFilter", () => {
  let matchesPosFilter;

  before(async () => {
    const mod = await import("../public/positions-filter.js");
    matchesPosFilter = mod.matchesPosFilter;
  });

  /** Build a position-store entry resembling a real scan result. */
  function entry(overrides = {}) {
    return {
      positionType: "nft",
      tokenId: "158447",
      walletAddress: "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
      contractAddress: "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      token0: "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b",
      token1: "0xAEbcD0F8f69ECF9587e292bdfc4d731c1abedB68",
      token0Symbol: "CRO",
      token1Symbol: "dickwifbutt",
      ...overrides,
    };
  }

  it("matches by token symbol (token0Symbol) — REGRESSION", () => {
    assert.equal(matchesPosFilter(entry(), "cro"), true);
  });

  it("matches by token symbol (token1Symbol) — REGRESSION", () => {
    assert.equal(matchesPosFilter(entry(), "dickwifbutt"), true);
  });

  it("matches a partial symbol case-insensitively", () => {
    assert.equal(matchesPosFilter(entry(), "dick"), true);
  });

  it("matches by token ID", () => {
    assert.equal(matchesPosFilter(entry(), "158447"), true);
  });

  it("matches by wallet address", () => {
    assert.equal(matchesPosFilter(entry(), "0x4e44847675763d"), true);
  });

  it("matches by token0 contract address", () => {
    assert.equal(matchesPosFilter(entry(), "0xa0b73e1ff0b8"), true);
  });

  it("matches by token1 contract address", () => {
    assert.equal(matchesPosFilter(entry(), "0xaebcd0f8f69e"), true);
  });

  it("matches by positionType", () => {
    assert.equal(matchesPosFilter(entry(), "nft"), true);
  });

  it("does not match unrelated text", () => {
    assert.equal(matchesPosFilter(entry(), "ethereum"), false);
  });

  it("returns true for empty filter (no filtering)", () => {
    assert.equal(matchesPosFilter(entry(), ""), true);
  });

  it("survives missing token symbols on entry", () => {
    const e = entry({ token0Symbol: undefined, token1Symbol: undefined });
    // Address-based search still works.
    assert.equal(matchesPosFilter(e, "0xa0b73e"), true);
    // Symbol-based search returns false (gracefully, no crash).
    assert.equal(matchesPosFilter(e, "cro"), false);
  });
});
