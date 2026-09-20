/**
 * @file test/rescan-prices-recent-window.test.js
 * @description
 * Re-scan Prices → "Limit to the last N days".
 *
 * The option exists so an operator who spots one bad recent price can
 * fix it in a moment instead of waiting out a whole-chain rebuild. It is
 * a DATE cutoff rather than a per-period choice because that is the only
 * axis the stored data supports: an epoch records `closeTime` but not
 * the NFT it came from.
 *
 * What these pin:
 *   1. The window reaches only the recent end, and carries older periods
 *      over untouched.
 *   2. It is refused whenever honouring it could corrupt the table — an
 *      incomplete history, or a split that does not account for every
 *      period — and falls back to a full rebuild.
 *   3. It rides only a re-value, never a Reload, and never outlives the
 *      request that set it.
 *   4. The day count is the server's, so a request cannot ask for a
 *      reach the dashboard never offered.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  _splitByWindow,
  _consumeRebuildRequest,
} = require("../src/epoch-reconstructor");
const { requestPriceRevalue } = require("../src/server-rescan-prices");
const { readBotConfigDefaults } = require("../src/bot-config-defaults");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 19);

/** A rebalance event: `timestamp` is Unix SECONDS, as on chain. */
function ev(oldTokenId, daysAgo) {
  return {
    oldTokenId,
    newTokenId: String(Number(oldTokenId) + 1),
    timestamp: Math.floor((NOW - daysAgo * DAY) / 1000),
  };
}

/** A stored closed epoch; `closeTime` is milliseconds. */
function epoch(daysAgo) {
  return {
    closeTime: NOW - daysAgo * DAY,
    gas: 1,
    openTime: NOW - daysAgo * DAY,
  };
}

describe("the window splits recent from settled", () => {
  it("re-reads only what closed inside it", () => {
    const events = [ev("1", 400), ev("2", 300), ev("3", 10), ev("4", 2)];
    const ids = ["1", "2", "3", "4"];
    const cached = [epoch(400), epoch(300), epoch(10), epoch(2)];

    const { ids: toRead, keep } = _splitByWindow(events, ids, cached, 60, NOW);
    assert.deepEqual(toRead, ["3", "4"], "only the recent NFTs are re-read");
    assert.equal(keep.length, 2, "the two older periods are carried over");
    assert.ok(
      keep.every((e) => e.closeTime < NOW - 60 * DAY),
      "and every kept period really is older than the cutoff",
    );
  });

  it("accounts for every period between the two halves", () => {
    const events = [ev("1", 400), ev("2", 10)];
    const ids = ["1", "2"];
    const { ids: toRead, keep } = _splitByWindow(
      events,
      ids,
      [epoch(400), epoch(10)],
      60,
      NOW,
    );
    assert.equal(
      toRead.length + keep.length,
      ids.length,
      "a period must be either re-read or kept — never both, never neither",
    );
  });

  it("re-reads an NFT whose close time is unknown", () => {
    /*- An unknown date must not be read as "old enough to skip": the
     *  window is an optimisation, and guessing costs a wrong row. */
    const events = [{ oldTokenId: "1", newTokenId: "2" }, ev("2", 400)];
    const { ids: toRead } = _splitByWindow(
      events,
      ["1", "2"],
      [epoch(400), epoch(400)],
      60,
      NOW,
    );
    assert.ok(toRead.includes("1"), "no timestamp means re-read");
  });

  it("does nothing at all when no window is asked for", () => {
    const events = [ev("1", 400), ev("2", 2)];
    const { ids: toRead, keep } = _splitByWindow(
      events,
      ["1", "2"],
      [epoch(400), epoch(2)],
      0,
      NOW,
    );
    assert.deepEqual(toRead, ["1", "2"], "every NFT is re-read");
    assert.equal(keep.length, 0, "nothing is carried over");
  });
});

describe("the window is refused when honouring it could corrupt the table", () => {
  it("rebuilds in full when the history is incomplete", () => {
    /*- Two epochs for three closed NFTs, arranged so the arithmetic
     *  check downstream would NOT catch it: one old NFT and two recent
     *  ones, one old epoch kept and two recent rebuilt, which adds to
     *  three and looks right. Only the completeness test sees that the
     *  set it is carrying a row out of was short to begin with — and a
     *  stored epoch does not name its NFT, so the kept row may be the
     *  wrong one and the gap survives the rebuild that was meant to
     *  close it. Remove that test and this case passes silently. */
    const events = [ev("1", 400), ev("2", 2), ev("3", 3)];
    const ids = ["1", "2", "3"];
    const { ids: toRead, keep } = _splitByWindow(
      events,
      ids,
      [epoch(400), epoch(2)],
      60,
      NOW,
    );
    assert.deepEqual(toRead, ids, "every NFT is re-read");
    assert.equal(keep.length, 0, "nothing is carried over");
  });

  it("rebuilds in full when the two halves do not add up", () => {
    /*- An epoch's closeTime and its rebalance event's timestamp can fall
     *  on opposite sides of the cutoff. Here every event is recent but
     *  every stored epoch is old, so keeping and re-reading would
     *  together produce more rows than the chain has. */
    const events = [ev("1", 2), ev("2", 3)];
    const { ids: toRead, keep } = _splitByWindow(
      events,
      ["1", "2"],
      [epoch(400), epoch(300)],
      60,
      NOW,
    );
    assert.deepEqual(toRead, ["1", "2"]);
    assert.equal(keep.length, 0, "the table is rebuilt rather than corrupted");
  });
});

describe("the window rides only a re-value", () => {
  const tracker = () => ({ restore: () => {}, serialize: () => ({}) });

  it("is carried through by a Re-scan Prices request", () => {
    const st = { _needsEpochPriceRevalue: true, _epochRevalueWindowDays: 60 };
    const r = _consumeRebuildRequest(st, tracker(), { liveEpoch: null });
    assert.equal(r.forced, true);
    assert.equal(r.refreshPrices, true);
    assert.equal(r.windowDays, 60);
  });

  it("is ignored on a Reload, which must replace the whole history", () => {
    const st = { _needsEpochRebuild: true, _epochRevalueWindowDays: 60 };
    const r = _consumeRebuildRequest(st, tracker(), { liveEpoch: null });
    assert.equal(r.windowDays, 0, "a windowed Reload would keep stale rows");
  });

  it("does not outlive the request that set it", () => {
    const st = { _needsEpochPriceRevalue: true, _epochRevalueWindowDays: 60 };
    _consumeRebuildRequest(st, tracker(), { liveEpoch: null });
    assert.equal(
      st._epochRevalueWindowDays,
      0,
      "left standing, it would silently scope some later rebuild",
    );
  });
});

describe("the day count belongs to the server", () => {
  it("is the shipped default, and is a sane number of days", () => {
    const d = readBotConfigDefaults().rescanPricesRecentWindowDays;
    assert.equal(typeof d, "number");
    assert.ok(Number.isInteger(d) && d >= 1 && d <= 3650, `got ${d}`);
  });

  it("is set only alongside the rebuild it scopes", () => {
    const withTable = {};
    requestPriceRevalue(withTable, true, 60);
    assert.equal(withTable._needsEpochPriceRevalue, true);
    assert.equal(withTable._epochRevalueWindowDays, 60);

    /*- Without the Per-Day rebuild there is nothing date-scoped to
     *  limit, so no window may be left on the state to be picked up
     *  later by a rebuild the operator did not scope. */
    const withoutTable = {};
    requestPriceRevalue(withoutTable, false, 60);
    assert.equal(withoutTable._needsEpochPriceRevalue, undefined);
    assert.equal(withoutTable._epochRevalueWindowDays, undefined);
  });

  it("treats a nonsense day count as no window", () => {
    for (const bad of [0, -1, 1.5, "60", null, undefined]) {
      const st = {};
      requestPriceRevalue(st, true, bad);
      assert.equal(st._epochRevalueWindowDays, 0, `for ${String(bad)}`);
    }
  });
});

describe("a short windowed read is never merged", () => {
  /*- The hazard is in `setCachedEpochs`: it reads a short incoming set
   *  as one whose OLD periods are missing and prepends that many from
   *  the cache. With a window the old periods are already present in
   *  `keep`, so the prepend would duplicate them. `_rebuildClosedEpochs`
   *  therefore abandons the window and rebuilds the whole chain. */
  const { _rebuildClosedEpochs } = require("../src/epoch-reconstructor");

  function harness(readsThatSucceed) {
    const events = [ev("1", 400), ev("2", 300), ev("3", 5), ev("4", 2)];
    const closedIds = ["1", "2", "3", "4"];
    const cachedEpochs = [epoch(400), epoch(300), epoch(5), epoch(2)];
    const asked = [];
    return {
      asked,
      args: {
        botState: { activePosition: null, _epochResumeBuffer: new Map() },
        closedIds,
        rebalanceEvents: events,
        cachedEpochs,
        fallbackPrices: null,
        readChainEvents: null,
        refreshPrices: true,
        windowDays: 60,
        onProgress: null,
        /*- Injected stand-in for the chain read; see `_fetchEpochsFromChain`. */
        _fetch: async (ids) => {
          asked.push([...ids]);
          return ids.slice(0, readsThatSucceed).map(() => epoch(1));
        },
      },
    };
  }

  it("merges when every windowed period came back", async () => {
    const h = harness(99);
    const out = await _rebuildClosedEpochs(h.args);
    assert.deepEqual(h.asked, [["3", "4"]], "only the window was read");
    assert.equal(out.length, 4, "two kept plus two rebuilt");
  });

  it("rebuilds the whole chain when one came back short", async () => {
    const h = harness(1);
    const out = await _rebuildClosedEpochs(h.args);
    assert.equal(h.asked.length, 2, "it went back for the rest");
    assert.deepEqual(h.asked[1], ["1", "2", "3", "4"], "the whole chain");
    assert.ok(
      out.length <= 4,
      "and never a merged set longer than the chain itself",
    );
  });
});
