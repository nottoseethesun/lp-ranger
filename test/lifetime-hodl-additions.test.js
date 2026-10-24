"use strict";

/**
 * @file test/lifetime-hodl-additions.test.js
 * @description How the Lifetime scan's tally judges an addition of
 *   liquidity to an NFT after its mint (`computeLifetimeHodl`,
 *   src/lib/lifetime-hodl.js): by who paid for it, from its receipt.
 *
 *   An addition the wallet paid for took coins already counted: a deposit
 *   counted when it reached the wallet, or the position's own coins, a
 *   rebalance's leftovers or fees. Counting it again counted those coins
 *   twice. The rule this replaces judged an addition by the NFT's fees,
 *   so a compound whose swap took in the wallet's coins, beyond the fees,
 *   was counted as money put in; LP Ranger's mark on its own compounds
 *   did not save them, since Reload Current Position on Production
 *   empties the compound list and the rebuilt entries carry no mark.
 *
 *   An addition another wallet paid for brought coins nothing had
 *   counted, so all of it is money put in, as an entry of its own at its
 *   own block: filed under the NFT's mint, it was dropped whenever the
 *   saved list already held an entry there.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeLifetimeHodl } = require("../src/lib/lifetime-hodl");
const {
  ilEvent,
  colEvent,
  dlEvent,
  mockProvider,
  mockEthers,
  additionReceipt,
} = require("./helpers/lifetime-hodl-fixtures");

const T0 = "0xToken0";
const T1 = "0xToken1";
const WALLET = "0xWallet";
const OTHER = "0xOtherWallet";

/** A position of two 8-decimal coins. */
const POSITION = {
  tokenId: "100",
  decimals0: 8,
  decimals1: 8,
  token0: T0,
  token1: T1,
};

/** The mint's deposit entry, as the tally records it. */
const MINT_ENTRY = {
  raw0: "100000000000",
  raw1: "200000000000",
  block: 10,
  kind: "fresh",
};

/** The addition's entry, as the tally records one another wallet paid for. */
const ADDITION_ENTRY = {
  raw0: "11000000000",
  raw1: "11000000000",
  block: 500,
  kind: "external",
  txHash: "0x1f4",
};

/**
 * NFT #100: minted with 1,000 + 2,000 at block 10, its fees of 10 + 10
 * collected at block 400, and 110 + 110 added at block 500 (transaction
 * `0x1f4`), far more than the fees.
 *
 * @param {object[]} [extra]  Later additions.
 * @returns {Map<string, object>}
 */
function sweptNft(extra = []) {
  const events = new Map();
  events.set("100", {
    ilEvents: [
      ilEvent(1000_00000000, 2000_00000000, 10),
      ilEvent(110_00000000, 110_00000000, 500),
      ...extra,
    ],
    collectEvents: [colEvent(10_00000000, 10_00000000, 400)],
    dlEvents: [],
  });
  return events;
}

/** The receipt of an addition `payer` paid for, both coins. */
function paidBy(payer) {
  return additionReceipt([
    { token: T0, from: payer },
    { token: T1, from: payer },
  ]);
}

/**
 * The tally over `events`, reading through a provider that serves
 * `receipts`.
 *
 * @param {Map<string, object>} events
 * @param {object} [o]
 * @param {object} [o.receipts]  Receipts by transaction.
 * @param {object[]} [o.compoundHistory]  The position's compound list.
 * @param {object} [o.cachedFreshDeposits]  The saved results.
 * @returns {Promise<{result: object, provider: object}>}
 */
async function tally(events, o = {}) {
  const provider = mockProvider({ receipts: o.receipts });
  const result = await computeLifetimeHodl(events, {
    rebalanceEvents: [],
    position: POSITION,
    provider,
    ethersLib: mockEthers(),
    walletAddress: WALLET,
    compoundHistory: o.compoundHistory,
    cachedFreshDeposits: o.cachedFreshDeposits,
  });
  return { result, provider };
}

describe("the Lifetime tally — an addition the wallet paid for", () => {
  it("counts it as no money put in, however far it passes the NFT's fees", async () => {
    const { result } = await tally(sweptNft(), {
      receipts: { "0x1f4": paidBy(WALLET) },
    });
    assert.strictEqual(result.amount0, 1000);
    assert.strictEqual(result.amount1, 2000);
    assert.deepStrictEqual(result.deposits, [MINT_ENTRY]);
  });

  it("counts it as no money put in when the wallet paid either coin", async () => {
    const { result } = await tally(sweptNft(), {
      receipts: {
        "0x1f4": additionReceipt([
          { token: T0, from: WALLET },
          { token: T1, from: OTHER },
        ]),
      },
    });
    assert.strictEqual(result.amount0, 1000);
  });

  it("reads no receipt for a compound LP Ranger recorded as it made it", async () => {
    /*- LP Ranger compounds from the wallet, so the answer is known; no
     *  receipt is served, so a read would stop the scan. */
    const { result, provider } = await tally(sweptNft(), {
      compoundHistory: [{ txHash: "0x1F4", trigger: "auto" }],
    });
    assert.strictEqual(result.amount0, 1000);
    assert.deepStrictEqual(provider.receiptsAsked, []);
  });

  it("judges a compound the list holds without LP Ranger's mark by its receipt", async () => {
    /*- The case the user raised: a compound list rebuilt after Reload
     *  Current Position on Production holds no mark, so only the chain
     *  can say the wallet paid. */
    const { result, provider } = await tally(sweptNft(), {
      compoundHistory: [{ txHash: "0x1f4", trigger: "historical" }],
      receipts: { "0x1f4": paidBy(WALLET) },
    });
    assert.strictEqual(result.amount0, 1000);
    assert.deepStrictEqual(provider.receiptsAsked, ["0x1f4"]);
  });

  it("leaves an addition soon after a drain to the rebalance, unread", async () => {
    const events = new Map();
    events.set("100", {
      ilEvents: [
        ilEvent(1000_00000000, 2000_00000000, 10),
        ilEvent(900_00000000, 1900_00000000, 1005),
      ],
      collectEvents: [colEvent(1000_00000000, 2000_00000000, 1000)],
      dlEvents: [dlEvent(1000, 1000, 1000_00000000, 2000_00000000)],
    });
    const { result, provider } = await tally(events);
    assert.strictEqual(result.amount0, 1000);
    assert.deepStrictEqual(provider.receiptsAsked, []);
  });
});

describe("the Lifetime tally — an addition another wallet paid for", () => {
  it("counts all of it as money put in, as an entry of its own at its own block", async () => {
    const { result } = await tally(sweptNft(), {
      receipts: { "0x1f4": paidBy(OTHER) },
    });
    assert.strictEqual(result.amount0, 1110);
    assert.strictEqual(result.amount1, 2110);
    assert.deepStrictEqual(result.deposits, [MINT_ENTRY, ADDITION_ENTRY]);
  });

  it("counts it even when it fits within the NFT's fees", async () => {
    const events = sweptNft();
    events.get("100").ilEvents[1] = ilEvent(5_00000000, 5_00000000, 500);
    const { result } = await tally(events, {
      receipts: { "0x1f4": paidBy(OTHER) },
    });
    assert.strictEqual(result.amount0, 1005);
    assert.strictEqual(result.amount1, 2005);
  });

  it("enters it even when the saved list holds an entry at the NFT's mint", async () => {
    /*- Filed under the mint's block, it was dropped here: the block was
     *  already in the saved list, the mint's own deposit. */
    const { result } = await tally(sweptNft(), {
      receipts: { "0x1f4": paidBy(OTHER) },
      cachedFreshDeposits: {
        raw0: "0",
        raw1: "0",
        lastBlock: 10,
        deposits: [MINT_ENTRY],
      },
    });
    assert.deepStrictEqual(result.deposits, [MINT_ENTRY, ADDITION_ENTRY]);
    assert.strictEqual(result.amount0, 1110);
  });
});

describe("the Lifetime tally — additions it saved before", () => {
  it("works them out again from the receipts, keeping each one's price", async () => {
    const { result } = await tally(sweptNft(), {
      receipts: { "0x1f4": paidBy(OTHER) },
      cachedFreshDeposits: {
        raw0: "0",
        raw1: "0",
        lastBlock: 10,
        deposits: [
          MINT_ENTRY,
          { ...ADDITION_ENTRY, txHash: "0x1F4", usd: 12.5, fallback: false },
          /*- One the rule this replaced filed under the mint. */
          { raw0: "500", raw1: "500", block: 10, kind: "external" },
        ],
      },
    });
    assert.deepStrictEqual(result.deposits, [
      MINT_ENTRY,
      { ...ADDITION_ENTRY, usd: 12.5, fallback: false },
    ]);
  });

  it("drops one the wallet paid for after all", async () => {
    const { result } = await tally(sweptNft(), {
      receipts: { "0x1f4": paidBy(WALLET) },
      cachedFreshDeposits: {
        raw0: "0",
        raw1: "0",
        lastBlock: 10,
        deposits: [MINT_ENTRY, { ...ADDITION_ENTRY, usd: 12.5 }],
      },
    });
    assert.deepStrictEqual(result.deposits, [MINT_ENTRY]);
    assert.strictEqual(result.amount0, 1000);
  });
});

describe("the Lifetime tally — an addition it cannot judge", () => {
  it("stops the scan when the addition's receipt does not come back", async () => {
    await assert.rejects(tally(sweptNft()), /no receipt came back/);
  });

  it("stops the scan when the addition names no transaction", async () => {
    const events = sweptNft();
    delete events.get("100").ilEvents[1].txHash;
    await assert.rejects(tally(events), /names no transaction/);
  });

  it("stops the scan when it has no provider to read the receipt with", async () => {
    await assert.rejects(
      computeLifetimeHodl(sweptNft(), {
        rebalanceEvents: [],
        position: POSITION,
      }),
      /needs its receipt/,
    );
  });
});
