"use strict";

/**
 * @file test/bot-recorder-lifetime-compound-list.test.js
 * @description The compound list a rebuild writes (`_classifyAllCompounds`,
 *   src/lib/bot-recorder-lifetime.js): every compound the chain shows, with its
 *   Activity Log figures, keeping the trigger and figures of each compound
 *   the bot recorded when it happened.
 *
 *   Reload Current Position leaves the saved list in place for the
 *   rebuild, so the rebuild's list replaces it whether or not the chain
 *   shows compounded coins. The classifier is the shared
 *   harness's stand-in; the figures are worked out by the real code
 *   (src/lib/compound-activity-figures.js).
 *
 *   The fixture NFT #1 was minted with liquidity 900, its fees collected
 *   (10 of token0, 20 of token1), and those fees compounded (8 and 16,
 *   liquidity 100). At $2 and $1 that is $40 of fees against a position
 *   worth $320 after the deposit: 12.5%.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  state,
  resetState,
  installMocks,
  restoreMocks,
} = require("./helpers/bot-recorder-lifetime-mocks");

const TX = "0x" + "c1".repeat(32);
const WHEN = "2026-10-04T12:00:00.000Z";
const READ_AT = Date.parse("2026-10-05T00:00:00.000Z");

/** NFT #1's events, as the chain read decodes them. */
function nftEvents() {
  const ev = (blockNumber, txHash, amount0, amount1, liquidity) => ({
    blockNumber,
    txHash,
    amount0,
    amount1,
    liquidity,
  });
  return new Map([
    [
      "1",
      {
        ilEvents: [
          ev(100, "0xmint", 1000n, 1000n, 900n),
          ev(5005, TX, 8n, 16n, 100n),
        ],
        collectEvents: [ev(5000, "0xcollect", 10n, 20n)],
        dlEvents: [],
      },
    ],
  ]);
}

/** The compound as the classifier reports it. */
const COMPOUND = Object.freeze({
  txHash: TX,
  timestamp: WHEN,
  amount0Deposited: "8",
  amount1Deposited: "16",
  usdValue: 32,
});

/** What the classifier finds on the NFT: these compounds and their coins. */
function found(compounds) {
  return {
    compounds,
    totalCompoundedUsd: compounds.length * 32,
    feeAmount0: compounds.length * 8,
    feeAmount1: compounds.length * 16,
    totalGasWei: "0",
    totalNftGasWei: "0",
  };
}

describe("_classifyAllCompounds — the compound list it writes", () => {
  let _classifyAllCompounds;

  beforeEach(() => {
    resetState();
    installMocks();
    ({ _classifyAllCompounds } = require("../src/lib/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /** Rebuild over a saved list; the list the rebuild writes. */
  async function rebuild(saved) {
    return (await rebuildPatch(saved)).compoundHistory;
  }

  /** Rebuild over a saved list; the patch that writes the list. */
  async function rebuildPatch(saved) {
    const patches = [];
    await _classifyAllCompounds(
      new Set(["1"]),
      nftEvents(),
      {
        decimals0: 0,
        decimals1: 0,
        price0: 2,
        price1: 1,
        token0Symbol: "A",
        token1Symbol: "B",
        savedCompoundHistory: () => saved,
        readStartedAt: READ_AT,
        compoundPrices: async () => ({ price0: 2, price1: 1 }),
      },
      (p) => patches.push(p),
      null,
    );
    return patches.find((p) => p.compoundHistory !== undefined);
  }

  it("writes a compound found only on the chain with its figures", async () => {
    state.compoundResult = found([COMPOUND]);
    const [entry] = await rebuild([]);
    // The chain does not say what started it.
    assert.equal(entry.trigger, "unknown");
    assert.equal(entry.tokenId, "1");
    assert.deepEqual(entry.feesCollected, { amount0: 10, amount1: 20 });
    assert.ok(
      Math.abs(entry.historical.percentGainForPosition - 12.5) < 1e-9,
      JSON.stringify(entry.historical),
    );
  });

  it("keeps the trigger and figures of a compound the bot recorded", async () => {
    state.compoundResult = found([COMPOUND]);
    const saved = [
      {
        ...COMPOUND,
        txHash: TX.toUpperCase(),
        trigger: "manual",
        feesCollected: { amount0: 1, amount1: 2 },
        historical: { percentGainForPosition: 3 },
      },
    ];
    const [entry] = await rebuild(saved);
    assert.equal(entry.trigger, "manual");
    assert.deepEqual(entry.feesCollected, { amount0: 1, amount1: 2 });
    assert.deepEqual(entry.historical, { percentGainForPosition: 3 });
  });

  it("counts the fees the bot recorded for the NFT's coins, not the whole deposit", async () => {
    /*-
     *  The NFT's Fees Compounded, which the Current panel shows and the
     *  Current IL/G and the Guard take off the position's side. The chain
     *  shows the deposit, 8 + 16; the bot's record of the compound names
     *  2 + 4 of it as fees, the rest coins the wallet already held.
     */
    state.compoundResult = found([COMPOUND]);
    const saved = [
      {
        ...COMPOUND,
        trigger: "auto",
        amount0Compounded: "2",
        amount1Compounded: "4",
      },
    ];
    const patch = await rebuildPatch(saved);
    assert.deepEqual(patch.nftCompoundedAmountsByTokenId, {
      1: { amount0: 2, amount1: 4 },
    });
    assert.equal(patch.compoundHistory[0].amount0Compounded, "2");
  });

  it("replaces the saved list when the chain shows no compounded coins", async () => {
    /*-
     *  The saved entry the chain does not show is dropped. The compound the
     *  bot recorded after the chain read began, which the read could not
     *  have seen, stays.
     */
    state.compoundResult = found([]);
    const stale = { ...COMPOUND, trigger: "unknown" };
    const late = {
      ...COMPOUND,
      txHash: "0x" + "ee".repeat(32),
      timestamp: "2026-10-05T00:00:01.000Z",
      trigger: "auto",
    };
    assert.deepEqual(await rebuild([stale, late]), [late]);
  });
});
