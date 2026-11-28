/**
 * @file src/lib/ask-password.js
 * @description
 * A prompt on the terminal for a secret, such as a password or an api
 * key, that shows nothing of what is typed. Shared by server.js
 * (`--unlock-at-terminal`), bot.js, scripts/import-wallet.js and the bookkeeping
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

/*-
 *  How Ctrl+C reaches the program. The prompt holds the terminal in raw
 *  mode, so Ctrl+C arrives as a key, not a signal; it is passed on as
 *  the signal Ctrl+C sends anywhere else, and the program ends as it
 *  does on Ctrl+C, through its own handlers when it has them.
 */
let _interrupt = () => process.kill(process.pid, "SIGINT");

/**
 * TEST-ONLY seam: take Ctrl+C in place of the signal, which would end
 * the test process.
 * @param {() => void} fn
 * @returns {() => void}  Puts the signal back.
 */
function _setInterruptForTests(fn) {
  const prior = _interrupt;
  _interrupt = fn;
  return () => {
    _interrupt = prior;
  };
}

/**
 * Ask for a secret on the terminal, showing nothing of what is typed.
 *
 * The answer is the line typed before Enter. When the input ends after
 * text with no Enter, as a password piped in without a final newline
 * does, that text is the answer. When it ends before anything is
 * typed (Ctrl+D, or no terminal at all, as when a service manager starts
 * LP Ranger with its input on /dev/null), readline would never answer,
 * so the prompt says why (`_CLOSED`, a warning) and answers null; the
 * caller decides what follows, rather than waiting for ever. Ctrl+C is
 * no answer: the terminal is given back and Ctrl+C goes to the program
 * as a signal, as it does anywhere else.
 * @param {string} prompt  Text written before the answer is typed.
 * @param {{input?: import("stream").Readable,
 *   output?: import("stream").Writable}} [streams]  Where the answer is
 *   typed and where the prompt goes: stdin and stderr, unless a test
 *   passes its own.
 * @returns {Promise<string|null>}  What was typed, without the line end;
 *   null when the input ended before anything was typed. On Ctrl+C it
 *   does not settle: the program is ending.
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
    let interrupted = false;
    output.write(prompt);
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      output.write("\n");
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      interrupted = true;
      rl.close();
      output.write("\n");
      _interrupt();
    });
    rl.on("close", () => {
      if (answered || interrupted) return;
      output.write("\n");
      // Text the input ended on, with no Enter after it, is the answer.
      if (rl.line !== "") {
        resolve(rl.line);
        return;
      }
      log.warn(_CLOSED);
      resolve(null);
    });
  });
}

module.exports = { askPassword, _setInterruptForTests };
