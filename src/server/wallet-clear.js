"use strict";

/**
 * @file src/server/wallet-clear.js
 * @module wallet-clear
 * @description
 * `DELETE /api/wallet`: Clear Wallet, the dashboard's ✕ Clear button and
 * its Clear Wallet dialog. It removes the stored wallet: the server
 * forgets it and deletes its encrypted file (src/lib/wallet-manager.js
 * `clearWallet`). It also stops the positions and forgets the key (the
 * user's rulings, 2026-11-27):
 * - `PRIVATE_KEY` and `WALLET_PASSWORD` are set to unset in memory, and
 *   their lines removed from the `.env` the app reads;
 * - the session's wallet password is forgotten;
 * - the bot halts every position at once, then forgets the key and the
 *   signer built from it, as an import does to the old wallet
 *   (`forgetWallet`, src/bot/bot-interface.js). The positions' saved
 *   status is left as it is, so importing the same wallet again starts
 *   them again.
 * It waits for nothing, and answers at once: it is refused while a
 * rebalance or compound is under way or a position is starting, and a
 * check still reading the chain starts no move once its loop is halted
 * (the user's design, 2026-11-27: refuse, never wait).
 *
 * A variable the environment the server was started from set, whether
 * or not `.env` also had a line, is logged and named in the answer
 * (`warnings`), which the dashboard shows, and the Clear finishes: that
 * environment sets it again at the next start. A `.env` the Clear cannot
 * read or rewrite (a full disk, a read-only file) is a file failure, told
 * with the lines to remove by hand (`_byHand`), which stops LP Ranger
 * (src/lib/stop-on-file-problem.js): the server stops answering at once,
 * so this answer is never sent, and the Clear's other steps run before
 * the process exits.
 *
 * Refused (409, saying why):
 * - while the server, having refused to start, waits to exit;
 * - while a wallet import is under way (src/bot/app-phase.js), or the
 *   start-up of the saved positions, which would go on starting positions
 *   the Clear stops;
 * - while a rebalance or compound is under way, or a position is
 *   starting (src/bot/under-way.js);
 * - while the server is using the wallet: an unlock, a Reveal Key or the
 *   launch's key step under way (src/server/wallet-in-use.js), so no
 *   decrypt finds its wallet gone partway (the user's design,
 *   2026-11-26).
 * Every status answer carries the same refusal as `clearWalletRefusal`
 * (src/server/handle-api-status.js), so each tab disables Clear Wallet
 * meanwhile, the refusal its tooltip.
 */

const { log } = require("../lib/log");
const { tellFileProblem } = require("../lib/file-problem");
const config = require("../lib/config");
const {
  readEnv,
  envFilePath,
  setBeforeEnvFile,
  unsetEnv,
  envFileSets,
  removeEnvFileSettings,
} = require("../lib/env-settings");

// The variables a Clear takes away, in memory and in `.env`.
const _KEY_SETTINGS = ["PRIVATE_KEY", "WALLET_PASSWORD"];

// Why a Clear is refused while the wallet is decrypted or its password awaited.
const _IN_USE =
  "LP Ranger is decrypting the wallet, to unlock it or to reveal its key, " +
  "or waiting for the wallet's password at the terminal it was started " +
  "from. Try Clear Wallet again once that has finished.";

// Why a Clear is refused while a wallet import is under way.
const _IMPORTING =
  "LP Ranger is importing a wallet. Try Clear Wallet again once it has " +
  "started that wallet's positions.";

// Why a Clear is refused while the server, having refused to start, waits to exit.
const _STOPPING =
  "LP Ranger cannot start and is stopping, so the wallet is left as it is.";

/**
 * Why a Clear is refused now, or null when it may go ahead.
 * @param {{inUse: Function}} walletInUse  The server's tracker.
 * @param {object} bot  The bot's interface: its refusal to take a key is
 *   set exactly while a wallet import is under way, its closing start-up
 *   included (`refusalToTakeKey`); its start-up progress while the saved
 *   positions are being started (`startUpProgress`, `startUpRefusal`);
 *   and its refusal of a wallet change while a rebalance or compound is
 *   under way or a position is starting (`refusalToChangeWallet`).
 * @param {string|null} startRefusal  Why the launch was refused, while
 *   the server waits to exit (src/server/server-routes.js).
 * @returns {string|null}
 */
function refusalToClear(walletInUse, bot, startRefusal) {
  if (startRefusal !== null) return _STOPPING;
  if (bot.refusalToTakeKey() !== null) return _IMPORTING;
  if (bot.startUpProgress() !== null)
    return bot.startUpRefusal("Clear Wallet again");
  const moving = bot.refusalToChangeWallet("Clear Wallet");
  if (moving !== null) return moving;
  if (walletInUse.inUse()) return _IN_USE;
  return null;
}

/**
 * Which of `names` were set in this process's environment as the Clear
 * began: `PRIVATE_KEY` as config read it (`config.PRIVATE_KEY`), the rest
 * through `readEnv`.
 * @param {string[]} names
 * @returns {string[]}
 */
function _setNow(names) {
  return names.filter((name) =>
    name === "PRIVATE_KEY"
      ? config.PRIVATE_KEY !== null && config.PRIVATE_KEY !== undefined
      : readEnv(name) !== undefined,
  );
}

/**
 * Which of the key settings `file` sets, or null when it cannot be read.
 * @param {string} file
 * @returns {string[]|null}
 */
function _setInFile(file) {
  try {
    return _KEY_SETTINGS.filter((name) => envFileSets(file, name));
  } catch {
    return null;
  }
}

/**
 * What the operator removes from `.env` by hand when the Clear could not
 * rewrite it, or nothing when the file set none of the key settings.
 * @param {string[]|null} left  The names the file sets, or null when it
 *   could not be read.
 * @returns {string[]}  The step, for the words the failure is told in.
 */
function _byHand(left) {
  if (left === null)
    return [
      "Remove any PRIVATE_KEY or WALLET_PASSWORD line from it by hand, or " +
        "the next start reads it.",
    ];
  if (left.length === 0) return [];
  const one = left.length === 1;
  return [
    `Remove its ${left.join(" and ")} ${one ? "line" : "lines"} by hand, ` +
      `or the next start reads ${one ? "it" : "them"} again.`,
  ];
}

/**
 * Remove the key settings' lines from `file`. A failure is told as every
 * file failure is, which stops LP Ranger (src/lib/file-problem.js), with
 * the lines to remove by hand; never thrown.
 * @param {string} file  The `.env` file.
 * @returns {string[]|null}  The names the file set, removed or left, or
 *   null when it could not be read, so which it sets is unknown.
 */
function _removeFromFile(file) {
  try {
    const removed = removeEnvFileSettings(file, _KEY_SETTINGS) ?? [];
    for (const name of removed)
      log.warn("[server] Clear Wallet removed %s from %s", name, file);
    return removed;
  } catch (err) {
    const left = _setInFile(file);
    // A file it cannot even read is told as a read, never a write.
    tellFileProblem({
      doing: left === null ? "read" : "write to",
      file,
      err,
      then: _byHand(left),
    });
    return left;
  }
}

/**
 * The warning for a key setting the Clear forgot in memory that the next
 * start would read again, or null. That is one the environment the
 * server was started from set before `.env` was read (`setBeforeEnvFile`):
 * its value was the one in use, whether or not `.env` also had a line,
 * and that environment sets it again. A setting `.env` alone gave warns
 * of nothing here, even when its line is gone since the start, as after
 * `npm run reset-wallet`: the next start does not read it, and a line the
 * Clear could not remove is told with the failure (`_removeFromFile`).
 * @param {string} name
 * @param {string[]|null} inFile  The key settings `.env` set, or null
 *   when it could not be read.
 * @returns {string|null}
 */
function _environmentWarning(name, inFile) {
  if (!setBeforeEnvFile(name)) return null;
  if (inFile !== null && inFile.includes(name))
    return (
      `${name} was also set in the environment the server was started ` +
      "from (the shell or a service manager), and that value, not .env's, " +
      "was the one in use. Remove it there too, or the next start reads " +
      "it again."
    );
  return (
    `${name} came from the environment the server was started from (the ` +
    "shell or a service manager), not .env. Remove it there too, or the " +
    "next start reads it again."
  );
}

/**
 * Take `PRIVATE_KEY` and `WALLET_PASSWORD` away: set to unset in memory
 * (`config.PRIVATE_KEY` null, as when none is set, and each deleted from
 * the environment), and their lines removed from the `.env` the app
 * reads, of which there is none under `node --test` (`envFilePath`).
 * One the environment the server was started from set is warned of
 * (`_environmentWarning`), since the next start reads it again. A `.env`
 * it cannot rewrite is a file failure, which stops LP Ranger
 * (`_removeFromFile`). Never throws: each other thing left behind is a
 * warning, logged and returned.
 * @param {() => (string|null)} envFile  The `.env` file, or null.
 * @returns {string[]}  The warnings, for the operator.
 */
function _forgetKeySettings(envFile) {
  const wasSet = _setNow(_KEY_SETTINGS);
  config.PRIVATE_KEY = null;
  for (const name of _KEY_SETTINGS) unsetEnv(name);
  const file = envFile();
  const warnings = [];
  const inFile = file === null ? [] : _removeFromFile(file);
  for (const name of wasSet) {
    const warning = _environmentWarning(name, inFile);
    if (warning !== null) warnings.push(warning);
  }
  for (const w of warnings) log.warn("[server] Clear Wallet: %s", w);
  return warnings;
}

/**
 * Build the Clear Wallet route.
 * @param {object} deps
 * @param {object} deps.walletManager  Removes the wallet (`clearWallet`).
 * @param {{inUse: Function}} deps.walletInUse
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js):
 *   its refusals (`refusalToClear`'s) and `forgetWallet`.
 * @param {Function} deps.forgetSessionPassword  Forgets the session's
 *   wallet password (src/server/server-routes.js).
 * @param {() => (string|null)} deps.startRefusal  Why the launch was
 *   refused, while the server waits to exit (src/server/server-routes.js).
 * @param {Function} deps.jsonResponse  `(res, status, body) => void`
 * @param {() => (string|null)} [deps.envFile]  The `.env` file to remove
 *   the key settings from: the app's (`envFilePath`), unless a test passes
 *   its own.
 * @returns {(req: object, res: object) => void}  It runs straight
 *   through, from its refusals to its answer, waiting for nothing.
 */
function createWalletClearRoute(deps) {
  const { walletManager, walletInUse, bot, forgetSessionPassword } = deps;
  const { startRefusal, jsonResponse, envFile = envFilePath } = deps;
  return function handleWalletClear(_req, res) {
    const refusal = refusalToClear(walletInUse, bot, startRefusal());
    if (refusal !== null) {
      log.warn("[server] DELETE /api/wallet refused: %s", refusal);
      return jsonResponse(res, 409, { ok: false, error: refusal });
    }
    log.warn(
      "[server] DELETE /api/wallet received — removing the wallet and its key, and stopping every position",
    );
    walletManager.clearWallet();
    const warnings = _forgetKeySettings(envFile);
    forgetSessionPassword();
    bot.forgetWallet();
    log.warn("[server] Wallet cleared: every position stopped, no key held");
    return jsonResponse(res, 200, { ok: true, warnings });
  };
}

module.exports = { refusalToClear, createWalletClearRoute };
