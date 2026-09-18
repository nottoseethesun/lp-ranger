/**
 * @file test/lifetime-compounded-establishment.test.js
 * @description The lifetime compounded total may be established only by
 *   the chain-wide classification — never by one compound.
 *
 *   `compoundedAmount0` / `compoundedAmount1` mean the WHOLE rebalance
 *   chain's re-deposited fees. Their absence is a statement, not a gap:
 *   it is how `clear-blockchain-scan-cache` and Reload Current Position
 *   say "this has not been classified", and it is what the lifetime
 *   scan's guard reads to decide whether to classify.
 *
 *   The incremental writers — a standalone compound, and the fee credit
 *   on a rebalance — may therefore add to a total that exists but must
 *   not create one. A writer that creates one hands the guard a real
 *   number as proof the work is done, and the classification is skipped
 *   for as long as the position runs.
 *
 *   These tests join the real writers to the real guard through a config
 *   slot, because the fault lives in the interaction, not in either one.
 */

"use strict";

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const { _bumpRebalanceFees } = require("../src/bot-recorder");
const { hasCompoundedTotal } = require("../src/bot-config-keys");

/*- A config slot, read and written the way the app does: `_getConfig`
 *  reads it, and the bot-state patch is applied back onto it. Applying
 *  the patch is the point — a stub that only records calls would pass
 *  while the slot ended up holding anything at all. */
function slotDeps(slot, position) {
  return {
    position,
    _getConfig: (k) => slot[k],
    updateBotState: (patch) => Object.assign(slot, patch),
    _botState: slot,
  };
}

/** What the lifetime scan's guard concludes about a slot. */
function guardSees(resolveDiskState, slot) {
  return resolveDiskState({ _getConfig: (k) => slot[k] }, null);
}

const COMPOUND = Object.freeze({
  timestamp: "2026-09-18T08:00:13Z",
  depositTxHash: "0x911e0d",
  amount0Deposited: "290864649883746805435546",
  amount1Deposited: "213034092521843074152863",
  /*- The coins this one compound re-deposited. Deliberately unequal, so
   *  a writer that crossed the two tokens could not still land right. */
  depositedAmount0: 290864.649884,
  depositedAmount1: 213034.092522,
  usdValue: 5.05,
  gasCostWei: "0",
  trigger: "auto",
});

/*- What the stubbed epoch cache hands back, so a test can present a
 *  position whose every other lifetime figure is already saved. */
let _cachedHodl = null;

/*- What the stubbed classifier reports for each NFT. */
const _NO_COMPOUNDS = Object.freeze({
  compounds: [],
  totalCompoundedUsd: 0,
  feeAmount0: 0,
  feeAmount1: 0,
  totalGasWei: "0",
  totalNftGasWei: "0",
});
let _classifyStub = async () => _NO_COMPOUNDS;

describe("the lifetime compounded total is established by the chain scan", () => {
  let recordCompound;
  let _resolveDiskState;
  let lifetimeScanPlan;
  let _recordScanSuccess;
  let _classifyAllCompounds;
  const _origRequire = Module.prototype.require;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./bot-pnl-updater") {
        return {
          actualGasCostUsd: async () => 0,
          estimateGasCostUsd: async () => 0,
          positionValueUsd: () => 0,
          fetchTokenPrices: async () => ({ price0: 1, price1: 1 }),
        };
      }
      /*- Kept off the real module so loading it does not pull in
       *  ethers.Interface; nothing here calls either function. */
      if (id === "./compounder") {
        return {
          classifyCompounds: async (...a) => _classifyStub(...a),
          executeCompound: async () => ({}),
          detectCompoundsOnChain: async () => ({}),
        };
      }
      if (id === "./epoch-cache") {
        return { getCachedLifetimeHodl: () => _cachedHodl };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/bot-cycle-compound")];
    delete require.cache[require.resolve("../src/bot-recorder-lifetime")];
    ({ recordCompound } = require("../src/bot-cycle-compound"));
    ({
      _resolveDiskState,
      lifetimeScanPlan,
      _recordScanSuccess,
      _classifyAllCompounds,
    } = require("../src/bot-recorder-lifetime"));
  });

  /*- Both stubs are module-level, so a test that sets one and then fails
   *  an assertion would hand it to the next. Reset unconditionally. */
  afterEach(() => {
    _cachedHodl = null;
    _classifyStub = async () => _NO_COMPOUNDS;
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/bot-cycle-compound")];
    delete require.cache[require.resolve("../src/bot-recorder-lifetime")];
  });

  it("a compound after a cache clear leaves the classification still owed", async () => {
    /*-
     *  NFT #163164, 2026-09-18, exactly as it happened.
     *
     *  06:44  `clear-blockchain-scan-cache` removes the chain-derived
     *         keys, so the slot carries no compounded coins.
     *  08:00  auto-compound fires and records $5.05 of re-deposited fees.
     *  08:44  the lifetime scan reaches the guard.
     *
     *  On the day, step 2 wrote its own coins into the slot, so step 3
     *  read a number, concluded the chain was already classified, and
     *  skipped the other ~39 NFTs. Lifetime Fees Compounded then read
     *  $5.12 while the CURRENT NFT alone showed $35.81 — a total
     *  smaller than a part of itself.
     */
    const slot = { compoundHistory: [] };
    assert.equal(
      guardSees(_resolveDiskState, slot).hasCompoundData,
      false,
      "precondition: a freshly cleared slot owes a classification",
    );

    await recordCompound(slotDeps(slot, { tokenId: 163164 }), COMPOUND);

    assert.equal(
      guardSees(_resolveDiskState, slot).hasCompoundData,
      false,
      "a compound must not pass its own coins off as the whole chain's",
    );
    assert.equal(slot.compoundedAmount0, undefined);
    assert.equal(slot.compoundedAmount1, undefined);
  });

  it("records the compound's own history and per-NFT caches regardless", async () => {
    /*- Declining to establish the chain total must not cost the compound
     *  everything else it records; only the chain-wide figure waits. */
    const slot = { compoundHistory: [] };
    await recordCompound(slotDeps(slot, { tokenId: 163164 }), COMPOUND);
    assert.equal(slot.compoundHistory.length, 1);
    assert.equal(slot.compoundHistory[0].txHash, "0x911e0d");
    assert.equal(slot.lastCompoundAt, COMPOUND.timestamp);
  });

  it("still adds to the total once the chain scan has established it", async () => {
    /*- The positive control. Without it, a writer that simply never
     *  wrote the total would satisfy every other test here. */
    const slot = {
      compoundHistory: [],
      compoundedAmount0: 100,
      compoundedAmount1: 200,
    };
    assert.equal(guardSees(_resolveDiskState, slot).hasCompoundData, true);

    await recordCompound(slotDeps(slot, { tokenId: 163164 }), COMPOUND);

    assert.equal(slot.compoundedAmount0, 100 + COMPOUND.depositedAmount0);
    assert.equal(slot.compoundedAmount1, 200 + COMPOUND.depositedAmount1);
    assert.equal(
      guardSees(_resolveDiskState, slot).hasCompoundData,
      true,
      "an established total stays established",
    );
  });

  it("a rebalance's fee credit after a cache clear leaves it owed too", async () => {
    /*- The second incremental writer, and the one the memory note warns
     *  about by name: a rebalance's fee credit landing in the gap. Same
     *  rule, same reason. */
    const slot = {};
    const deps = slotDeps(slot, { tokenId: 163164 });
    deps._lastUnclaimedFee0 = 11.5;
    deps._lastUnclaimedFee1 = 7.25;

    _bumpRebalanceFees(deps);

    assert.equal(slot.compoundedAmount0, undefined);
    assert.equal(slot.compoundedAmount1, undefined);
    assert.equal(
      guardSees(_resolveDiskState, slot).hasCompoundData,
      false,
      "swept fees must not stand in for the chain's total",
    );
    /*- The pending amounts still clear: those fees HAVE been swept into
     *  the position and are no longer unclaimed, whoever totals them. */
    assert.equal(deps._lastUnclaimedFee0, 0);
    assert.equal(deps._lastUnclaimedFee1, 0);
  });

  it("a rebalance's fee credit still adds to an established total", async () => {
    const slot = { compoundedAmount0: 100, compoundedAmount1: 200 };
    const deps = slotDeps(slot, { tokenId: 163164 });
    deps._lastUnclaimedFee0 = 11.5;
    deps._lastUnclaimedFee1 = 7.25;

    _bumpRebalanceFees(deps);

    assert.equal(slot.compoundedAmount0, 111.5);
    assert.equal(slot.compoundedAmount1, 207.25);
  });

  // ── coins that went unrecorded must still get counted ──────────────
  /*-
   *  Declining to write is only safe if the coins are picked up later.
   *  Both writers therefore ask for a classification when they decline,
   *  and the request has to outlive a scan that was already running —
   *  that scan read the chain before the coins existed.
   */

  it("a declining compound asks for a classification", async () => {
    const slot = { compoundHistory: [] };
    await recordCompound(slotDeps(slot, { tokenId: 163164 }), COMPOUND);
    assert.equal(slot._needsCompoundReclassify, true);
  });

  it("a declining rebalance fee credit asks for one too", () => {
    const slot = {};
    const deps = slotDeps(slot, { tokenId: 163164 });
    deps._lastUnclaimedFee0 = 1;
    deps._lastUnclaimedFee1 = 2;
    _bumpRebalanceFees(deps);
    assert.equal(slot._needsCompoundReclassify, true);
  });

  it("a compound that adds normally asks for nothing", async () => {
    const slot = {
      compoundHistory: [],
      compoundedAmount0: 100,
      compoundedAmount1: 200,
    };
    await recordCompound(slotDeps(slot, { tokenId: 163164 }), COMPOUND);
    assert.equal(slot._needsCompoundReclassify, undefined);
  });

  it("the request forces a scan even when every figure is saved", () => {
    /*- Without it, a position whose figures all look settled schedules
     *  no scan at all, and the unrecorded coins wait for a rebalance. */
    _cachedHodl = { amount0: 1, amount1: 2 };
    const saved = {
      compoundedAmount0: 10,
      compoundedAmount1: 20,
      totalLifetimeDepositUsd: 500,
    };
    const settled = { _getConfig: (k) => saved[k] };
    assert.equal(
      lifetimeScanPlan(settled, "epoch-key").needed,
      false,
      "precondition: nothing owed",
    );
    settled._needsCompoundReclassify = true;
    const plan = lifetimeScanPlan(settled, "epoch-key");
    assert.equal(plan.reclassify, true);
    assert.equal(plan.needed, true);
  });

  it("a chain that compounded nothing is recorded as zero, and then adds", async () => {
    /*-
     *  End to end for the zero case, which is the one a "greater than
     *  nothing" guard gets wrong. The classification reads a chain with
     *  no re-deposits, records zero, and that zero is an answer: the next
     *  compound adds to it instead of declining, so its coins show
     *  immediately rather than waiting for another scan.
     */
    const slot = { compoundHistory: [] };
    _classifyStub = async () => ({
      compounds: [],
      totalCompoundedUsd: 0,
      feeAmount0: 0,
      feeAmount1: 0,
      totalGasWei: "0",
      totalNftGasWei: "0",
    });
    await _classifyAllCompounds(
      new Set(["163164"]),
      new Map([["163164", {}]]),
      { decimals0: 18, decimals1: 18, token0Symbol: "A", token1Symbol: "B" },
      (patch) => Object.assign(slot, patch),
      null,
    );
    assert.equal(slot.compoundedAmount0, 0, "the zero result is recorded");
    assert.equal(slot.compoundedAmount1, 0);
    assert.equal(
      guardSees(_resolveDiskState, slot).hasCompoundData,
      true,
      "a recorded zero is an answer, not a gap",
    );

    await recordCompound(slotDeps(slot, { tokenId: 163164 }), COMPOUND);
    assert.equal(slot.compoundedAmount0, COMPOUND.depositedAmount0);
    assert.equal(slot.compoundedAmount1, COMPOUND.depositedAmount1);
    assert.equal(slot._needsCompoundReclassify, undefined, "nothing deferred");
  });

  it("a scan whose chain read went stale saves no total at all", async () => {
    /*-
     *  Coins that arrived after the read are not in the figure this pass
     *  computed. Saving it would settle a total short by those coins, and
     *  a saved total is what stops later scans re-classifying — so short
     *  would become final.
     *
     *  Leaving it absent needs nothing remembered: absence is itself the
     *  "unclassified" signal, and it is on disk, so the next scan does
     *  the walk however the process was stopped in between. That is what
     *  makes the recovery automatic rather than a Reload the operator has
     *  to think to run.
     */
    const slot = { compoundHistory: [] };
    _classifyStub = async () => ({
      compounds: [],
      totalCompoundedUsd: 90,
      feeAmount0: 90,
      feeAmount1: 45,
      totalGasWei: "0",
      totalNftGasWei: "7",
    });
    await _classifyAllCompounds(
      new Set(["163164"]),
      new Map([["163164", {}]]),
      { decimals0: 18, decimals1: 18, token0Symbol: "A", token1Symbol: "B" },
      (patch) => Object.assign(slot, patch),
      null,
      () => true, // a compound landed after the chain read
    );
    assert.equal(slot.compoundedAmount0, undefined, "no short total saved");
    assert.equal(slot.compoundedAmount1, undefined);
    assert.equal(
      guardSees(_resolveDiskState, slot).hasCompoundData,
      false,
      "absence keeps the classification owed, with nothing held in memory",
    );
    /*- The per-NFT gas still lands: it is keyed per NFT and drives a
     *  different row, so withholding it would cost a figure for nothing. */
    assert.deepEqual(slot.nftGasWeiByTokenId, { 163164: "7" });
  });

  it("saves the total normally when the read did not go stale", async () => {
    /*- The control: suppression must be the exception, not the rule. */
    const slot = { compoundHistory: [] };
    _classifyStub = async () => ({
      compounds: [],
      totalCompoundedUsd: 90,
      feeAmount0: 90,
      feeAmount1: 45,
      totalGasWei: "0",
      totalNftGasWei: "7",
    });
    await _classifyAllCompounds(
      new Set(["163164"]),
      new Map([["163164", {}]]),
      { decimals0: 18, decimals1: 18, token0Symbol: "A", token1Symbol: "B" },
      (patch) => Object.assign(slot, patch),
      null,
      () => false,
    );
    assert.equal(slot.compoundedAmount0, 90);
    assert.equal(slot.compoundedAmount1, 45);
  });

  it("a request raised mid-scan is not cleared by that scan", () => {
    /*- The whole point. A scan that did not carry the request in read a
     *  chain without those coins, so clearing it would settle a total
     *  that omits them for good. */
    const botState = { totalLifetimeDepositUsd: 500 };
    const patches = [];
    const update = (p) => patches.push(p);

    botState._needsCompoundReclassify = true;
    _recordScanSuccess(botState, update, { t0Sym: "A", t1Sym: "B" }, {});
    assert.equal(
      botState._needsCompoundReclassify,
      true,
      "a scan that did not carry the request must leave it standing",
    );

    _recordScanSuccess(
      botState,
      update,
      { t0Sym: "A", t1Sym: "B" },
      { reclassify: true },
    );
    assert.equal(
      botState._needsCompoundReclassify,
      false,
      "a scan that carried it in answers it",
    );
  });
});

describe("hasCompoundedTotal", () => {
  it("reads absence, not magnitude", () => {
    /*- Only a missing figure means "not asked yet". */
    for (const [a0, a1] of [
      [undefined, undefined],
      [null, null],
      [undefined, null],
    ])
      assert.equal(hasCompoundedTotal(a0, a1), false, JSON.stringify([a0, a1]));
  });

  it("counts a recorded zero as an answer", () => {
    /*- A chain whose NFTs never compounded totals zero, and that IS the
     *  classification's result. Re-deriving it would walk the whole chain
     *  again to arrive back at zero on every scan — and, since the
     *  writers add only to a total that exists, the position would go on
     *  declining its own compounds until something else classified it. */
    assert.equal(hasCompoundedTotal(0, 0), true);
    assert.equal(hasCompoundedTotal(0, undefined), true);
    assert.equal(hasCompoundedTotal(undefined, 0), true);
  });

  it("is true when either side carries coins", () => {
    /*- Either side alone is enough: a pool whose fees accrued entirely
     *  in one token has a real total with a zero on the other side. */
    assert.equal(hasCompoundedTotal(5, 0), true);
    assert.equal(hasCompoundedTotal(0, 5), true);
    assert.equal(hasCompoundedTotal(5, 7), true);
  });

  it("does not count a negative or a NaN as a total", () => {
    /*- Neither is a figure a classification produced — coins
     *  re-deposited cannot be fewer than none. Reading either as "already
     *  done" would freeze it instead of re-deriving it. */
    assert.equal(hasCompoundedTotal(-5, undefined), false);
    assert.equal(hasCompoundedTotal(NaN, undefined), false);
    assert.equal(hasCompoundedTotal(-5, -1), false);
  });
});
