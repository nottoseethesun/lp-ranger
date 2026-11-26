"use strict";

/**
 * @file scripts/_script-args.js
 * @description How a script that changes something reads its arguments,
 *   before it does anything: `--help` (or `-h`) prints its help and stops,
 *   and an argument it does not take is refused, with exit status 2, so a
 *   mistyped one never sets it to work. Used by scripts/reset-wallet.js,
 *   scripts/stop.js and scripts/clear-blockchain-scan-cache.js;
 *   scripts/clean.js reads its own in the same way. The leading underscore
 *   marks a helper, not a command.
 */

/**
 * Read a script's arguments.
 * @param {string[]} argv  The arguments after the script's name.
 * @param {string[]} [takes]  The flags the script takes besides `--help`.
 * @returns {{help: boolean, flags: Set<string>, bad: (string|null)}}  Whether
 *   help was asked for, the flags given, and the first argument the script
 *   does not take, or null.
 */
function readScriptArgs(argv, takes = []) {
  const out = { help: false, flags: new Set(), bad: null };
  for (const a of argv) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (takes.includes(a)) out.flags.add(a);
    else if (out.bad === null) out.bad = a;
  }
  return out;
}

/**
 * Answer `--help`, or an argument the script does not take, and say
 * whether it did: the script then stops, having changed nothing.
 * @param {{help: boolean, bad: (string|null)}} args  What `readScriptArgs`
 *   read.
 * @param {{tag: string, help: string, nothing: string}} text  The script's
 *   log tag, its help text, and the words that say it changed nothing.
 * @param {{out?: Function, err?: Function}} [io]  Where the words go: the
 *   console's out and error unless a test passes its own.
 * @returns {boolean}  True when one was answered, and the run is over.
 */
function answeredWithoutWork(args, text, io = {}) {
  const out = io.out === undefined ? console.log : io.out;
  const err = io.err === undefined ? console.error : io.err;
  if (args.help) {
    out(text.help);
    return true;
  }
  if (args.bad !== null) {
    err(
      `[${text.tag}] Unrecognized argument: ${args.bad}. ${text.nothing}\n\n${text.help}`,
    );
    process.exitCode = 2;
    return true;
  }
  return false;
}

module.exports = { readScriptArgs, answeredWithoutWork };
