"use strict";

/**
 * @file test/wallet-clear.test.js
 * @description Clear Wallet (`DELETE /api/wallet`,
 *   src/server/wallet-clear.js). It removes the wallet and the key (the
 *   user's ruling, 2026-11-27): PRIVATE_KEY and WALLET_PASSWORD are set to
 *   unset in memory and their lines removed from `.env`, the session's
 *   wallet password is forgotten, and the bot halts every position and
 *   forgets its key. It waits for nothing and answers at once (the user's
 *   design, 2026-11-27: refuse, never wait). What it could not remove from
 *   `.env`, or what came from elsewhere, it logs and names in its answer,
 *   and the Clear still finishes.
 *
 *   It is refused, with a 409 saying why, while the server, having
 *   refused to start, waits to exit; while a wallet import or the
 *   start-up of the saved positions is
 *   under way (src/bot/app-phase.js); while a rebalance or compound is
 *   under way or a position is starting (src/bot/under-way.js); and while
 *   the server is using the wallet: an unlock, a Reveal Key or the
 *   launch's key step (src/server/wallet-in-use.js). The unlock's and the
 *   launch's windows are tested in test/server-unlock.test.js and
 *   test/server-launch-key-step.test.js, the import's in
 *   test/decrypts-before-start.test.js.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const appPhase = require("../src/bot/app-phase");
const config = require("../src/lib/config");
const { _setEnvBeforeFileForTests } = require("../src/lib/env-settings");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { createWalletInUse } = require("../src/server/wallet-in-use");
const { clearRequestOver } = require("./helpers/wallet-clear-request");

const KEY = "pulsechain-0xW-0xPM-157149";

// A position's bot state, as the stop's answer and the refusals name it.
const POSITION = {
  activePosition: {
    tokenId: "157149",
    token0Symbol: "WPLS",
    token1Symbol: "DAI",
  },
};

/**
 * A Clear route over a tracker of its own, recording, in order, what it
 * did: the wallet removed, the session password forgotten, the positions
 * halted. `states` and `startingKeys` are the bot's, for its refusal
 * while a move is under way or a position is starting.
 */
function clearRoute({
  envFile = () => null,
  startRefusal = () => null,
  states = () => new Map(),
  startingKeys = () => [],
} = {}) {
  const walletInUse = createWalletInUse();
  const done = [];
  const clearNow = clearRequestOver(walletInUse, () => done.push("wallet"), {
    forgetSessionPassword: () => done.push("password"),
    forgetWallet: () => done.push("positions"),
    envFile,
    startRefusal,
    states,
    startingKeys,
  });
  return { walletInUse, done, clearNow };
}

/**
 * Run `fn` with PRIVATE_KEY and WALLET_PASSWORD as given, in config and
 * in the environment, then put back what they were.
 *
 * TEST-ONLY global swap: the key in memory is `config.PRIVATE_KEY` and
 * the environment's two variables, all put back in the `finally`.
 */
async function withKeySettings({ key = null, password = null }, fn) {
  const saved = {
    key: config.PRIVATE_KEY,
    envKey: process.env.PRIVATE_KEY,
    envPassword: process.env.WALLET_PASSWORD,
  };
  try {
    config.PRIVATE_KEY = key;
    if (key === null) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = key;
    if (password === null) delete process.env.WALLET_PASSWORD;
    else process.env.WALLET_PASSWORD = password;
    await fn();
  } finally {
    config.PRIVATE_KEY = saved.key;
    for (const [name, value] of [
      ["PRIVATE_KEY", saved.envKey],
      ["WALLET_PASSWORD", saved.envPassword],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
}

/** A `.env` of this test's own holding `text`, in a folder of its own. */
function envFileWith(text) {
  const file = path.join(makeTestTempFolder("wallet-clear-env"), ".env");
  fs.writeFileSync(file, text);
  return file;
}

describe("Clear Wallet", () => {
  /*-
   *  Each case starts with neither key setting set and nothing set before
   *  `.env` was read, whatever the shell running the tests exports, so a
   *  local run and CI agree.
   *
   *  TEST-ONLY global swap: `config.PRIVATE_KEY`, the environment's two
   *  variables and the record of what the environment set before `.env`
   *  (src/lib/env-settings.js), all put back after each case.
   */
  let saved;
  beforeEach(() => {
    saved = {
      key: config.PRIVATE_KEY,
      envKey: process.env.PRIVATE_KEY,
      envPassword: process.env.WALLET_PASSWORD,
      beforeEnvFile: _setEnvBeforeFileForTests([]),
    };
    config.PRIVATE_KEY = null;
    delete process.env.PRIVATE_KEY;
    delete process.env.WALLET_PASSWORD;
  });
  afterEach(() => {
    appPhase._resetAppPhaseForTests();
    config.PRIVATE_KEY = saved.key;
    for (const [name, value] of [
      ["PRIVATE_KEY", saved.envKey],
      ["WALLET_PASSWORD", saved.envPassword],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    _setEnvBeforeFileForTests(
      saved.beforeEnvFile === null ? null : [...saved.beforeEnvFile],
    );
  });

  it("removes the wallet, forgets the password, halts every position, and answers at once", async () => {
    const c = clearRoute();
    const res = await c.clearNow();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, warnings: [] });
    assert.deepEqual(c.done, ["wallet", "password", "positions"]);
  });

  it("forgets PRIVATE_KEY and WALLET_PASSWORD, in memory and in .env", async () => {
    const envFile = envFileWith(
      "CHAIN_NAME=pulsechain\nPRIVATE_KEY=0xabc\nWALLET_PASSWORD=pw\nexport PRIVATE_KEY = 0xdef\nPORT=5555\n",
    );
    const key = "0x" + "ab".repeat(32);
    await withKeySettings({ key, password: "pw" }, async () => {
      const res = await clearRoute({ envFile: () => envFile }).clearNow();
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.warnings, [], "nothing left behind");
      assert.equal(config.PRIVATE_KEY, null, "unset in config");
      assert.equal(Object.hasOwn(process.env, "PRIVATE_KEY"), false);
      assert.equal(Object.hasOwn(process.env, "WALLET_PASSWORD"), false);
    });
    assert.equal(
      fs.readFileSync(envFile, "utf8"),
      "CHAIN_NAME=pulsechain\nPORT=5555\n",
      "every line setting them removed, the rest kept",
    );
  });

  it("finishes, naming the file and the line left, when .env cannot be rewritten", async () => {
    /*-
     *  A failed rewrite once threw after the wallet was deleted: the key
     *  and the session password stayed, and every position went on.
     *  Here the copy cannot be made: a folder holds its name.
     */
    const envFile = envFileWith("PRIVATE_KEY=0xabc\nPORT=5555\n");
    fs.mkdirSync(`${envFile}.tmp`);
    const key = "0x" + "ab".repeat(32);
    await withKeySettings({ key }, async () => {
      const c = clearRoute({ envFile: () => envFile });
      const res = await c.clearNow();
      assert.equal(res.status, 200);
      assert.deepEqual(c.done, ["wallet", "password", "positions"]);
      assert.equal(config.PRIVATE_KEY, null, "the key forgotten in memory");
      assert.equal(res.body.warnings.length, 1);
      assert.ok(res.body.warnings[0].includes(envFile), "names the file");
      assert.match(res.body.warnings[0], /PRIVATE_KEY line by hand/);
    });
    assert.equal(
      fs.readFileSync(envFile, "utf8"),
      "PRIVATE_KEY=0xabc\nPORT=5555\n",
      "the file as it was",
    );
  });

  it("finishes, naming both settings, when .env cannot even be read", async () => {
    // A folder where the file should be: which lines it holds is unknown.
    const envFile = path.join(makeTestTempFolder("wallet-clear-env"), ".env");
    fs.mkdirSync(envFile);
    await withKeySettings({ key: "0x" + "ab".repeat(32) }, async () => {
      const c = clearRoute({ envFile: () => envFile });
      const res = await c.clearNow();
      assert.equal(res.status, 200);
      assert.deepEqual(c.done, ["wallet", "password", "positions"]);
      assert.equal(res.body.warnings.length, 1, "nothing said of its source");
      assert.match(res.body.warnings[0], /could not be read or rewritten/);
      assert.match(res.body.warnings[0], /PRIVATE_KEY or WALLET_PASSWORD/);
    });
  });

  it("warns when a setting came from the environment the server was started from", async () => {
    // The next start would read it again: .env is not where it lives.
    _setEnvBeforeFileForTests(["PRIVATE_KEY", "WALLET_PASSWORD"]);
    const envFile = envFileWith("PORT=5555\n");
    await withKeySettings(
      { key: "0x" + "ab".repeat(32), password: "pw" },
      async () => {
        const res = await clearRoute({ envFile: () => envFile }).clearNow();
        assert.equal(res.status, 200);
        assert.equal(res.body.warnings.length, 2);
        assert.match(
          res.body.warnings[0],
          /^PRIVATE_KEY came from the environment/,
        );
        assert.match(
          res.body.warnings[1],
          /^WALLET_PASSWORD came from the environment/,
        );
        assert.equal(config.PRIVATE_KEY, null, "unset for this run");
      },
    );
  });

  it("warns when a key setting is set both in the environment the server was started from and in .env", async () => {
    /*-
     *  dotenv leaves the shell's value in place, so that was the one in
     *  use, and the next start from that shell reads it again, whatever
     *  the Clear removes from .env.
     */
    _setEnvBeforeFileForTests(["PRIVATE_KEY"]);
    const envFile = envFileWith("PRIVATE_KEY=0xabc\nPORT=5555\n");
    await withKeySettings({ key: "0x" + "ab".repeat(32) }, async () => {
      const res = await clearRoute({ envFile: () => envFile }).clearNow();
      assert.equal(res.status, 200);
      assert.equal(res.body.warnings.length, 1);
      assert.match(
        res.body.warnings[0],
        /^PRIVATE_KEY was also set in the environment the server was started from \(the shell or a service manager\), and that value, not \.env's, was the one in use\. Remove it there too, or the next start reads it again\.$/,
      );
      assert.equal(config.PRIVATE_KEY, null, "unset for this run");
    });
    assert.equal(
      fs.readFileSync(envFile, "utf8"),
      "PORT=5555\n",
      "its .env line removed",
    );
  });

  it("says no .env line was removed when the rewrite failed, for a setting the environment also set", async () => {
    /*-
     *  A failed rewrite leaves the .env line in place, so the
     *  environment's warning must not say it was removed.
     */
    _setEnvBeforeFileForTests(["PRIVATE_KEY"]);
    const envFile = envFileWith("PRIVATE_KEY=0xabc\nPORT=5555\n");
    fs.mkdirSync(`${envFile}.tmp`);
    await withKeySettings({ key: "0x" + "ab".repeat(32) }, async () => {
      const res = await clearRoute({ envFile: () => envFile }).clearNow();
      assert.equal(res.status, 200);
      assert.equal(res.body.warnings.length, 2);
      assert.match(res.body.warnings[0], /could not be rewritten/);
      assert.match(res.body.warnings[1], /^PRIVATE_KEY was also set/);
      for (const w of res.body.warnings)
        assert.doesNotMatch(w, /line is removed/, w);
    });
  });

  it("warns of nothing for a setting .env alone gave, even once its line is gone", async () => {
    /*-
     *  As after `npm run reset-wallet` while the server runs: .env set
     *  WALLET_PASSWORD at the start, and its line is gone now. The next
     *  start reads nothing, so there is nothing to remove anywhere, and
     *  the Clear warns of nothing.
     */
    const envFile = envFileWith("PORT=5555\n");
    await withKeySettings({ password: "pw" }, async () => {
      const res = await clearRoute({ envFile: () => envFile }).clearNow();
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.warnings, []);
      assert.equal(Object.hasOwn(process.env, "WALLET_PASSWORD"), false);
    });
  });

  it("names a setting from the environment even when .env cannot be read", async () => {
    // What the environment set is known without reading the file.
    _setEnvBeforeFileForTests(["WALLET_PASSWORD"]);
    const envFile = path.join(makeTestTempFolder("wallet-clear-env"), ".env");
    fs.mkdirSync(envFile);
    await withKeySettings({ password: "pw" }, async () => {
      const res = await clearRoute({ envFile: () => envFile }).clearNow();
      assert.equal(res.status, 200);
      assert.equal(res.body.warnings.length, 2);
      assert.match(res.body.warnings[0], /could not be read or rewritten/);
      assert.match(
        res.body.warnings[1],
        /^WALLET_PASSWORD came from the environment/,
      );
    });
  });

  it("is refused while an unlock, a Reveal Key or the launch's key step uses the wallet", async () => {
    const c = clearRoute();
    c.walletInUse.begin();
    const res = await c.clearNow();
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /decrypting the wallet/);
    assert.deepEqual(c.done, [], "nothing done");
  });

  it("stays refused until every unlock under way has ended", async () => {
    // Two tabs can send the password at once: each unlock marks its own.
    const c = clearRoute();
    c.walletInUse.begin();
    c.walletInUse.begin();
    c.walletInUse.end();
    assert.equal((await c.clearNow()).status, 409, "one still decrypting");
    c.walletInUse.end();
    assert.equal((await c.clearNow()).status, 200);
    assert.deepEqual(c.done, ["wallet", "password", "positions"]);
  });

  it("is refused while a wallet import is under way", async () => {
    const c = clearRoute();
    appPhase.beginWalletImport();
    const res = await c.clearNow();
    assert.equal(res.status, 409);
    assert.match(res.body.error, /importing a wallet/);
    assert.match(res.body.error, /started that wallet's positions/);
    assert.deepEqual(c.done, [], "nothing done");
    appPhase.endWalletImport();
    assert.equal((await c.clearNow()).status, 200, "taken once it ended");
  });

  it("is refused while the saved positions are being started", async () => {
    /*-
     *  The start-up would go on starting positions the Clear stops, as
     *  an import is refused meanwhile for the same reason.
     */
    const c = clearRoute();
    appPhase.beginStartUp(3);
    const res = await c.clearNow();
    assert.equal(res.status, 409);
    assert.match(res.body.error, /still starting the positions it manages/);
    assert.match(res.body.error, /\(0 of 3\)/);
    assert.match(
      res.body.error,
      /Try Clear Wallet again once it has started them/,
    );
    assert.deepEqual(c.done, [], "nothing done");
    appPhase.endStartUp();
    assert.equal((await c.clearNow()).status, 200, "taken once it ended");
  });

  it("says only that LP Ranger is starting up when no position is saved", async () => {
    // With nothing to start, the start-up takes a moment.
    const c = clearRoute();
    appPhase.beginStartUp(0);
    const res = await c.clearNow();
    assert.equal(res.status, 409);
    assert.equal(
      res.body.error,
      "LP Ranger is starting up. Try Clear Wallet again in a moment.",
    );
  });

  it("is refused while the server, having refused to start, waits to exit", async () => {
    const c = clearRoute({ startRefusal: () => "PRIVATE_KEY is for another" });
    const res = await c.clearNow();
    assert.equal(res.status, 409);
    assert.match(res.body.error, /cannot start and is stopping/);
    assert.deepEqual(c.done, [], "nothing done");
  });

  it("is refused at once while a rebalance is under way, naming the position", async () => {
    /*-
     *  Refused rather than waited for (the user's design, 2026-11-27): a
     *  Clear that waited stopped every position only once the move had
     *  finished, the request hanging meanwhile.
     */
    const states = new Map([[KEY, { ...POSITION, rebalanceInProgress: true }]]);
    const c = clearRoute({ states: () => states });
    const res = await c.clearNow();
    assert.equal(res.status, 409);
    assert.equal(
      res.body.error,
      "LP Ranger is rebalancing WPLS/DAI NFT #157149. Try Clear Wallet again once it has finished.",
    );
    assert.deepEqual(c.done, [], "nothing done");
    states.get(KEY).rebalanceInProgress = false;
    assert.equal((await c.clearNow()).status, 200, "taken once it finished");
  });

  it("is refused at once while a compound is under way", async () => {
    const states = new Map([[KEY, { ...POSITION, compoundInProgress: true }]]);
    const res = await clearRoute({ states: () => states }).clearNow();
    assert.equal(res.status, 409);
    assert.match(
      res.body.error,
      /^LP Ranger is compounding WPLS\/DAI NFT #157149\./,
    );
  });

  it("is refused at once while a position is starting", async () => {
    // Its first check can rebalance before its loop can be halted.
    const c = clearRoute({
      states: () => new Map([[KEY, POSITION]]),
      startingKeys: () => [KEY],
    });
    const res = await c.clearNow();
    assert.equal(res.status, 409);
    assert.equal(
      res.body.error,
      "LP Ranger is starting WPLS/DAI NFT #157149. Try Clear Wallet again once it has started.",
    );
    assert.deepEqual(c.done, [], "nothing done");
  });

  it("goes through while a scan runs, since a scan moves no coins", async () => {
    const states = new Map([[KEY, { ...POSITION, _scanRunning: true }]]);
    const res = await clearRoute({ states: () => states }).clearNow();
    assert.equal(res.status, 200);
  });
});
