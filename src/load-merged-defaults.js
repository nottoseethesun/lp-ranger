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
 * Each file is read once and the parsed result is kept for the life of
 * the process, frozen all the way down.  Every file loaded here is
 * operator-tunable plumbing documented as taking effect on restart, and
 * its readers include a poll cycle and per-request paths; caching here
 * rather than in each reader is what gives that guarantee to readers
 * not yet written.  `_resetMemoForTests` is how a test stands in for
 * the restart.
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

/**
 * Absolute path to the per-install user-overrides directory.
 *
 * `LP_RANGER_USER_CONFIG_DIR` redirects it, and exists for the tests
 * alone — nothing ships that sets it, and an operator has no reason to.
 * The tests need it because this directory is ONE directory shared by
 * every process on the machine, while the test runner starts a separate
 * process per file and runs 24 at once. A test that writes a deliberately
 * bad override here to prove the reader refuses it is, for as long as
 * that file exists, corrupting the config of 23 unrelated test processes
 * — and one of them requiring `src/config.js` in that window takes the
 * startup throw and fails for a reason that has nothing to do with it.
 * That is a real intermittent, seen once in CI and not reproducible on
 * demand. Pointing each such test at its own directory removes the
 * shared resource rather than narrowing the window.
 *
 * Read once, at module load: the path a process reads its config from
 * must not change underneath it mid-run.
 */
const USER_DIR = process.env.LP_RANGER_USER_CONFIG_DIR
  ? path.resolve(process.env.LP_RANGER_USER_CONFIG_DIR)
  : path.join(_APP_CONFIG_DIR, "user-configurable");

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
/*- One read per file, held for the life of the process.
 *
 *  Every config file this loads is operator-tunable plumbing that the
 *  docs describe as taking effect on restart, and its readers include a
 *  poll cycle and per-request paths. Memoizing here rather than in each
 *  reader is what makes that true for readers not yet written: a new
 *  one gets the guarantee by calling this, without having to remember
 *  to cache. Results are frozen because callers now share one object.
 *  `_deepMerge` is pure, so a frozen shipped default is safe as its
 *  left-hand side. */
const _merged = new Map();
const _shipped = new Map();

/**
 * Freeze a config object and everything under it.
 *
 * Shallow freezing would leave the nested objects — `chains.json`'s
 * `rpc`, `contracts` and `aggregator` among them — writable and, now
 * that one object is handed to every caller, shared. A single stray
 * assignment would then change that value for the whole process, for
 * its whole life, silently and from anywhere. Freezing all the way
 * down turns that into a throw at the assignment.
 *
 * Costs one recursive walk per file, once.
 *
 * @param {*} node
 * @returns {*} The same node, frozen.
 */
function _freezeDeep(node) {
  if (node && typeof node === "object" && !Object.isFrozen(node)) {
    Object.freeze(node);
    for (const value of Object.values(node)) _freezeDeep(value);
  }
  return node;
}

function loadMergedDefaults(filename) {
  if (_merged.has(filename)) return _merged.get(filename);
  const defaults = _readDefaults(filename);
  const user = _readUserOverride(filename);
  const out = _freezeDeep(
    user === undefined ? defaults : _deepMerge(defaults, user),
  );
  _merged.set(filename, out);
  return out;
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
  if (_shipped.has(filename)) return _shipped.get(filename);
  const out = _freezeDeep(_readDefaults(filename));
  _shipped.set(filename, out);
  return out;
}

/** Forget every memoized file, so the next read goes to disk (tests only). */
function _resetMemoForTests() {
  _merged.clear();
  _shipped.clear();
}

module.exports = {
  loadMergedDefaults,
  loadShippedDefaults,
  _resetMemoForTests,
  DEFAULTS_DIR,
  USER_DIR,
};
