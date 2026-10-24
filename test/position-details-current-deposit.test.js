"use strict";

/**
 * @file test/position-details-current-deposit.test.js
 * @description An unmanaged position's Current panel counts its deposit
 *   and its Net P&L as the dashboard does for a managed one
 *   (`computeQuickDetails`, src/lib/position-details-quick.js): Initial
 *   Deposit for This LP is the minted coins with the wallet's coins its
 *   compounds took in beyond their fees, each at its compound's prices
 *   (src/lib/current-lp-deposit.js), from the compound list the bot saved
 *   while it managed the position, and Net P&L adds the fees those
 *   compounds left in the wallet.
 *
 *   The pool and its prices are stubbed, as in
 *   test/position-details-saved-override.test.js: token0 at $1, token1 at
 *   $2, the position worth 10 of each, so $30. Its saved compound took 3
 *   of token0 from the wallet beyond its fees, at the $2 recorded with it,
 *   and left 2.5 of token1 in the wallet.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const config = require("../src/lib/config");
const { compositeKey } = require("../src/lib/bot-config-v2");
const { setCachedLifetimeHodl } = require("../src/lib/epoch-cache");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const TOKEN_ID = "777";
const COIN = 10n ** 18n;

const _origRequire = Module.prototype.require;
let computeQuickDetails;
let key;

before(() => {
  /*-
   *  TEST-ONLY global swap: the module under test requires its chain and
   *  price reads by name and takes no stand-ins for them, so the
   *  stand-ins are served from here as it loads. Put back pristine in
   *  the `after` hook below.
   */
  Module.prototype.require = function (id) {
    if (id === "./rebalancer-pools")
      return {
        getPoolState: async () => ({
          tick: 0,
          price: 1,
          decimals0: 18,
          decimals1: 18,
        }),
      };
    if (id === "./bot-pnl-updater")
      return {
        fetchTokenPrices: async () => ({ price0: 1, price1: 2 }),
        positionValueUsd: (_pos, _ps, p0, p1) => 10 * p0 + 10 * p1,
        readUnclaimedFees: async () => ({ tokensOwed0: 0n, tokensOwed1: 0n }),
        addPoolShare: async () => {},
      };
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/lib/position-details-quick")];
  ({ computeQuickDetails } = require("../src/lib/position-details-quick"));
  key = compositeKey(config.CHAIN_NAME, WALLET, PM, TOKEN_ID);
});

after(() => {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/lib/position-details-quick")];
});

const request = () => ({
  tokenId: TOKEN_ID,
  token0: "0x000000000000000000000000000000000000000A",
  token1: "0x000000000000000000000000000000000000000B",
  fee: 3000,
  tickLower: -600,
  tickUpper: 600,
  liquidity: "1000000000000000000",
  walletAddress: WALLET,
  contractAddress: PM,
});

/** No balance in the wallet, so the residual reads come back empty. */
const ethersLib = {
  Contract: class {
    async balanceOf() {
      return 0n;
    }
  },
};

/** The saved baseline: the NFT was minted with $100 of coins. */
const BASELINE = {
  entryValue: 100,
  price0: 1,
  price1: 1,
  mintDate: "2026-01-01",
  hodlAmount0: 1,
  hodlAmount1: 1,
};

/** The compound the bot recorded while it managed the position. */
const COMPOUND = {
  tokenId: TOKEN_ID,
  txHash: "0xc1",
  timestamp: "2026-10-20T12:00:00Z",
  amount0Deposited: String(4n * COIN),
  amount1Deposited: "0",
  amount0Compounded: String(COIN),
  amount1Compounded: "0",
  amount0FeesLeft: "0",
  amount1FeesLeft: String((5n * COIN) / 2n),
  price0: 2,
  price1: 2,
  trigger: "auto",
};

const details = (saved) =>
  computeQuickDetails(
    null,
    ethersLib,
    request(),
    { positions: { [key]: saved } },
    null,
  );

describe("an unmanaged position's Current deposit and Net P&L", () => {
  it("count the wallet's coins its compounds took in, and the fees they left in the wallet", async () => {
    const d = await details({
      hodlBaseline: BASELINE,
      compoundHistory: [COMPOUND],
    });
    assert.equal(d.entryValue, 100 + 6, "$100 minted, 3 coins at $2");
    assert.equal(d.priceGainLoss, 30 - 106);
    assert.equal(d.netPnl, 30 - 106 + 5, "with 2.5 of token1 at $2 left");
  });

  it("take a figure the operator typed in whole, the fees left still added", async () => {
    const d = await details({
      hodlBaseline: BASELINE,
      compoundHistory: [COMPOUND],
      initialDepositUsd: 50,
    });
    assert.equal(d.entryValue, 50);
    assert.equal(d.netPnl, 30 - 50 + 5);
  });

  it("count liquidity another wallet added to the NFT, from the pool's deposit list the bot's scans saved", async () => {
    const req = request();
    const pool = {
      contract: PM,
      wallet: WALLET,
      token0: req.token0,
      token1: req.token1,
      fee: req.fee,
    };
    setCachedLifetimeHodl(pool, {
      lastBlock: 900,
      deposits: [
        { raw0: "1", raw1: "0", block: 10, kind: "fresh", usd: 100 },
        {
          raw0: "1",
          raw1: "1",
          block: 800,
          kind: "external",
          txHash: "0xe1",
          tokenId: TOKEN_ID,
          usd: 9,
        },
        {
          raw0: "1",
          raw1: "1",
          block: 700,
          kind: "external",
          txHash: "0xe0",
          tokenId: "776",
          usd: 50,
        },
      ],
    });
    try {
      const d = await details({
        hodlBaseline: BASELINE,
        compoundHistory: [COMPOUND],
      });
      assert.equal(d.entryValue, 100 + 6 + 9, "and $9 another wallet added");
      assert.equal(d.netPnl, 30 - 115 + 5);
    } finally {
      setCachedLifetimeHodl(pool, null);
    }
  });

  it("are the minted coins alone for a position the bot never managed", async () => {
    const d = await details({ hodlBaseline: BASELINE });
    assert.equal(d.entryValue, 100);
    assert.equal(d.netPnl, 30 - 100);
  });
});
