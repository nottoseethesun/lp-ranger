/**
 * @file src/lib/ask-password.js
 * @description
 * A prompt on the terminal for a secret, such as a password or an api
 * key, that shows nothing of what is typed. Shared by server.js
 * (`--headless`), bot.js, scripts/import-wallet.js and the bookkeeping
 * report's Moralis key (util/bookkeeping/moralis-key.js). The prompt goes
 * to stderr, so stdout stays clean for piped output.
 *
 * Node has no option that hides what is typed, so this gives readline an
 * output that shows nothing. With `terminal: true`, readline turns off
 * the terminal's own echo (raw mode) and edits the line itself: it
 * writes each key typed, and each redraw of the line, to its output.
 * Here that output is a stream that drops whatever it is given. So the
 * keys still edit the line, a backspace or a paste, and none of it
 * reaches the screen. Only the prompt, written to stderr itself, and the
 * line break after the answer appear.
 */

"use strict";

const readline = require("readline");
const { Writable } = require("stream");

/**
 * A stream that takes whatever is written to it and shows none of it.
 * @returns {Writable}
 */
function _showsNothing() {
  return new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
}

/**
 * Ask for a secret on the terminal, showing nothing of what is typed.
 * @param {string} prompt  Text written before the answer is typed.
 * @param {{input?: import("stream").Readable,
 *   output?: import("stream").Writable}} [streams]  Where the answer is
 *   typed and where the prompt goes: stdin and stderr, unless a test
 *   passes its own.
 * @returns {Promise<string>}  What was typed, without the line end.
 */
function askPassword(prompt, streams = {}) {
  const input = streams.input === undefined ? process.stdin : streams.input;
  const output = streams.output === undefined ? process.stderr : streams.output;
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input,
      output: _showsNothing(),
      terminal: true,
    });
    output.write(prompt);
    rl.question("", (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
}

module.exports = { askPassword };
