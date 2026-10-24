"use strict";

/**
 * @file test/dashboard-rebalance-log.test.js
 * @description How a Rebalance entry in the Activity Log reads
 *   (src/client/web/dashboard-rebalance-log.js), the one wording both the live
 *   check and the history pass draw it with: the NFT it drained and the
 *   one it minted, what started it when its record says, and its time
 *   from the chain.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let formatRebalanceEntry;

before(async () => {
  ({ formatRebalanceEntry } =
    await import("../src/client/web/dashboard-rebalance-log.js"));
});

const EV = Object.freeze({
  oldTokenId: "163164",
  newTokenId: "167040",
  dateStr: "2026-10-19T11:17:00.000Z",
  timestamp: 1792408620,
});

describe("formatRebalanceEntry", () => {
  it("names what started the rebalance when its record says", () => {
    const cases = {
      "out-of-range": "Out of Range",
      manual: "Manual",
      "residual-cleanup": "Residual Cleanup",
    };
    for (const [trigger, label] of Object.entries(cases))
      assert.equal(
        formatRebalanceEntry({ ...EV, trigger }, "").detail,
        `NFT #163164 → #167040 (${label})`,
      );
  });

  it("names nothing for a rebalance found on the chain, or one it does not know", () => {
    for (const trigger of [undefined, null, "bogus", "toString"])
      assert.equal(
        formatRebalanceEntry({ ...EV, trigger }, "").detail,
        "NFT #163164 → #167040",
      );
  });

  it("puts the position's line after the detail", () => {
    assert.equal(
      formatRebalanceEntry({ ...EV, trigger: "manual" }, "\nPulseX/WPLS")
        .detail,
      "NFT #163164 → #167040 (Manual)\nPulseX/WPLS",
    );
  });

  it("takes the rebalance's own time, from its date or its block time", () => {
    assert.equal(
      formatRebalanceEntry(EV, "").when.toISOString(),
      "2026-10-19T11:17:00.000Z",
    );
    const { dateStr: _omitted, ...noDate } = EV;
    assert.equal(
      formatRebalanceEntry(noDate, "").when.getTime(),
      1792408620 * 1000,
    );
    assert.equal(
      formatRebalanceEntry({ oldTokenId: "1", newTokenId: "2" }, "").when,
      undefined,
    );
  });
});
