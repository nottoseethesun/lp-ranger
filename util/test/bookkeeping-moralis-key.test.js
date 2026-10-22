"use strict";

/**
 * @file util/test/bookkeeping-moralis-key.test.js
 * @description
 * Tests for the Moralis api key the bookkeeping report prices with
 * (`util/bookkeeping/moralis-key.js`), which is LP Ranger's own, kept in
 * its api-key store (src/api-key-store.js). A key the app saved opens with
 * the wallet's password; with none saved, a key typed in is saved where
 * the app reads it, once Moralis takes it. Every prompt is answered by a
 * stand-in and every question to Moralis goes to one, so no case waits on
 * a terminal or reaches the network.
 *
 * The store is a file of the test process's own, named in
 * `API_KEYS_FILE_PATH` before the store is loaded, as the app's own tests
 * do, and emptied before each case. The real store's place is checked
 * against git's own rules, so it never reaches the remote.
 */

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeTestTempFolder } = require("../../src/test-temp-folders");

/*-
 *  The store reads where its file is as it loads, so the test's own file
 *  is named before the store is required.
 */
const STORE = path.join(makeTestTempFolder("moralis-key"), "api-keys.json");
process.env.API_KEYS_FILE_PATH = STORE;

const { getApiKey, setApiKey } = require("../../src/api-key-holder");
const {
  saveEncryptedKey,
  loadEncryptedKey,
  hasEncryptedKey,
} = require("../../src/api-key-store");
const {
  STORE_FILE,
  SAVE_WARNING,
  unlockMoralisKey,
} = require("../bookkeeping/moralis-key");

const KEY = "moralis-test-key-0123456789";
const PASSWORD = "correct horse battery staple";
const PASSWORD_PROMPT =
  "Password for the Moralis api key (LP Ranger's wallet password): ";

beforeEach(() => {
  fs.rmSync(STORE, { force: true });
  setApiKey("moralis", "");
});

/**
 * A run's stand-ins: answers to the prompts in order, Moralis's answer
 * about the key, and what was printed and asked.
 * @param {string[]} answers  What the user types at each prompt.
 * @param {Function|string} [moralis]  Moralis's answer, or a function
 *   giving it.
 * @returns {{deps: object, prompts: string[], said: string[],
 *   pings: number[]}}
 */
function stage(answers, moralis = "valid") {
  const prompts = [];
  const said = [];
  const pings = [0];
  const queue = [...answers];
  const deps = {
    ask: async (prompt) => {
      prompts.push(prompt);
      return queue.shift();
    },
    ping: async () => {
      pings[0] += 1;
      return typeof moralis === "function" ? moralis() : moralis;
    },
    say: (line) => said.push(line),
  };
  return { deps, prompts, said, pings };
}

/** Whether an error stops the run for want of a key, with `words` in it. */
const refusedWith = (words) => (error) => {
  assert.equal(error.keyRefused, true);
  assert.ok(error.message.includes(words), error.message);
  return true;
};

test("a run opens the key LP Ranger saved, with the wallet's password", async () => {
  await saveEncryptedKey("moralis", KEY, PASSWORD);
  const { deps, prompts, said, pings } = stage([PASSWORD]);
  await unlockMoralisKey(deps);
  assert.deepEqual(prompts, [PASSWORD_PROMPT]);
  assert.equal(pings[0], 1, "Moralis was asked about the key once");
  const held = getApiKey("moralis");
  assert.equal(held, KEY);
  const warned = said.includes(SAVE_WARNING);
  assert.equal(warned, false, "no warning when nothing is saved");
});

test("with no key saved, a run saves the one typed where LP Ranger reads it", async () => {
  const { deps, prompts, said, pings } = stage([KEY, PASSWORD, PASSWORD]);
  await unlockMoralisKey(deps);
  assert.deepEqual(prompts, [
    "Moralis api key: ",
    PASSWORD_PROMPT,
    "That password again: ",
  ]);
  assert.equal(pings[0], 1, "Moralis was asked about the key once");
  const held = getApiKey("moralis");
  assert.equal(held, KEY);
  const appOpens = await loadEncryptedKey("moralis", PASSWORD);
  assert.equal(appOpens, KEY, "LP Ranger opens it with the wallet's password");
  const saved = fs.readFileSync(STORE, "utf8");
  assert.ok(!saved.includes(KEY), "the key is not saved in plain text");
  assert.ok(!saved.includes(PASSWORD), "the password is saved nowhere");
  assert.match(said[0], /LP Ranger has none saved/);
  assert.equal(said[1], SAVE_WARNING, "warned before the key is asked for");
  assert.equal(
    said.at(-1),
    `The Moralis api key is saved, encrypted, in ${STORE_FILE}, where ` +
      "LP Ranger reads it too.",
  );
});

test("saving a key keeps LP Ranger's other keys", async () => {
  await saveEncryptedKey("telegramBotToken", "a bot token", PASSWORD);
  const { deps } = stage([KEY, PASSWORD, PASSWORD]);
  await unlockMoralisKey(deps);
  const token = await loadEncryptedKey("telegramBotToken", PASSWORD);
  assert.equal(token, "a bot token");
});

test("a new key Moralis refuses is not saved", async () => {
  const { deps } = stage([KEY, PASSWORD, PASSWORD], "invalid");
  const run = unlockMoralisKey(deps);
  await assert.rejects(
    run,
    refusedWith("Moralis refused the api key, so it was not saved."),
  );
  const saved = hasEncryptedKey("moralis");
  assert.equal(saved, false);
});

test("a new key is not saved when Moralis does not answer", async () => {
  const { deps } = stage([KEY, PASSWORD, PASSWORD], () => {
    throw new Error("fetch failed");
  });
  const run = unlockMoralisKey(deps);
  await assert.rejects(
    run,
    refusedWith(
      "Moralis did not answer the check of the api key: fetch failed",
    ),
  );
  const saved = hasEncryptedKey("moralis");
  assert.equal(saved, false);
});

test("passwords that differ save nothing, asking Moralis nothing", async () => {
  const { deps, pings } = stage([KEY, PASSWORD, "another"]);
  const run = unlockMoralisKey(deps);
  await assert.rejects(run, refusedWith("The two passwords differ"));
  assert.equal(pings[0], 0);
  const saved = hasEncryptedKey("moralis");
  assert.equal(saved, false);
});

test("an empty key or password saves nothing", async () => {
  const noKey = stage(["  ", PASSWORD, PASSWORD]);
  const first = unlockMoralisKey(noKey.deps);
  await assert.rejects(first, refusedWith("No Moralis api key was entered."));
  const noPassword = stage([KEY, "", ""]);
  const second = unlockMoralisKey(noPassword.deps);
  await assert.rejects(second, refusedWith("No password was entered."));
  const saved = hasEncryptedKey("moralis");
  assert.equal(saved, false);
});

test("a new key whose quota is used up is saved, and the run says CoinGecko answers", async () => {
  const { deps, said } = stage([KEY, PASSWORD, PASSWORD], "quota");
  await unlockMoralisKey(deps);
  const saved = hasEncryptedKey("moralis");
  assert.equal(saved, true);
  assert.ok(
    said.some((line) => line.includes("its quota is used up for now")),
    said.join("\n"),
  );
});

test("a wrong wallet password stops the run, asking Moralis nothing", async () => {
  await saveEncryptedKey("moralis", KEY, PASSWORD);
  const { deps, pings } = stage(["wrong"]);
  const run = unlockMoralisKey(deps);
  await assert.rejects(
    run,
    refusedWith(
      `Could not open the Moralis api key LP Ranger keeps in ${STORE_FILE}`,
    ),
  );
  assert.equal(pings[0], 0);
  const kept = await loadEncryptedKey("moralis", PASSWORD);
  assert.equal(kept, KEY, "the saved key stays");
});

test("a key saved under an earlier wallet password is to be saved again in Settings", async () => {
  await saveEncryptedKey("moralis", KEY, "the password before a re-import");
  const { deps } = stage([PASSWORD]);
  const run = unlockMoralisKey(deps);
  await assert.rejects(
    run,
    refusedWith(
      "Run again with LP Ranger's wallet password. If that is the " +
        "password you typed, the key was saved under an earlier one, " +
        "before the wallet was imported again: save the key again in the " +
        "dashboard's Settings, then run again.",
    ),
  );
});

test("a saved key Moralis refuses stops the run, saying where to save a new one", async () => {
  await saveEncryptedKey("moralis", KEY, PASSWORD);
  const { deps } = stage([PASSWORD], "invalid");
  const run = unlockMoralisKey(deps);
  await assert.rejects(
    run,
    refusedWith(
      `Moralis refused the api key saved in ${STORE_FILE}. Save a new one ` +
        "in the dashboard's Settings, then run again.",
    ),
  );
});

test("git ignores LP Ranger's key store, so it never reaches the remote", () => {
  const root = path.resolve(__dirname, "../..");
  const res = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--no-index", STORE_FILE],
    { cwd: root },
  );
  assert.equal(res.status, 0, "git check-ignore finds a rule ignoring it");
});
