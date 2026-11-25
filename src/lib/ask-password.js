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
const { log } = require("./log");

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

// What the prompt says when its input ends before anything is typed.
const _CLOSED =
  "[password] The prompt closed before anything was typed: Ctrl+D was " +
  "pressed, or there is no terminal to type into (started by a service " +
  "manager or a script, or with its input cut off).";

/**
 * Ask for a secret on the terminal, showing nothing of what is typed.
 *
 * The input can end before an answer: Ctrl+D, or no terminal at all, as
 * when a service manager starts LP Ranger with its input on /dev/null.
 * Readline then never answers, so the prompt says why (`_CLOSED`, a
 * warning) and answers null, and the caller stops with its own error,
 * saying what to do, rather than waiting for ever.
 * @param {string} prompt  Text written before the answer is typed.
 * @param {{input?: import("stream").Readable,
 *   output?: import("stream").Writable}} [streams]  Where the answer is
 *   typed and where the prompt goes: stdin and stderr, unless a test
 *   passes its own.
 * @returns {Promise<string|null>}  What was typed, without the line end;
 *   null when the input ended first.
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
    let answered = false;
    output.write(prompt);
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      output.write("\n");
      resolve(answer);
    });
    rl.on("close", () => {
      if (answered) return;
      output.write("\n");
      log.warn(_CLOSED);
      resolve(null);
    });
  });
}

module.exports = { askPassword };
