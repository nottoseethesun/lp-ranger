/**
 * @file test/dashboard-date-utils.test.js
 * @description Tests for the pure date helpers used by the Lifetime panel.
 *
 * `_ltStartDate` in dashboard-data-kpi.js must pick the EARLIEST
 * available date, not the first non-null.  A `||` cascade
 * (`firstEpochDateUtc || mintDate || poolFirstDate`) takes
 * `firstEpochDateUtc` whenever it is set, and on an adopted long-lived
 * NFT that is far fresher than the on-chain `mintDate` — the Lifetime
 * Day Count then reads 0.07 days for a position months old.  These
 * tests drive the `pickEarliestDate` helper that decides it.
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
      "2024-06-21", // poolFirstMintDate
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

describe("ltStartDate", () => {
  let ltStartDate;

  before(async () => {
    const mod = await import("../public/dashboard-date-utils.js");
    ltStartDate = mod.ltStartDate;
  });

  it("picks the earliest of all three per-position date sources", () => {
    /*- Mint pre-dates the bot's first epoch and the wallet's first pool
        mint, so it should win. */
    const d = {
      pnlSnapshot: { firstEpochDateUtc: "2026-04-25" },
      hodlBaseline: { mintDate: "2024-06-21" },
      poolFirstMintDate: "2025-01-10",
    };
    assert.equal(ltStartDate(d), "2024-06-21");
  });

  it("REGRESSION: reads poolFirstMintDate from poll payload, not module state", () => {
    /*- Prior bug: a module-level _poolFirstDate cache was set once and
        never cleared between pool switches.  Pool A's date stuck for
        every subsequent pool, producing identical Lifetime Day Counts
        ("44.91 days") across all positions.  Resolution: dropped the
        cache; ltStartDate now reads d.poolFirstMintDate per call. */
    const poolA = {
      pnlSnapshot: { firstEpochDateUtc: "2026-04-25" },
      hodlBaseline: { mintDate: null },
      poolFirstMintDate: "2026-03-14",
    };
    const poolB = {
      pnlSnapshot: { firstEpochDateUtc: "2026-04-25" },
      hodlBaseline: { mintDate: null },
      poolFirstMintDate: "2025-08-01",
    };
    /*- Switching from poolA's payload to poolB's must yield poolB's
        earlier date — no leakage from the prior call. */
    assert.equal(ltStartDate(poolA), "2026-03-14");
    assert.equal(ltStartDate(poolB), "2025-08-01");
  });

  it("returns null when every source is missing", () => {
    assert.equal(ltStartDate({}), null);
    assert.equal(ltStartDate({ pnlSnapshot: {}, hodlBaseline: {} }), null);
  });

  it("tolerates undefined input", () => {
    assert.equal(ltStartDate(undefined), null);
    assert.equal(ltStartDate(null), null);
  });

  it("falls back to firstEpochDateUtc when mintDate and poolFirstMintDate are missing", () => {
    const d = { pnlSnapshot: { firstEpochDateUtc: "2026-04-25" } };
    assert.equal(ltStartDate(d), "2026-04-25");
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
