"use strict";

/**
 * @file scripts/_import-wallet-ask.js
 * @description How scripts/import-wallet.js asks for a secret: the
 *   terminal prompt (src/lib/ask-password.js), its answer trimmed, and the
 *   import stopped, nothing imported, when the prompt closed with nothing
 *   typed (the prompt has said why). Its own module because the import
 *   script runs itself as it loads, so a test can load only this.
 *   The leading underscore marks this as a non-user-facing helper.
 */

const { log } = require("../src/lib/log");
const { askPassword } = require("../src/lib/ask-password");

/**
 * Ask for a secret, and stop the import when nothing was typed.
 * @param {string} prompt  Text written before the answer is typed.
 * @param {{ask?: Function, stop?: Function}} [deps]  The prompt, and how
 *   the import stops (exit 1); a test passes its own.
 * @returns {Promise<string>}  The answer, trimmed. When nothing was
 *   typed, what `stop` returns: the program has ended.
 */
async function askForImport(prompt, deps = {}) {
  const ask = deps.ask === undefined ? askPassword : deps.ask;
  const stop = deps.stop === undefined ? () => process.exit(1) : deps.stop;
  const answer = await ask(prompt);
  if (answer === null) {
    log.error(
      "Nothing was imported. Run npm run import-wallet again in a " +
        "terminal you can type into.",
    );
    return stop();
  }
  return answer.trim();
}

module.exports = { askForImport };
