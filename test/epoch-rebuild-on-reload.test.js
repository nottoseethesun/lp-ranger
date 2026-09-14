/**
 * @file test/epoch-rebuild-on-reload.test.js
 * @description Guards the path that lets `Reload Current Position`
 *   actually re-derive P&L epochs.
 *
 *   Reload clears the epoch cache on disk, but the bot loop holds its
 *   epochs in memory.  The completeness guard in `reconstructEpochs`
 *   therefore saw a full history and returned before doing any work,
 *   and the next poll wrote the untouched set back over the cleared
 *   file.  Reload cleared a copy that memory restored seconds later, so
 *   no correction to how an epoch is derived could reach an existing
 *   install without hand-editing a cache file.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

/** Minimal tracker double: records what it was restored with. */
function mockTracker(closedEpochs, liveEpoch) {
  let data = { closedEpochs: closedEpochs || [], liveEpoch: liveEpoch ?? null };
  return {
    serialize: () => data,
    restore: (d) => {
      data = d;
    },
    epochCount: () => data.closedEpochs?.length || 0,
  };
}

describe("_consumeRebuildRequest — the one-shot request", () => {
  const { _consumeRebuildRequest } = require("../src/epoch-reconstructor");

  it("does nothing when no rebuild was requested", () => {
    const tracker = mockTracker([{ id: 1 }, { id: 2 }]);
    assert.equal(
      _consumeRebuildRequest({}, tracker, tracker.serialize()),
      false,
    );
    assert.equal(tracker.serialize().closedEpochs.length, 2);
  });

  it("drops the closed epochs but keeps the open one", () => {
    /*- The open epoch is the live position, not history. */
    const live = { id: 9, status: "open" };
    const tracker = mockTracker([{ id: 1 }, { id: 2 }], live);
    const botState = { _needsEpochRebuild: true };
    assert.equal(
      _consumeRebuildRequest(botState, tracker, tracker.serialize()),
      true,
    );
    assert.deepEqual(tracker.serialize().closedEpochs, []);
    assert.equal(tracker.serialize().liveEpoch, live);
  });

  it("clears the flag so it fires once, not on every later scan", () => {
    const tracker = mockTracker([{ id: 1 }]);
    const botState = { _needsEpochRebuild: true };
    _consumeRebuildRequest(botState, tracker, tracker.serialize());
    assert.equal(botState._needsEpochRebuild, false);
    assert.equal(
      _consumeRebuildRequest(botState, tracker, tracker.serialize()),
      false,
    );
  });

  it("ignores a truthy-but-not-true value", () => {
    /*- Explicit === true, per the project's no-coercion rule. */
    const tracker = mockTracker([{ id: 1 }]);
    assert.equal(
      _consumeRebuildRequest(
        { _needsEpochRebuild: "yes" },
        tracker,
        tracker.serialize(),
      ),
      false,
    );
  });
});

describe("reconstructEpochs — forced rebuild after a reload", () => {
  let reconstructEpochs;
  const _origRequire = Module.prototype.require;
  let _mockHistory = {};
  let _cacheReads = 0;
  let _cachedEpochs = null;
  let _cacheWrites = [];

  const HISTORY = {
    mintDate: "2026-01-01T00:00:00Z",
    closeDate: "2026-01-02T00:00:00Z",
    entryValueUsd: 100,
    exitValueUsd: 95,
    feesEarnedUsd: 35,
    /*- Declared, not omitted: an omitted gas cost now means "not known"
     *  and the epoch is rejected. Zero, because this fixture is about
     *  reload behaviour and not about gas. */
    gasCostWei: "0",
  };

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./position-history") {
        return {
          getPositionHistory: async (tokenId) => {
            if (_mockHistory[tokenId]) return _mockHistory[tokenId];
            throw new Error("unknown token " + tokenId);
          },
        };
      }
      if (id === "./epoch-cache") {
        return {
          getCachedEpochs: () => {
            _cacheReads++;
            return _cachedEpochs;
          },
          setCachedEpochs: (k, e) => _cacheWrites.push(e),
        };
      }
      if (id === "./bot-pnl-updater") {
        return { actualGasCostUsd: async () => 0 };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/epoch-reconstructor")];
    ({ reconstructEpochs } = require("../src/epoch-reconstructor"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/epoch-reconstructor")];
  });

  /** Reset per-test observation state. */
  function reset() {
    _cacheReads = 0;
    _cachedEpochs = null;
    _cacheWrites = [];
    _mockHistory = { 50: { ...HISTORY }, 51: { ...HISTORY } };
  }

  const EVENTS = [
    { oldTokenId: "50", newTokenId: "51" },
    { oldTokenId: "51", newTokenId: "52" },
  ];

  /** A bot state whose epoch history already looks complete. */
  function botState(extra) {
    return {
      activePosition: { token0: "0xA", token1: "0xB", fee: 3000 },
      walletAddress: "0xW",
      ...extra,
    };
  }

  it("short-circuits on a complete history when NOT forced", async () => {
    reset();
    const tracker = mockTracker([{ id: 1 }, { id: 2 }]);
    const n = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: EVENTS,
      botState: botState(),
      updateBotState: () => {},
    });
    assert.equal(n, 0, "should not rebuild");
    assert.equal(tracker.serialize().closedEpochs.length, 2);
  });

  it("rebuilds from chain when forced, despite a complete history", async () => {
    /*- The regression: 132 held vs 132 on chain short-circuited, so a
     *  corrected fee derivation could never reach an existing install. */
    reset();
    const tracker = mockTracker([{ id: 1 }, { id: 2 }]);
    const st = botState({ _needsEpochRebuild: true });
    const n = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: EVENTS,
      botState: st,
      updateBotState: () => {},
    });
    assert.equal(n, 2, "should rebuild both epochs");
    assert.equal(st._needsEpochRebuild, false, "request must be consumed");
    /*- Freshly built, so it carries the corrected fee figure. */
    assert.equal(tracker.serialize().closedEpochs[0].feePnl, 35);
    assert.equal(_cacheWrites.length, 1, "rebuilt epochs must be persisted");
  });

  it("does not take the disk-cache shortcut while forced", async () => {
    /*- A poll landing between the reload's cache clear and this call
     *  can write the outgoing epochs back.  Reading the cache here
     *  would hand back exactly the data being replaced. */
    reset();
    _cachedEpochs = { closedEpochs: [{ id: 1, stale: true }, { id: 2 }] };
    const tracker = mockTracker([{ id: 1 }, { id: 2 }]);
    const n = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: EVENTS,
      botState: botState({ _needsEpochRebuild: true }),
      updateBotState: () => {},
    });
    assert.equal(_cacheReads, 0, "cache must not be consulted when forced");
    assert.equal(n, 2);
    assert.ok(
      !tracker.serialize().closedEpochs.some((e) => e.stale),
      "stale cached epoch must not survive",
    );
  });

  it("still uses the disk cache on a normal restart", async () => {
    /*- The fast restart path must be untouched for the common case. */
    reset();
    _cachedEpochs = { closedEpochs: [{ id: 1 }, { id: 2 }] };
    const tracker = mockTracker([]);
    const n = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: EVENTS,
      botState: botState(),
      updateBotState: () => {},
    });
    assert.equal(_cacheReads, 1);
    assert.equal(n, 2);
  });

  it("leaves the tracker empty when a forced rebuild finds nothing", async () => {
    /*- Self-healing: with no closed epochs held there is nothing stale
     *  for a later poll to write back, and the next scan sees an
     *  incomplete history and tries again without needing a flag. */
    reset();
    _mockHistory = {};
    const tracker = mockTracker([{ id: 1 }, { id: 2 }]);
    const n = await reconstructEpochs({
      pnlTracker: tracker,
      rebalanceEvents: EVENTS,
      botState: botState({ _needsEpochRebuild: true }),
      updateBotState: () => {},
    });
    assert.equal(n, 0);
    assert.deepEqual(tracker.serialize().closedEpochs, []);
    assert.equal(_cacheWrites.length, 0, "must not persist an empty rebuild");
  });
});

describe("_resetBotState — what Reload asks for", () => {
  const { _resetBotState } = require("../src/server-reload-position");

  it("requests an epoch rebuild", () => {
    const state = {};
    _resetBotState(state);
    assert.equal(state._needsEpochRebuild, true);
  });

  it("still lowers the readiness gates the dialog waits on", () => {
    /*- The reload modal polls until lifetimeScanComplete flips back to
     *  true, which happens only after the history scan — and therefore
     *  after the epoch rebuild — has finished. */
    const state = { lifetimeScanComplete: true, rebalanceScanComplete: true };
    _resetBotState(state);
    assert.equal(state.lifetimeScanComplete, false);
    assert.equal(state.rebalanceScanComplete, false);
    assert.equal(state._needsFullRescan, true);
  });
});
