"use strict";

/**
 * @file src/value-kinds.js
 * @module value-kinds
 * @description
 * The kinds of value a setting may hold, each a JSON Schema and the words
 * for what passes it: "true or false", "a number above 0", "an http or
 * https address".
 *
 * Each kind is written once, as JSON Schema (draft 2020-12), and checked
 * by Ajv, the JSON Schema validator: `schema` is what a settings file's
 * schema embeds for a value of the kind (src/settings-file-rules.js), and
 * `ok` is the same schema compiled, for code that asks about one value,
 * such as the startup check of the records file
 * (src/config-record-checks.js). So a value is judged one way, whichever
 * way it arrives, and the words a refusal uses are the words the tests
 * fail with.
 *
 * What JSON Schema cannot say, code says, as a named format: whether an
 * address is in its EIP-55 form, a url's protocol, an RPC endpoint the
 * provider can dial, a host name, an image in public/, a position's key.
 * Every format is registered on `AJV`, the one Ajv instance LP Ranger
 * compiles a schema with.
 *
 * Two other rules sit beside these and are not repeated here. A value
 * with a range in setting-bounds.json is held to that range, and a value
 * that becomes a timer delay is held to `src/timer-bounds.js`.
 */

const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const { getAddress } = require("ethers");
const validator = require("validator");
const { parseCompositeKey } = require("./composite-key");

const _PUBLIC = path.join(__dirname, "..", "public");

/*-
 *  An RPC endpoint must carry its scheme, because that is what the
 *  provider dials. `require_tld` is off so a node on the operator's own
 *  machine (`http://127.0.0.1:8545`, `https://localhost:8545`) is
 *  accepted; the protocol list is what keeps `javascript:` and the
 *  like out.
 */
const _RPC_URL_OPTS = Object.freeze({
  protocols: ["http", "https"],
  require_protocol: true,
  require_tld: false,
});

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

/**
 * An https address with no trailing slash, as a price service's base url
 * must be: each request is built by adding a path to it.
 */
function isBaseUrl(v) {
  return (
    isText(v) &&
    v.startsWith("https://") &&
    v.length > "https://".length &&
    !v.endsWith("/")
  );
}

/*-
 *  The checks JSON Schema leaves to code, each by the name a schema's
 *  `format` gives it. Each applies to text only; a value of another type
 *  is refused by its schema's `type` first.
 */
const _FORMATS = Object.freeze({
  "http-url": isUrl,
  "http-url-or-none": (v) => v === "" || isUrl(v),
  /*-
   *  A fresh copy of the options each time: `isURL` merges its own
   *  defaults INTO the object it is handed, so the frozen declaration
   *  would make it throw rather than answer.
   */
  "rpc-url": (v) => validator.isURL(v, { ..._RPC_URL_OPTS }),
  "https-base-url": isBaseUrl,
  "eip55-address": isAddress,
  "eip55-address-or-none": (v) => v === "" || isAddress(v),
  "host-name": isHost,
  "iso-time": (v) => validator.isISO8601(v),
  "lower-case": (v) => v === v.toLowerCase(),
  // The dashboard loads a chain's logo from public/ by this name.
  "public-image": (v) => fs.existsSync(path.join(_PUBLIC, v)),
  // A pool factory's address and a position manager's, joined by _.
  "lp-provider-key": (v) => {
    const parts = v.split("_");
    return parts.length === 2 && parts.every(isAddress);
  },
  "position-key": (v) => parseCompositeKey(v) !== null,
});

/*-
 *  Strict, so a schema with a keyword or format Ajv does not know is a
 *  mistake refused as it compiles, not a rule silently skipped; every
 *  error, so a check lists every problem at once; verbose, so each error
 *  carries the schema and the value it is about.
 */
const AJV = new Ajv2020({ strict: true, allErrors: true, verbose: true });
for (const [name, ok] of Object.entries(_FORMATS))
  AJV.addFormat(name, { type: "string", validate: ok });

// The least gas any transaction uses: a plain transfer.
const TRANSFER_GAS = 21000;

/**
 * A kind of value: the words for what passes, its schema carrying those
 * words as its `description`, and the schema compiled.
 */
function kind(what, schema) {
  const described = Object.freeze({ ...schema, description: what });
  return Object.freeze({ what, schema: described, ok: AJV.compile(described) });
}

const _TEXT = { type: "string", minLength: 1 };

/** Every kind the shipped files' values and the app's inputs are held to. */
const KINDS = Object.freeze({
  bool: kind("true or false", { type: "boolean" }),
  text: kind("text", _TEXT),
  textOrNone: kind('text, or "" for none', { type: "string" }),
  count: kind("a whole number of at least 1", { type: "integer", minimum: 1 }),
  ms: kind("a whole number of milliseconds, at least 1", {
    type: "integer",
    minimum: 1,
  }),
  seconds: kind("a whole number of seconds, at least 1", {
    type: "integer",
    minimum: 1,
  }),
  positive: kind("a number above 0", { type: "number", exclusiveMinimum: 0 }),
  usd: kind("a number of dollars, at least 0", { type: "number", minimum: 0 }),
  coins: kind("a number of coins, at least 0", { type: "number", minimum: 0 }),
  // An amount in a token's smallest unit, too large for a number.
  digits: kind("a whole number written in digits", {
    type: "string",
    pattern: "^[0-9]+$",
  }),
  isoTime: kind("a date and time in ISO 8601 form", {
    type: "string",
    format: "iso-time",
  }),
  // A multiplier that scales an estimate or a market price up.
  scalesUp: kind("a number of at least 1", { type: "number", minimum: 1 }),
  // A bump that must outbid the transaction it replaces.
  outbids: kind("a number above 1", { type: "number", exclusiveMinimum: 1 }),
  port: kind("a port number from 1 to 65535", {
    type: "integer",
    minimum: 1,
    maximum: 65535,
  }),
  gasUnits: kind(`a whole number of gas units, at least ${TRANSFER_GAS}`, {
    type: "integer",
    minimum: TRANSFER_GAS,
  }),
  url: kind("an http or https address", { type: "string", format: "http-url" }),
  rpcUrl: kind("a full address beginning http:// or https://", {
    type: "string",
    format: "rpc-url",
  }),
  urlOrNone: kind('an http or https address, or "" for none', {
    type: "string",
    format: "http-url-or-none",
  }),
  baseUrl: kind("an https address without a trailing slash", {
    type: "string",
    format: "https-base-url",
  }),
  address: kind("an EIP-55 address", {
    type: "string",
    format: "eip55-address",
  }),
  addressOrNone: kind('an EIP-55 address, or "" for none', {
    type: "string",
    format: "eip55-address-or-none",
  }),
  scheme: kind("http or https", { enum: ["http", "https"] }),
  positionKey: kind("a position's key, which is chain-wallet-contract-NFT", {
    type: "string",
    format: "position-key",
  }),
  host: kind("a host name", { type: "string", format: "host-name" }),
  image: kind("the name of an image in public/", {
    type: "string",
    format: "public-image",
  }),
  textList: kind("a list of text, not empty", {
    type: "array",
    minItems: 1,
    items: { ..._TEXT, description: "text" },
  }),
  /*-
   *  Matched against a message the classifier lower-cases first, so an
   *  entry with a capital letter in it could never match anything.
   */
  lowerTextList: kind("a list of lower-case text, not empty", {
    type: "array",
    minItems: 1,
    items: { ..._TEXT, format: "lower-case", description: "lower-case text" },
  }),
});

module.exports = {
  KINDS,
  AJV,
  isNumber,
  isText,
  isWhole,
  isUrl,
  isAddress,
  isBaseUrl,
};
