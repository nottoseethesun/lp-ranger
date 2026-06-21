/**
 * @file src/load-merged-defaults.js
 * @module loadMergedDefaults
 * @description
 * Two-layer config loader for the layered-override pattern:
 *
 *   1. Shipped defaults live under `app-config/app-defaults-for-user-configurable/`
 *      (tracked by git, overwritten on every tarball upgrade).
 *   2. Per-install user overrides live under `app-config/user-configurable/`
 *      (gitignored — preserved across tarball upgrades).
 *
 * Filenames in the two directories match 1:1.  When a consumer asks for
 * a tunable file, this module reads the shipped defaults first, then
 * (if a matching user file exists) deep-merges the user file on top
 * with user values winning on every key.  Arrays REPLACE rather than
 * merge — merging arrays at the index level is rarely what callers
 * want.
 *
 * The shipped defaults file is REQUIRED — a missing or malformed
 * defaults file throws because that means the install is broken.  The
 * user override is OPTIONAL — its absence is the normal case (the user
 * accepts every default).  A malformed user file logs a warning and
 * falls back to the shipped defaults so a hand-edit typo never bricks
 * the install.
 *
 * No caching — each call hits the disk.  Callers that want caching
 * implement it themselves (most existing consumers already cache the
 * parsed object at module-load time).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { log } = require("./log");

const _APP_CONFIG_DIR = path.join(__dirname, "..", "app-config");

/** Absolute path to the shipped-defaults directory. */
const DEFAULTS_DIR = path.join(
  _APP_CONFIG_DIR,
  "app-defaults-for-user-configurable",
);

/** Absolute path to the per-install user-overrides directory. */
const USER_DIR = path.join(_APP_CONFIG_DIR, "user-configurable");

/*- Recursively strip top-level and nested keys beginning with `_`
 *  before returning the parsed JSON to callers.  JSON has no comment
 *  syntax; the project-wide convention is `_comment`-prefixed keys
 *  carry documentation that no consumer wants in the data flow.
 *  Returns a fresh object; arrays and primitives pass through
 *  unchanged. */
function _stripDocKeys(node) {
  if (Array.isArray(node)) return node.map(_stripDocKeys);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("_")) continue;
    out[k] = _stripDocKeys(v);
  }
  return out;
}

/*- Deep-merge `user` on top of `defaults`.  Plain-object branches
 *  recurse; arrays REPLACE; everything else takes the user value when
 *  present.  Returns a fresh object — neither argument is mutated. */
function _deepMerge(defaults, user) {
  if (user === undefined) return defaults;
  if (user === null) return null;
  if (Array.isArray(user)) return [...user];
  if (typeof user !== "object") return user;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return { ...user };
  }
  const out = { ...defaults };
  for (const [key, val] of Object.entries(user)) {
    out[key] = _deepMerge(defaults[key], val);
  }
  return out;
}

/*- Read + parse the shipped defaults file.  Throws with a clear
 *  message on either read or parse failure — these are install errors
 *  and should fail loudly. */
function _readDefaults(filename) {
  const p = path.join(DEFAULTS_DIR, filename);
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(
      `[load-merged-defaults] Cannot read shipped defaults at ${p}: ` +
        err.message,
      { cause: err },
    );
  }
  try {
    return _stripDocKeys(JSON.parse(raw));
  } catch (err) {
    throw new Error(
      `[load-merged-defaults] Malformed shipped defaults JSON at ${p}: ` +
        err.message,
      { cause: err },
    );
  }
}

/*- Read + parse the optional user override file.  Returns `undefined`
 *  if the file is absent (normal case).  A read or parse failure logs
 *  a warning and returns `undefined` so the consumer falls back to
 *  shipped defaults — a hand-edit typo must never brick the install. */
function _readUserOverride(filename) {
  const p = path.join(USER_DIR, filename);
  if (!fs.existsSync(p)) return undefined;
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    log.warn(
      "[load-merged-defaults] Cannot read user override %s: %s — " +
        "falling back to shipped defaults",
      p,
      err.message,
    );
    return undefined;
  }
  try {
    return _stripDocKeys(JSON.parse(raw));
  } catch (err) {
    log.warn(
      "[load-merged-defaults] Malformed user override JSON at %s: %s — " +
        "falling back to shipped defaults",
      p,
      err.message,
    );
    return undefined;
  }
}

/**
 * Read the shipped defaults for `filename` and deep-merge any
 * matching user override on top.  User values win.  Throws when the
 * shipped defaults file is missing or malformed.  Logs and falls
 * back to shipped defaults on user-file read/parse errors.
 * @param {string} filename  Bare filename, e.g. `"chains.json"`.
 * @returns {object}  The merged config object.
 */
function loadMergedDefaults(filename) {
  const defaults = _readDefaults(filename);
  const user = _readUserOverride(filename);
  if (user === undefined) return defaults;
  return _deepMerge(defaults, user);
}

/**
 * Read ONLY the shipped defaults for `filename` (no user overlay).
 * Use this for the trustworthy baseline that consumers fall back to
 * when an operator's live user-override value fails per-key
 * validation.  Throws when the shipped defaults file is missing or
 * malformed — same install-error semantics as `loadMergedDefaults`.
 * @param {string} filename  Bare filename, e.g. `"chains.json"`.
 * @returns {object}  The shipped-defaults object.
 */
function loadShippedDefaults(filename) {
  return _readDefaults(filename);
}

module.exports = {
  loadMergedDefaults,
  loadShippedDefaults,
  DEFAULTS_DIR,
  USER_DIR,
};
