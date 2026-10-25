"use strict";

/**
 * @file util/migration/from-0.9.9/update-099-setting-copies.js
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
 * of its report. The copies are read and written by
 * util/migration/settings-copies.js. Runs on Node built-ins only, like
 * the rest of the migration.
 */

const fs = require("fs");
const path = require("path");
const {
  USER_DIR,
  isGroup,
  readJson,
  writeJson,
  dropKeys,
  migrationOptions,
  updateSettingsCopy,
} = require("../settings-copies");

/** A chain's swap router, an address on its own, made a group. */
function _routerGroup(name, chain, v) {
  const contracts = chain.contracts;
  if (!isGroup(contracts) || typeof contracts.swapRouter !== "string")
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
    .filter(([, chain]) => isGroup(chain))
    .flatMap(([name, chain]) => [
      ..._routerGroup(name, chain, v),
      ...dropKeys(
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
    .filter((t) => isGroup(t) && Object.hasOwn(t, "chain"))
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
    dropKeys(
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
    dropKeys(
      copy,
      ["aggregator"],
      "each chain names its aggregator in chains.json now",
      v,
    ),
  "chains.json": _chainChanges,
  "dust-threshold.json": _dustChanges,
  "setting-labels.json": (copy, v) =>
    dropKeys(
      copy,
      ["checkIntervalSec", "gasStrategy"],
      "the dashboard saves no such setting now",
      v,
    ),
});

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
  if (!isGroup(copy)) return into;
  for (const [k, file] of Object.entries(_UI_SPLIT))
    if (Object.hasOwn(copy, k)) (into[file] ??= {})[k] = copy[k];
  return into;
}

/** Split 0.9.9's ui-defaults.json copy into this release's files. */
function _splitUiDefaults(root, o) {
  const old = path.join(root, USER_DIR, "ui-defaults.json");
  const into = {};
  try {
    const copy = readJson(old);
    if (copy === null) return [];
    Object.assign(into, _uiValuesByFile(copy));
    // A value the operator already set in a new file is kept.
    for (const [file, values] of Object.entries(into))
      into[file] = { ...values, ...readJson(path.join(root, USER_DIR, file)) };
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
    writeJson(path.join(root, USER_DIR, file), values);
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
  const o = migrationOptions(dryRun);
  const lines = Object.entries(_CHANGES).flatMap(([file, change]) =>
    updateSettingsCopy(root, file, change, o),
  );
  return [...lines, ..._splitUiDefaults(root, o)];
}

module.exports = { update099SettingCopies };
