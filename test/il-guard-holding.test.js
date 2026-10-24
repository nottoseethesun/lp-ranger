"use strict";

/**
 * @file test/il-guard-holding.test.js
 * @description What the Impermanent Loss Guard measures, from a poll's
 *   own figures: the position, without the fees this NFT compounded and
 *   without any coin in the wallet, against holding the coins the NFT was
 *   minted with, at today's prices. That is the
 *   Current panel's IL/G for the NFT, so each snapshot here is built by
 *   `_computeIL` (src/bot-pnl-il.js), the code that works out the
 *   panel's figure, and the Guard is then asked about it, as a poll does.
 *
 *   Holding is valued at today's prices, not at the minted coins' worth
 *   on the day of the mint. The mint-day figure counts a move both coins'
 *   dollar prices share, which a rebalance does not lock in: it would
 *   block a position whose coins had both fallen, though its impermanent
 *   loss was small, and let through a deep loss hidden inside a rise both
 *   coins shared.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { checkIlGuard } = require("../src/il-guard");
const { _computeIL } = require("../src/bot-pnl-il");

const TOKEN_ID = "164418";

/**
 * Ask the Guard, set to 15%, about a position minted with 500 of each
 * coin for $1,000, the way a poll does: IL/G first, then the gate.
 * @param {object} p
 * @param {number} p.lpUsd     The position's value now, compounds included.
 * @param {number} p.price0    Today's price of coin A.
 * @param {number} p.price1    Today's price of coin B.
 * @param {number} [p.residualUsd]  Coins on the wallet a rebalance would add.
 * @param {{amount0: number, amount1: number}} [p.compounded]  What this
 *   NFT has compounded.
 * @returns {{verdict: object|null, snap: object, published: object[]}}
 */
function guardAt({ lpUsd, price0, price1, residualUsd = 0, compounded }) {
  const published = [];
  const deps = {
    position: { tokenId: TOKEN_ID, liquidity: "1000" },
    _getConfig: (k) => (k === "impermanentLossGuardPct" ? 15 : undefined),
    _botState: {
      /*-
       *  The $1,000 the minted coins were worth at the mint rides along,
       *  as it does on a real position, to show it is not what the Guard
       *  measures against.
       */
      hodlBaseline: { hodlAmount0: 500, hodlAmount1: 500, entryValue: 1000 },
      nftCompoundedAmountsByTokenId:
        compounded === undefined ? {} : { [TOKEN_ID]: compounded },
    },
    updateBotState: (patch) => published.push(patch),
  };
  const snap = { currentValue: lpUsd, residualValueUsd: residualUsd };
  _computeIL(snap, deps, lpUsd, price0, price1, TOKEN_ID);
  const verdict = checkIlGuard(deps, false, snap, () => ({}));
  return { verdict, snap, published };
}

describe("the Impermanent Loss Guard measures against holding", () => {
  it("lets a rebalance through when both coins fell but the impermanent loss is small", () => {
    /*-
     *  A falls 40% and B 20%. Holding the minted coins is worth $700,
     *  the position $690: $10 of impermanent loss, about 1.4%. Measured
     *  against the $1,000 mint value it read as a 31% loss and was
     *  blocked.
     */
    const { verdict, snap } = guardAt({ lpUsd: 690, price0: 0.6, price1: 0.8 });
    assert.equal(snap.totalIL, -10, "the figure the Current panel shows");
    assert.equal(verdict, null);
  });

  it("blocks a deep impermanent loss hidden inside a rise both coins share", () => {
    /*-
     *  A triples and B rises 20%. Holding is worth $2,100, the position
     *  $1,700: $400 of impermanent loss, about 19%. Against the $1,000
     *  mint value it read as a 70% gain and went through.
     */
    const { verdict } = guardAt({ lpUsd: 1700, price0: 3, price1: 1.2 });
    assert.equal(verdict?.ilGuardRejected, true);
  });

  it("leaves the fees this NFT compounded out of the position", () => {
    /*-
     *  $1,000 of position, $200 of it compounded fees, against $1,000 of
     *  holding: 20% of impermanent loss. Counting the fees would hide it
     *  entirely.
     */
    const { verdict } = guardAt({
      lpUsd: 1000,
      price0: 1,
      price1: 1,
      compounded: { amount0: 100, amount1: 100 },
    });
    assert.equal(verdict?.ilGuardRejected, true);
  });

  it("counts no coin in the wallet, so the comparison stays even", () => {
    /*-
     *  The user's ruling (2026-10-23): the Guard compares the position as
     *  minted against the same position rebalanced, and "if you add in
     *  residual coins, it's not an even comparison". $820 is 18% below
     *  $1,000 of holding; $60 of leftovers or a deposit waiting in the
     *  wallet would have made it 12%, and let the rebalance through.
     */
    for (const residualUsd of [0, 60]) {
      const { verdict } = guardAt({
        lpUsd: 820,
        price0: 1,
        price1: 1,
        residualUsd,
      });
      assert.equal(verdict?.ilGuardRejected, true, `$${residualUsd} in wallet`);
    }
  });

  it("reports the figures it measured, today's holding value included", () => {
    const { published } = guardAt({ lpUsd: 1700, price0: 3, price1: 1.2 });
    const message = published.at(-1)?.ilGuardBlocked?.message ?? "";
    assert.ok(message.includes("$usd 1700.00"), message);
    assert.ok(message.includes("$usd 2100.00"), message);
    assert.ok(message.includes("19.0%"), message);
    assert.ok(!message.includes("$usd 1000.00"), "not the mint value");
  });
});
