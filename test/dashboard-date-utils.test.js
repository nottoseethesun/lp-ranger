/**
 * @file test/dashboard-date-utils.test.js
 * @description Tests for the pure date helpers used by the Lifetime panel.
 *
 * Regression history: `_ltStartDate` in dashboard-data-kpi.js used a `||`
 * cascade (`firstEpochDateUtc || mintDate || poolFirstDate`).  When the bot
 * adopted a long-lived NFT, `firstEpochDateUtc` was much fresher than the
 * on-chain `mintDate`, so the Lifetime Day Count showed e.g. 0.07 days for
 * positions actually alive for months.  Fix: pick the EARLIEST available
 * date string instead of the first non-null.  These tests guard the
 * underlying `pickEarliestDate` helper against regression.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

describe("pickEarliestDate", () => {
  let pickEarliestDate;

  before(async () => {
    const mod = await import("../public/dashboard-date-utils.js");
    pickEarliestDate = mod.pickEarliestDate;
  });

  it("returns the earlier of two valid dates", () => {
    assert.equal(pickEarliestDate(["2026-04-25", "2024-06-21"]), "2024-06-21");
  });

  it("REGRESSION: prefers older mintDate over fresher firstEpochDateUtc", () => {
    /*- Mirrors the prod bug: NFT minted in 2024 but firstEpochDateUtc
        reflects when the bot first picked it up in 2026. */
    const result = pickEarliestDate([
      "2026-04-25", // pnlSnapshot.firstEpochDateUtc (bot adoption)
      "2024-06-21", // hodlBaseline.mintDate (true on-chain mint)
      "2024-06-21", // _poolFirstDate
    ]);
    assert.equal(result, "2024-06-21");
  });

  it("returns null when all candidates are null/undefined", () => {
    assert.equal(pickEarliestDate([null, undefined, null]), null);
  });

  it("returns null for empty input", () => {
    assert.equal(pickEarliestDate([]), null);
  });

  it("skips non-string values", () => {
    assert.equal(
      pickEarliestDate([123, "2026-01-01", { foo: "bar" }]),
      "2026-01-01",
    );
  });

  it("skips strings shorter than 10 chars", () => {
    assert.equal(pickEarliestDate(["2026", "2026-01-01"]), "2026-01-01");
  });

  it("truncates ISO timestamps to the date prefix", () => {
    /*- _patchMintTimestamp historically wrote ISO strings like
        "2026-04-24T18:00:00.000Z" to mintDate.  We accept these by
        truncating to YYYY-MM-DD. */
    assert.equal(
      pickEarliestDate(["2026-04-24T18:00:00.000Z", "2026-04-25"]),
      "2026-04-24",
    );
  });

  it("returns the only valid date when others are invalid", () => {
    assert.equal(
      pickEarliestDate([null, undefined, "2026-04-25"]),
      "2026-04-25",
    );
  });
});

describe("toMintTsSeconds", () => {
  let toMintTsSeconds;

  before(async () => {
    const mod = await import("../public/dashboard-date-utils.js");
    toMintTsSeconds = mod.toMintTsSeconds;
  });

  it("passes Unix seconds (number) through unchanged", () => {
    assert.equal(toMintTsSeconds(1777145925), 1777145925);
  });

  it("converts ISO strings to Unix seconds (legacy shape)", () => {
    /*- Mirrors prod's tokenId 71544 which was patched with an ISO
        string by the older _patchMintTimestamp. */
    assert.equal(
      toMintTsSeconds("2024-06-21T00:00:00.000Z"),
      Math.floor(Date.UTC(2024, 5, 21) / 1000),
    );
  });

  it("converts Unix milliseconds to seconds (defensive)", () => {
    assert.equal(toMintTsSeconds(1777145925000), 1777145925);
  });

  it("returns null for null/undefined", () => {
    assert.equal(toMintTsSeconds(null), null);
    assert.equal(toMintTsSeconds(undefined), null);
  });

  it("returns null for unparseable strings", () => {
    assert.equal(toMintTsSeconds("not a date"), null);
  });

  it("returns null for non-finite numbers", () => {
    assert.equal(toMintTsSeconds(NaN), null);
    assert.equal(toMintTsSeconds(Infinity), null);
  });

  it("floors fractional seconds", () => {
    assert.equal(toMintTsSeconds(1234567890.7), 1234567890);
  });
});
