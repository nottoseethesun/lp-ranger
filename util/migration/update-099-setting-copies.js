"use strict";

/**
 * @file util/migration/update-099-setting-copies.js
 * @description
 * A migration step: bring the operator's copies of the shipped settings
 * files, as release 0.9.9 laid them out, up to this release's layout.
 *
 * An operator overrides a shipped settings file by putting a copy of it,
 * whole or in part, in `app-config/user-configurable/`; 0.9.9's README
 * suggested copying the whole file. This release checks every copy
 * against its file's JSON Schema at startup, so a key 0.9.9 read and
 * this release does not would stop the server. This step makes each
 * change this release made to a file 0.9.9 shipped:
 *
 *   - bot-config-defaults.json: the ranges of the gas fee limit and the
 *     Impermanent Loss Guard moved to setting-bounds.json, which no copy
 *     overrides, so their four keys come out;
 *   - app-runtime.json: the aggregator moved to each chain's entry in
 *     chains.json, and takes no api key, so the `aggregator` group comes
 *     out;
 *   - chains.json: each chain's swap router became a group holding its
 *     address and name, so an address on its own moves into one, and the
 *     aggregator's `blockchain`, now part of its url, comes out;
 *   - dust-threshold.json: each price-source token's `chain` is now
 *     named `moralisChain`;
 *   - setting-labels.json: the labels of two settings the dashboard no
 *     longer saves come out;
 *   - ui-defaults.json split in three: the dialog height moves to
 *     ui-defaults_layout.json, and the first-visit settings to
 *     ui-defaults_non-layout_for-server-up-scenario.json. A value the
 *     operator already set in a new file is kept.
 *
 * Every file it changes is copied into `tmp/` first, and ui-defaults.json
 * is moved there, so each change can be undone. Each change is one line
 * of its report. Runs on Node built-ins only, like the rest of the
 * migration.
 */

const fs = require("fs");
const path = require("path");

const _USER = path.join("app-config", "user-configurable");

/** Whether `v` is a plain object. */
const _isGroup = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Read a JSON file, or null when there is none. */
function _readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text);
}

/** Write a JSON file atomically. */
function _writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(file + ".tmp", file);
}

/**
 * Take `keys` out of `group`, a line for each one taken. `at` names the
 * group in the file, and `v` gives the verb: done, or would be done.
 */
function _drop(group, keys, why, v, at = "") {
  if (!_isGroup(group)) return [];
  return keys
    .filter((k) => Object.hasOwn(group, k))
    .map((k) => {
      delete group[k];
      return `${v("removed", "would remove")} ${at}${k}: ${why}`;
    });
}

/** A chain's swap router, an address on its own, made a group. */
function _routerGroup(name, chain, v) {
  const contracts = chain.contracts;
  if (!_isGroup(contracts) || typeof contracts.swapRouter !== "string")
    return [];
  contracts.swapRouter = { address: contracts.swapRouter };
  return [
    `${v("moved", "would move")} ${name}.contracts.swapRouter into a ` +
      "group: its address, and the router's name from the shipped file",
  ];
}

/** Each chain's changes. */
function _chainChanges(copy, v) {
  return Object.entries(copy)
    .filter(([, chain]) => _isGroup(chain))
    .flatMap(([name, chain]) => [
      ..._routerGroup(name, chain, v),
      ..._drop(
        chain.aggregator,
        ["blockchain"],
        "the aggregator's url carries the chain now",
        v,
        `${name}.aggregator.`,
      ),
    ]);
}

/** Each price-source token's `chain`, named `moralisChain`. */
function _dustChanges(copy, v) {
  const tokens = Array.isArray(copy.priceSourceTokens)
    ? copy.priceSourceTokens
    : [];
  return tokens
    .filter((t) => _isGroup(t) && Object.hasOwn(t, "chain"))
    .map((t) => {
      if (!Object.hasOwn(t, "moralisChain")) t.moralisChain = t.chain;
      delete t.chain;
      return `${v("renamed", "would rename")} ${t.symbol}'s chain to moralisChain`;
    });
}

/*-
 *  Each change to a file 0.9.9 shipped, over an operator's copy of it:
 *  the copy changed in place, and a line for each change.
 */
const _CHANGES = Object.freeze({
  "bot-config-defaults.json": (copy, v) =>
    _drop(
      copy,
      [
        "gasFeePctMin",
        "gasFeePctMax",
        "impermanentLossGuardPctMin",
        "impermanentLossGuardPctMax",
      ],
      "its range is in setting-bounds.json now, which no copy overrides",
      v,
    ),
  "app-runtime.json": (copy, v) =>
    _drop(
      copy,
      ["aggregator"],
      "each chain names its aggregator in chains.json now",
      v,
    ),
  "chains.json": _chainChanges,
  "dust-threshold.json": _dustChanges,
  "setting-labels.json": (copy, v) =>
    _drop(
      copy,
      ["checkIntervalSec", "gasStrategy"],
      "the dashboard saves no such setting now",
      v,
    ),
});

/** Copy `file` into the install's `tmp/`, before it is changed. */
function _keepCopy(root, file, stamp) {
  const name = path.basename(file, ".json");
  const copy = path.join(root, "tmp", `${name}.pre-migration-${stamp}.json`);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(file, copy);
  return `kept a copy of the old ${path.basename(file)} at tmp/${path.basename(copy)}`;
}

/** One copy's changes, made unless this is a dry run. */
function _updateCopy(root, file, change, o) {
  const at = path.join(root, _USER, file);
  let copy;
  try {
    copy = _readJson(at);
  } catch (err) {
    return [`${file}: not valid JSON (${err.message}); left as it was`];
  }
  if (!_isGroup(copy)) return [];
  const lines = change(copy, o.verb).map((l) => `${file}: ${l}`);
  if (lines.length === 0 || o.dryRun) return lines;
  lines.push(_keepCopy(root, at, o.stamp));
  _writeJson(at, copy);
  return lines;
}

/*-
 *  Where each of 0.9.9's ui-defaults.json settings lives now. Any other
 *  key, which 0.9.9 did not read either, stays in the copy kept in tmp/.
 */
const _LAYOUT = "ui-defaults_layout.json";
const _SERVER_UP = "ui-defaults_non-layout_for-server-up-scenario.json";
const _UI_SPLIT = Object.freeze({
  dialogMaxHeightPx: _LAYOUT,
  soundsEnabled: _SERVER_UP,
  privacyModeEnabled: _SERVER_UP,
  privacyBlurWalletAddresses: _SERVER_UP,
  privacyBlurUsdAmounts: _SERVER_UP,
  privacyUsdAmountThreshold: _SERVER_UP,
});

/** The values of 0.9.9's ui-defaults.json, by the file each moves to. */
function _uiValuesByFile(copy) {
  const into = {};
  if (!_isGroup(copy)) return into;
  for (const [k, file] of Object.entries(_UI_SPLIT))
    if (Object.hasOwn(copy, k)) (into[file] ??= {})[k] = copy[k];
  return into;
}

/** Split 0.9.9's ui-defaults.json copy into this release's files. */
function _splitUiDefaults(root, o) {
  const old = path.join(root, _USER, "ui-defaults.json");
  const into = {};
  try {
    const copy = _readJson(old);
    if (copy === null) return [];
    Object.assign(into, _uiValuesByFile(copy));
    // A value the operator already set in a new file is kept.
    for (const [file, values] of Object.entries(into))
      into[file] = { ...values, ..._readJson(path.join(root, _USER, file)) };
  } catch (err) {
    return [
      `ui-defaults.json: a file it splits into is not valid JSON ` +
        `(${err.message}); left as it was`,
    ];
  }
  const lines = Object.keys(into).map(
    (file) =>
      `ui-defaults.json: ${o.verb("moved", "would move")} its settings to ${file}`,
  );
  if (o.dryRun)
    return [...lines, "ui-defaults.json: would move it to tmp/, unread now"];
  for (const [file, values] of Object.entries(into))
    _writeJson(path.join(root, _USER, file), values);
  const kept = path.join(
    root,
    "tmp",
    `ui-defaults.pre-migration-${o.stamp}.json`,
  );
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.renameSync(old, kept);
  return [
    ...lines,
    `ui-defaults.json: moved it to tmp/${path.basename(kept)}, since this release reads it no more`,
  ];
}

/**
 * Bring the install's copies of 0.9.9's settings files up to this
 * release's layout.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would change, and change nothing.
 * @returns {string[]}  One line for each change, or none.
 */
function update099SettingCopies({ root, dryRun }) {
  const o = {
    dryRun,
    stamp: new Date().toISOString().replace(/[:.]/g, "-"),
    verb: (done, would) => (dryRun ? would : done),
  };
  const lines = Object.entries(_CHANGES).flatMap(([file, change]) =>
    _updateCopy(root, file, change, o),
  );
  return [...lines, ..._splitUiDefaults(root, o)];
}

module.exports = { update099SettingCopies };
