"use strict";

/**
 * @file util/bookkeeping/moralis-key.js
 * @module bookkeeping/moralis-key
 * @description
 * The Moralis api key the bookkeeping report prices with, which is
 * LP Ranger's own: one key, kept in one place. LP Ranger's api-key store
 * (src/api-key-store.js) keeps it in
 * `app-config/user-configurable/api-keys.json`, encrypted with the
 * wallet's password, and the report reads and saves it only through that
 * store. A key saved in the dashboard serves the report, and one the
 * report saves serves LP Ranger from its next unlock.
 *
 * Moralis prices a coin at a block, as far back as the chain goes.
 * CoinGecko, through GeckoTerminal, answers only for the last 180 days.
 * So the report asks Moralis first, and CoinGecko only for a coin Moralis
 * has no price for, and it needs the key.
 *
 * The key's password is LP Ranger's wallet password, since the app
 * encrypts every api key it keeps with that password. The report needs
 * neither the wallet nor its private key, and never opens the wallet
 * file: the password opens only the key, and each prompt says so. A run
 * asks for the password and opens the saved key with it. With no key
 * saved yet, it warns not to save a key or password in LP Ranger
 * meanwhile, asks for the key and for the password twice, asks Moralis
 * whether it takes the key, and saves it only if it does. The report
 * never changes the password, and asks for it twice only when it saves a
 * new key. Both are typed in the terminal through
 * LP Ranger's own prompt (src/ask-password.js), which shows nothing of
 * what is typed. Neither is ever an argument, which shell history and
 * `ps` would keep. The password is saved nowhere. The
 * plain key is only in memory, in src/api-key-holder.js, which the price
 * library reads. Git ignores everything in `app-config/user-configurable/`
 * but its README, so the store never reaches the remote.
 *
 * The password typed for a new key is not checked against the wallet's.
 * LP Ranger's wallet module reads the wallet file as it loads, so a check
 * through it would have the report, and each of its tests, read that
 * file. A key saved under another password is one LP Ranger cannot open:
 * it logs that as the wallet unlocks, and the dashboard's Settings can
 * save the key again. The same happens when the wallet is cleared and
 * imported again under a new password, so a password that does not open
 * the key is answered with both: run again with the wallet's password,
 * or, if that was it, save the key again in Settings.
 *
 * Every run asks Moralis about the key once, before it prices anything.
 * The price library answers a refused key as it answers a coin with no
 * price: it asks CoinGecko instead. Without the check, a key Moralis
 * stopped taking would leave CoinGecko to answer alone, and the run would
 * stop only at the first day older than 180 days. A key whose quota is
 * used up is still taken, and CoinGecko answers until the quota resets.
 */

const { askPassword } = require("../../src/ask-password");
const {
  hasEncryptedKey,
  loadEncryptedKey,
  saveEncryptedKey,
} = require("../../src/api-key-store");
const { setApiKey } = require("../../src/api-key-holder");
const { pingMoralis } = require("../../src/server-moralis");

/** Where LP Ranger keeps its api keys, as the report's messages name it. */
const STORE_FILE = "app-config/user-configurable/api-keys.json";

/** The prompt for the key's password, which is the wallet's. */
const PASSWORD_PROMPT =
  "Password for the Moralis api key (LP Ranger's wallet password): ";

/*-
 *  Printed before a new key is asked for. The store reads its file, adds
 *  the key and writes the file back, so a key or password LP Ranger saves
 *  in between could be lost.
 */
const SAVE_WARNING =
  "Don't save a key or password in LP Ranger while this runs.";

/**
 * An error that stops the run for want of a key Moralis takes. Its
 * message says what happened and what to do.
 * @param {string} message
 * @returns {Error}  With `keyRefused` set.
 */
function refused(message) {
  return Object.assign(new Error(message), { keyRefused: true });
}

/**
 * Ask Moralis whether it takes the key in memory.
 * @param {Function} ping  Answers "valid", "quota", "invalid" or another
 *   word, as `pingMoralis` does.
 * @param {Function} say  Prints a line.
 * @param {string} refusal  What to say when Moralis refuses the key.
 * @returns {Promise<void>}  Once Moralis takes the key.
 * @throws {Error}  With `keyRefused` set, when Moralis refuses the key or
 *   does not answer.
 */
async function checkKey(ping, say, refusal) {
  let status;
  try {
    status = await ping();
  } catch (error) {
    throw refused(
      `Moralis did not answer the check of the api key: ${error.message}. ` +
        "Try again later.",
    );
  }
  if (status === "valid") return;
  if (status === "quota") {
    say(
      "Moralis takes the api key, but its quota is used up for now, so " +
        "CoinGecko prices each coin until it resets, and only for the " +
        "last 180 days.",
    );
    return;
  }
  throw refused(refusal);
}

/**
 * Open the saved key with its password, the wallet's, typed.
 * @param {Function} ask  Prompts and answers what is typed.
 * @returns {Promise<string>}  The key.
 * @throws {Error}  With `keyRefused` set, when the password does not open
 *   the key, or the key is no longer saved.
 */
async function openSavedKey(ask) {
  const password = await ask(PASSWORD_PROMPT);
  let key;
  try {
    key = await loadEncryptedKey("moralis", password);
  } catch (error) {
    throw refused(
      `Could not open the Moralis api key LP Ranger keeps in ${STORE_FILE}: ` +
        `${error.message}. Run again with LP Ranger's wallet password. If ` +
        "that is the password you typed, the key was saved under an " +
        "earlier one, before the wallet was imported again: save the key " +
        "again in the dashboard's Settings, then run again.",
    );
  }
  if (key === null) {
    throw refused(
      `The Moralis api key is no longer in ${STORE_FILE}. Run again to ` +
        "enter it.",
    );
  }
  return key;
}

/**
 * Ask for a new key and for its password, the wallet's, typed twice.
 * @param {Function} ask  Prompts and answers what is typed.
 * @returns {Promise<{key: string, password: string}>}
 * @throws {Error}  With `keyRefused` set, when either is empty or the two
 *   passwords differ.
 */
async function askNewKey(ask) {
  const key = (await ask("Moralis api key: ")).trim();
  if (key.length === 0) throw refused("No Moralis api key was entered.");
  const password = await ask(PASSWORD_PROMPT);
  if (password.length === 0) throw refused("No password was entered.");
  const again = await ask("That password again: ");
  // eslint-disable-next-line security/detect-possible-timing-attacks -- Safe: comparing two strings the user typed, to confirm one, not checking a secret
  if (again !== password)
    throw refused("The two passwords differ, so the key was not saved.");
  return { key, password };
}

/**
 * Put the Moralis key in memory for the run, once Moralis takes it: the
 * key saved in LP Ranger's api-key store, opened with the wallet's
 * password, or with none saved, a key typed in and then saved there.
 *
 * @param {{ask?: Function, ping?: Function, say?: Function}} [deps]
 *   Tests pass answers to the prompts, a stand-in for Moralis, and a way
 *   to hear what is printed.
 * @returns {Promise<void>}
 * @throws {Error}  With `keyRefused` set, when the run cannot have a key
 *   Moralis takes; its message says why and what to do.
 */
async function unlockMoralisKey(deps = {}) {
  const ask = deps.ask === undefined ? askPassword : deps.ask;
  const ping = deps.ping === undefined ? pingMoralis : deps.ping;
  const say = deps.say === undefined ? console.log : deps.say;
  if (hasEncryptedKey("moralis")) {
    const saved = await openSavedKey(ask);
    setApiKey("moralis", saved);
    await checkKey(
      ping,
      say,
      `Moralis refused the api key saved in ${STORE_FILE}. Save a new one ` +
        "in the dashboard's Settings, then run again.",
    );
    return;
  }
  say(
    "The report prices each coin with Moralis, and with CoinGecko where " +
      "Moralis has no price, so it needs a Moralis api key, and LP Ranger " +
      `has none saved. Enter it once: it is saved in ${STORE_FILE}, ` +
      "encrypted with LP Ranger's wallet password as the dashboard saves " +
      "it, and LP Ranger uses it too from its next unlock.",
  );
  say(SAVE_WARNING);
  const { key, password } = await askNewKey(ask);
  setApiKey("moralis", key);
  await checkKey(
    ping,
    say,
    "Moralis refused the api key, so it was not saved. Run again and " +
      "enter the key as Moralis shows it.",
  );
  await saveEncryptedKey("moralis", key, password);
  say(
    `The Moralis api key is saved, encrypted, in ${STORE_FILE}, where ` +
      "LP Ranger reads it too.",
  );
}

module.exports = { STORE_FILE, SAVE_WARNING, unlockMoralisKey };
