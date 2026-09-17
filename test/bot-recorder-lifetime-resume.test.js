/**
 * @file test/bot-recorder-lifetime-resume.test.js
 * @description Tests for where the lifetime scan in
 * `src/bot-recorder-lifetime.js` starts: from pool creation whenever it
 * reads, never at the cached `lastNftScanBlock`, and not at all when
 * every result is already saved.
 *
 * Split from `bot-recorder-lifetime.test.js` when that file passed the
 * 500-line cap; the mock harness is shared via `test/helpers/`, not
 * copied.
 *
 * The bug these pin (2026-09-01, position #164418): `lastNftScanBlock`
 * says "everything before this block is accounted for", which is only
 * true of a result that was actually saved.  One pass over the chain
 * feeds three results — lifetime HODL, Fees Compounded, Lifetime
 * Deposit — each with its own disk flag.  The old condition consulted
 * only the HODL flag, so a position with a cached HODL but no saved
 * compound total resumed at a recent block and handed
 * `_classifyAllCompounds` a 2-NFT slice of a 133-NFT chain.  It summed
 * the slice and wrote $12.05 where the chain totals ~$1,184.  Nothing
 * threw: the 131 absent tokenIds each contributed zero.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  state,
  resetState,
  installMocks,
  restoreMocks,
  makePosition,
  makeBotState,
} = require("./helpers/bot-recorder-lifetime-mocks");

describe("canResumeIncrementally", () => {
  /*- The pure form of the fix.  `lastNftScanBlock` means "everything
   *  before this block is already accounted for" — true only for a
   *  result that was actually kept.  One pass over the chain feeds three
   *  results, so all three flags have to hold before the cursor may be
   *  used. */
  let canResumeIncrementally;

  beforeEach(() => {
    installMocks();
    ({ canResumeIncrementally } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  it("is true only when all three lifetime results are already on disk", () => {
    assert.equal(
      canResumeIncrementally({
        cachedHodl: { poolAddress: "0xPOOL" },
        hasCompoundData: true,
        hasDepositData: true,
      }),
      true,
    );
  });

  it("is false when the compound total is missing", () => {
    /*- The exact state position #164418 was in on 2026-09-01: HODL
     *  cached by the unmanaged detail scan, compound total never
     *  persisted.  Resuming here is what produced $12.05 instead of
     *  ~$1,184. */
    assert.equal(
      canResumeIncrementally({
        cachedHodl: { poolAddress: "0xPOOL" },
        hasCompoundData: false,
        hasDepositData: true,
      }),
      false,
    );
  });

  it("is false when the deposit total is missing", () => {
    /*- The same hazard in the other column — the reason this checks all
     *  three rather than adding a second special case for compounds. */
    assert.equal(
      canResumeIncrementally({
        cachedHodl: { poolAddress: "0xPOOL" },
        hasCompoundData: true,
        hasDepositData: false,
      }),
      false,
    );
  });

  it("is false when the cached HODL is missing", () => {
    assert.equal(
      canResumeIncrementally({
        cachedHodl: null,
        hasCompoundData: true,
        hasDepositData: true,
      }),
      false,
    );
  });

  it("is false for an empty state", () => {
    assert.equal(canResumeIncrementally({}), false);
  });
});

describe("_scanLifetimePoolData — where the event scan starts", () => {
  let _scanLifetimePoolData;

  beforeEach(() => {
    resetState();
    /*- Far apart so the assertions name which branch was taken. */
    state.poolCreationBlock = 100;
    state.lastNftScanBlock = 999_000;
    state.scanFromBlock = null;
    installMocks();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(() => {
    restoreMocks();
    state.poolCreationBlock = 0;
    state.lastNftScanBlock = 0;
    state.scanFromBlock = null;
  });

  const _run = (configValues) =>
    _scanLifetimePoolData(
      makePosition(),
      makeBotState(configValues),
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );

  it("starts from pool creation when the compound total is missing", async () => {
    /*- A cached HODL alone must not authorise resuming at the cursor:
     *  that hands `_classifyAllCompounds` a slice of the chain, and it
     *  writes that slice's sum as the lifetime total. */
    await _run({ totalLifetimeDepositUsd: 1704.15 });
    assert.equal(state.classifyCalled, true, "compounds must be classified");
    assert.equal(
      state.scanFromBlock,
      100,
      "must rescan the whole chain, not resume at the cursor",
    );
  });

  it("starts from pool creation when the deposit total is missing", async () => {
    await _run({ totalCompoundedUsd: 148.38 });
    assert.equal(state.depositCalled, true, "deposit must be recomputed");
    assert.equal(state.scanFromBlock, 100);
  });

  it("starts from pool creation when the HODL is not cached", async () => {
    state.cachedHodl = null;
    await _run({
      totalCompoundedUsd: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    assert.equal(state.scanFromBlock, 100);
  });

  it("ignores the cursor on a forced rescan of an otherwise-complete slot", async () => {
    /*- All three present, so nothing needs the old events — but
     *  `_needsFullRescan` overrides regardless, because the rebalance
     *  path sets it precisely when the chain has grown. */
    const botState = makeBotState({
      totalCompoundedUsd: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    botState._needsFullRescan = true;
    await _scanLifetimePoolData(
      makePosition(),
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
    );
    assert.equal(
      state.scanFromBlock,
      100,
      "a full rescan must ignore the cursor entirely",
    );
  });

  it("does not scan at all when every result is already on disk", async () => {
    /*- The early return still wins: nothing to compute, so no events are
     *  fetched from any block. */
    await _run({
      totalCompoundedUsd: 148.38,
      totalLifetimeDepositUsd: 1704.15,
    });
    assert.equal(state.scanCalled, false);
    assert.equal(state.scanFromBlock, null);
  });
});
