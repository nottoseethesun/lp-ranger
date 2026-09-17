"use strict";

/**
 * @file test/bot-recorder-lifetime-share.test.js
 * @description The lifetime scan's side of sharing one chain read with
 *   epoch reconstruction.
 *
 *   `lifetimeScanPlan` is the one place the scan decides whether it will
 *   read; the scan pass asks it before reconstruction. Reconstruction can
 *   only take its histories from the lifetime read if that read covers
 *   each NFT's whole history, so the invariant that makes sharing safe —
 *   every read the plan calls for starts from the pool's floor — is
 *   pinned here for every state.
 *
 *   Uses the shared lifetime mock harness; see
 *   test/helpers/bot-recorder-lifetime-mocks.js.
 */

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

const POOL_FLOOR = 100;
const SAVED = { totalCompoundedUsd: 148.38, totalLifetimeDepositUsd: 1704.15 };

/** Every combination of the four flags that decide a lifetime scan. */
function everyState() {
  const out = [];
  for (let bits = 0; bits < 16; bits++) {
    out.push({
      fullRescan: !!(bits & 1),
      compound: !!(bits & 2),
      hodl: !!(bits & 4),
      deposit: !!(bits & 8),
    });
  }
  return out;
}

/** Bot state and cache for one combination. */
function arrange(s) {
  state.cachedHodl = s.hodl ? { poolAddress: "0xPOOL" } : null;
  const cfg = {};
  if (s.compound) cfg.totalCompoundedUsd = SAVED.totalCompoundedUsd;
  if (s.deposit) cfg.totalLifetimeDepositUsd = SAVED.totalLifetimeDepositUsd;
  const botState = makeBotState(cfg);
  botState._needsFullRescan = s.fullRescan;
  return botState;
}

const position = () => ({ ...makePosition(), tokenId: "300" });

let lifetime;
beforeEach(() => {
  resetState();
  state.poolCreationBlock = POOL_FLOOR;
  installMocks();
  lifetime = require("../src/bot-recorder-lifetime");
});
afterEach(restoreMocks);

describe("lifetimeScanPlan", () => {
  it("calls for a read exactly when the scan has something to compute", () => {
    for (const s of everyState()) {
      const plan = lifetime.lifetimeScanPlan(arrange(s), "epoch-key");
      const settled = s.compound && s.hodl && s.deposit;
      assert.equal(plan.needed, s.fullRescan || !settled, JSON.stringify(s));
      assert.equal(plan.fullRescan, s.fullRescan);
      assert.equal(plan.hasCompoundData, s.compound);
      assert.equal(plan.hasDepositData, s.deposit);
      assert.equal(!!plan.cachedHodl, s.hodl);
    }
  });

  it("agrees with the scan: no read when it says none is needed", async () => {
    for (const s of everyState()) {
      state.scanCount = 0;
      const botState = arrange(s);
      const { needed } = lifetime.lifetimeScanPlan(botState, "epoch-key");
      await lifetime._scanLifetimePoolData(
        position(),
        botState,
        () => {},
        [],
        "0xW",
        null,
        "epoch-key",
      );
      assert.equal(state.scanCount, needed ? 1 : 0, JSON.stringify(s));
    }
  });

  it("starts every read it calls for at the pool floor", async () => {
    /*-
     *  What epoch reconstruction relies on when it takes its histories
     *  from the lifetime read: every NFT covered from its mint. A read
     *  starting later would hand it the tail of each history. A closed
     *  NFT's fees and exit value would then come out wrong, with nothing
     *  to show for it. If a change ever lets a needed read start later,
     *  `_scanAndReconstruct` must stop sharing that read.
     */
    for (const s of everyState()) {
      state.scanFromBlock = null;
      const botState = arrange(s);
      if (!lifetime.lifetimeScanPlan(botState, "epoch-key").needed) continue;
      await lifetime._scanLifetimePoolData(
        position(),
        botState,
        () => {},
        [],
        "0xW",
        null,
        "epoch-key",
      );
      assert.equal(state.scanFromBlock, POOL_FLOOR, JSON.stringify(s));
    }
  });
});

describe("prepareLifetimeRead", () => {
  it("decides the start and the buffer when it runs", async () => {
    /*-
     *  A full rescan flagged after preparation still discards the resume
     *  buffer, because the read applies the scan's rules at read time.
     */
    const botState = arrange({ fullRescan: false });
    const stale = new Map([["100", { from: 0, ev: {} }]]);
    botState._lifetimeResumeBuffer = stale;
    const prepared = lifetime.prepareLifetimeRead(
      position(),
      botState,
      [],
      "epoch-key",
    );
    botState._needsFullRescan = true;
    await prepared.read();
    assert.notStrictEqual(state.scanOpts.resumeBuffer, stale);
    assert.equal(state.scanOpts.resumeBuffer.size, 0);
    assert.equal(state.scanFromBlock, POOL_FLOOR);
  });

  it("reads from the pool floor even when every figure is saved after it was prepared", async () => {
    /*-
     *  Its consumers settled on computing from scratch when the read was
     *  prepared, so it covers each history from its mint whatever is
     *  saved by the time it runs.
     */
    const botState = arrange({ hodl: true, deposit: true });
    const prepared = lifetime.prepareLifetimeRead(
      position(),
      botState,
      [],
      "epoch-key",
    );
    botState._getConfig = (k) => SAVED[k];
    await prepared.read();
    assert.equal(state.scanFromBlock, POOL_FLOOR);
  });
});

describe("_scanLifetimePoolData with the pass's prepared read", () => {
  const run = (botState, pos, prepared) =>
    lifetime._scanLifetimePoolData(
      pos,
      botState,
      () => {},
      [],
      "0xW",
      null,
      "epoch-key",
      prepared,
    );

  it("uses a read epoch reconstruction already made", async () => {
    const botState = arrange({});
    const prepared = lifetime.prepareLifetimeRead(
      position(),
      botState,
      [],
      "epoch-key",
    );
    await prepared.read();
    await run(botState, position(), prepared);
    assert.equal(state.scanCount, 1, "the chain was read twice");
    assert.equal(state.classifyCalled, true, "the scan still computed");
  });

  it("makes the prepared read itself when nothing else has", async () => {
    const botState = arrange({});
    const prepared = lifetime.prepareLifetimeRead(
      position(),
      botState,
      [],
      "epoch-key",
    );
    await run(botState, position(), prepared);
    assert.equal(state.scanCount, 1);
    await prepared.read();
    assert.equal(state.scanCount, 1, "and the pass shares it afterwards");
  });

  it("reads afresh when the live NFT moved during the pass", async () => {
    /*-
     *  A manual rebalance mid-pass: the prepared read describes the
     *  chain before it.
     */
    const botState = arrange({});
    const prepared = lifetime.prepareLifetimeRead(
      position(),
      botState,
      [],
      "epoch-key",
    );
    await prepared.read();
    const moved = { ...position(), tokenId: "301" };
    botState._needsFullRescan = true;
    await run(botState, moved, prepared);
    assert.equal(state.scanCount, 2);
    assert.equal(state.scanOpts.liveTokenId, "301");
  });

  it("does not read at all when nothing is needed, prepared read or not", async () => {
    const botState = arrange({ compound: true, hodl: true, deposit: true });
    const prepared = lifetime.prepareLifetimeRead(
      position(),
      botState,
      [],
      "epoch-key",
    );
    await run(botState, position(), prepared);
    assert.equal(state.scanCount, 0);
  });
});
