"use strict";

/**
 * @file test/bot-shared-signer.test.js
 * @description The shared signer the bot's interface hands out
 *   (`sharedSigner`, src/bot/bot-interface.js): the one every position
 *   signs through, which the position manager builds once from the key
 *   the bot holds. The headless bot asks for it as it starts, for its
 *   wallet and for its single-position mode (src/bot.js).
 */

const { it } = require("node:test");
const assert = require("node:assert/strict");
const ethers = require("ethers");
const config = require("../src/lib/config");
const { botOperations } = require("../src/bot/bot-interface");

const KEY = "0x" + "11".repeat(32);

it("is the position manager's, built from the key the bot holds", async () => {
  const asked = [];
  const signer = { address: "0x1111111111111111111111111111111111111111" };
  const bot = botOperations({
    diskConfig: { global: {}, positions: {} },
    walletManager: { getAddress: () => null },
    positionMgr: {
      getSharedSigner: async (opts) => {
        asked.push(opts);
        return signer;
      },
    },
  });
  bot.setPrivateKey(KEY);
  assert.equal(await bot.sharedSigner(), signer);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].privateKey, KEY);
  assert.equal(asked[0].ethersLib, ethers);
  assert.equal(asked[0].dryRun, config.DRY_RUN);
});
