"use strict";

/**
 * @file src/value-kinds.js
 * @module value-kinds
 * @description
 * The kinds of value a setting may hold, each a test and the words for
 * what passes it: "true or false", "a number above 0", "an http or
 * https address".
 *
 * The test suite holds every value the app ships as a default to one of
 * these kinds (test/shipped-config-values.test.js), and the app holds a
 * value it is handed to the same kind: an operator's own copy of a
 * shipped file, read at startup, and a request to `POST /api/config`. So
 * a value is judged one way, whichever way it arrives, and the words a
 * refusal uses are the words the tests fail with.
 *
 * Two other rules sit beside these and are not repeated here. A value
 * with a range in setting-bounds.json is held to that range by
 * `src/range-check.js`, and a value that becomes a timer delay is held
 * to `src/timer-bounds.js`.
 */

const { getAddress } = require("ethers");
const validator = require("validator");

/** A finite number. */
const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
/** Text that is not empty. */
const isText = (v) => typeof v === "string" && v.length > 0;
/** A whole number of at least 1. */
const isWhole = (v) => Number.isInteger(v) && v >= 1;

/** An http or https address. */
function isUrl(v) {
  if (!isText(v)) return false;
  try {
    return ["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}

/** An address in its EIP-55 checksummed form, as the project writes them. */
function isAddress(v) {
  if (!isText(v)) return false;
  try {
    return getAddress(v) === v;
  } catch {
    return false;
  }
}

/** A bare host name, such as `dexscreener.com`. */
function isHost(v) {
  if (!isText(v) || !v.includes(".")) return false;
  try {
    return new URL(`https://${v}`).hostname === v;
  } catch {
    return false;
  }
}

// The least gas any transaction uses: a plain transfer.
const TRANSFER_GAS = 21000;

/** A kind of value: the words for what passes, and the test. */
const kind = (what, ok) => Object.freeze({ what, ok });

/** Every kind the shipped files' values and the app's inputs are held to. */
const KINDS = Object.freeze({
  bool: kind("true or false", (v) => typeof v === "boolean"),
  text: kind("text", isText),
  textOrNone: kind('text, or "" for none', (v) => typeof v === "string"),
  count: kind("a whole number of at least 1", isWhole),
  ms: kind("a whole number of milliseconds, at least 1", isWhole),
  seconds: kind("a whole number of seconds, at least 1", isWhole),
  positive: kind("a number above 0", (v) => isNumber(v) && v > 0),
  usd: kind("a number of dollars, at least 0", (v) => isNumber(v) && v >= 0),
  coins: kind("a number of coins, at least 0", (v) => isNumber(v) && v >= 0),
  // An amount in a token's smallest unit, too large for a number.
  digits: kind(
    "a whole number written in digits",
    (v) => typeof v === "string" && /^\d+$/.test(v),
  ),
  isoTime: kind(
    "a date and time in ISO 8601 form",
    (v) => isText(v) && validator.isISO8601(v),
  ),
  // A multiplier that scales an estimate or a market price up.
  scalesUp: kind("a number of at least 1", (v) => isNumber(v) && v >= 1),
  // A bump that must outbid the transaction it replaces.
  outbids: kind("a number above 1", (v) => isNumber(v) && v > 1),
  port: kind(
    "a port number from 1 to 65535",
    (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
  ),
  gasUnits: kind(
    `a whole number of gas units, at least ${TRANSFER_GAS}`,
    (v) => Number.isInteger(v) && v >= TRANSFER_GAS,
  ),
  url: kind("an http or https address", isUrl),
  urlOrNone: kind(
    'an http or https address, or "" for none',
    (v) => v === "" || isUrl(v),
  ),
  address: kind("an EIP-55 address", isAddress),
  addressOrNone: kind(
    'an EIP-55 address, or "" for none',
    (v) => v === "" || isAddress(v),
  ),
  scheme: kind("http or https", (v) => v === "http" || v === "https"),
  host: kind("a host name", isHost),
  textList: kind(
    "a list of text, not empty",
    (v) => Array.isArray(v) && v.length > 0 && v.every(isText),
  ),
  /*-
   *  Matched against a message the classifier lower-cases first, so an
   *  entry with a capital letter in it could never match anything.
   */
  lowerTextList: kind(
    "a list of lower-case text, not empty",
    (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((s) => isText(s) && s === s.toLowerCase()),
  ),
});

module.exports = { KINDS, isNumber, isText, isWhole, isUrl, isAddress };
