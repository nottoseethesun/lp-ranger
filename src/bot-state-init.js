/**
 * @file src/bot-state-init.js
 * @module bot-state-init
 * @description
 * Tiny helpers that initialize fields on `botState` at the start of
 * `startBotLoop`.  Extracted from `src/bot-loop.js` to keep that file
 * under the 500-line cap and to give the wiring contract a small
 * testable surface.
 */

"use strict";

/**
 * Wire the disk-config reader onto `botState` so callers reached via
 * `botState` (not `pollCycle.deps`) can read persisted config — notably
 * `_scanLifetimePoolData` in bot-recorder-lifetime.js, whose
 * disk-as-source-of-truth gate against stomping `totalCompoundedUsd`
 * and `totalLifetimeDepositUsd` needs to read the persisted values.
 * Without this, `botState._getConfig` was always undefined and the
 * gate never tripped.
 *
 * Pure: returns the bound reader function.  Tests can call this in
 * isolation to assert the wire-up exists without standing up a full
 * `startBotLoop` mock surface.
 *
 * @param {object}    botState  The per-position state object.
 * @param {object}    opts      `startBotLoop` opts.
 * @param {Function} [opts.getConfig]  Disk-config reader; defaults to a
 *   no-op that returns `undefined` for any key.
 * @returns {Function}  The same reader function now bound to
 *   `botState._getConfig`.
 */
function wireBotStateGetConfig(botState, opts) {
  const gc = opts.getConfig || (() => undefined);
  botState._getConfig = gc;
  return gc;
}

module.exports = { wireBotStateGetConfig };
