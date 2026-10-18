/**
 * @file src/server-config-route.js
 * @module serverConfigRoute
 * @description
 * `POST /api/config`: the one place a setting an operator saves from Bot
 * Settings becomes config, global or per-position.
 *
 * A request goes through three stages, and their order is the contract:
 *
 *   1. Refuse, or not. Every refusal comes before the first change, so a
 *      refused request leaves no trace: nothing assigned, no provider
 *      rebuilt, no paused bot loop freed. A value the bot cannot use is
 *      refused naming the setting (`invalidValueForKey`, which the
 *      dashboard answers with its "that value was not accepted" dialog);
 *      a position key that is missing, malformed or on another chain is
 *      refused as a malformed request.
 *   2. Apply the global keys, with their effect on the running process
 *      (Moralis on or off, the rpc list), then the position keys to the
 *      one position the key names.
 *   3. Save the file once, and answer with what was applied.
 *
 * Split out of `src/server-routes.js`, which builds this handler and
 * serves it with the rest of its routes.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const sendTx = require("./send-transaction");
const { composeRpcUrls } = require("./rpc-url-list");
const { setServiceEnabled } = require("./api-key-holder");
const { moralisEnabledIn } = require("./server-moralis");
const { getOrCreatePositionConfig, saveConfig } = require("./bot-config-v2");
const { parseCompositeKey } = require("./composite-key");
const { GLOBAL_KEYS, POSITION_KEYS } = require("./bot-config-keys");
const { checkConfigValues } = require("./config-bounds");
const { resolveLiveKey } = require("./server-key-resolver");
const { clearIlGuardWait } = require("./il-guard");
const { positionTag } = require("./position-answer-tag");

/**
 * Clear the aborted state of the position a slippage save is for.
 *
 * A rebalance aborted over excessive swap cost is not tried again until
 * the operator changes that position's Slippage, and saving either of its
 * two rows is that change. The aborted state is stored as
 * `rebalancePaused`. Only the named position is freed: an abort elsewhere
 * has its own cause, a volatile market or a failed re-open among them,
 * which another position's slippage does nothing to answer, and freeing
 * it would set that position rebalancing again or cancel its pending
 * retire.
 *
 * `_retireImmediately` is cleared alongside, for the case where
 * `bot-loop.js`'s re-open-failure path set it: without that, changing
 * Slippage on a stuck-aborted re-open would open the gates and the next
 * poll would still take `drain.js`'s retire branch instead of retrying.
 *
 * Keyed on the two per-token settings, because those are the keys the
 * Slippage rows save. A key no row sends would never fire: an aborted
 * position could then be freed only by a manual rebalance, while the app
 * went on telling the operator that changing Slippage frees it.
 *
 * @param {object} pPatch       The position keys from the body.
 * @param {object} [state]      The named position's bot state, absent
 *   for a position with no running loop.
 * @returns {void}
 */
function _clearSlippagePause(pPatch, state) {
  if (
    pPatch.slippagePctToken0 === undefined &&
    pPatch.slippagePctToken1 === undefined
  )
    return;
  if (!state || !state.rebalancePaused) return;
  state.rebalancePaused = false;
  state.rebalanceError = null;
  state._retireImmediately = false;
}

/**
 * Lift the Impermanent Loss Guard's retry wait for the position a Guard
 * save is for, so its next check decides on the new value. Without it, a
 * rejection under the old value would hold the position for the rest of
 * its wait, up to a week, while the setting showed the new one. Only the
 * named position's wait is lifted, as with a slippage save. A save that
 * clears the setting (`null`) changes the value in force as well.
 *
 * @param {object} pPatch       The position keys from the body.
 * @param {object} [state]      The named position's bot state, absent
 *   for a position with no running loop.
 * @returns {void}
 */
function _clearIlGuardWait(pPatch, state) {
  if (pPatch.impermanentLossGuardPct === undefined) return;
  clearIlGuardWait(state);
}

/**
 * Say why a position key cannot name one of this server's positions, or
 * null when it can. The server runs one chain, and keys every position
 * it manages on it.
 *
 * @param {{blockchain: string}} parsed  A parsed key.
 * @returns {string|null}
 */
function _foreignChainError(parsed) {
  if (parsed.blockchain === config.CHAIN_NAME) return null;
  return (
    `positionKey names chain "${parsed.blockchain}", but this server ` +
    `runs "${config.CHAIN_NAME}"`
  );
}

/**
 * What the value checker needs that only this tier has read: the fee
 * floor the auto-compound threshold may not sit below.
 * @returns {object}
 */
function _valueCheckContext() {
  return {
    compoundMinFeeUsd: config.COMPOUND_MIN_FEE_USD,
  };
}

/**
 * Say why a request must be refused, or null when it may be applied.
 *
 * Run before anything is applied, which is what lets a refusal leave no
 * trace. The two kinds of refusal are told apart for the dashboard: one
 * naming a setting whose VALUE was refused carries `invalidValueForKey`,
 * and the dashboard restores that field; a malformed request does not.
 * An unknown key is no refusal at all: it is simply not copied into
 * either patch.
 *
 * A position key is required only when the request carries a position
 * setting, and it has to name a position on the chain this server runs:
 * its bot reads only slots keyed on that chain, so a key naming another
 * would be saved, answered "saved", and read by nothing — what a tab
 * left open across a restart onto another chain would send.
 *
 * @param {object} body    The request body.
 * @param {object} gPatch  Its global keys.
 * @param {object} pPatch  Its position keys.
 * @returns {{error: string, invalidValueForKey?: string}|null}
 */
function _refusal(body, gPatch, pPatch) {
  const refused = checkConfigValues(
    { ...gPatch, ...pPatch },
    _valueCheckContext(),
  );
  if (refused)
    return { error: refused.message, invalidValueForKey: refused.key };
  if (Object.keys(pPatch).length === 0) return null;
  const parsed = parseCompositeKey(body.positionKey);
  if (!parsed)
    return {
      error:
        "positionKey required for position-specific config " +
        "(blockchain-wallet-contract-tokenId)",
    };
  const foreign = _foreignChainError(parsed);
  return foreign ? { error: foreign } : null;
}

/**
 * Put newly-added RPC endpoints into service without a restart.
 *
 * Composed the same way `config.js` composes `RPC_URLS`: the
 * operator's endpoints first (newest added first), the shipped ones
 * behind them as failover, duplicates dropped. Composed from
 * `config.RPC_URLS_BASE` — the shipped-plus-env list — rather than
 * from `config.RPC_URLS`, which already contains previously added
 * entries and would re-seed them on every save.
 *
 * `config.setRpcUrls` updates the live list as well as `sendTx`, and
 * both halves are load-bearing:
 *
 *   - `GET /api/rpc-endpoints`, `rebalancer-pools` and
 *     `server-can-reopen` read `config.RPC_URLS` directly, so without
 *     it they keep walking the endpoints the process started with;
 *   - `sendTx.init` THROWS when called again with a different list,
 *     and `bot-loop.js` / `position-manager.js` call it on every
 *     position start. Updating only `sendTx` would leave
 *     `config.RPC_URLS` stale, so the next Manage would hand `init` a
 *     list that no longer matches and take down the start path.
 *
 * Neither is optional; do not "simplify" this to one call.
 *
 * Failures are logged, not thrown: the value is already saved, and a
 * bad URL must not take down the config endpoint. The next restart
 * picks it up regardless.
 * @param {string[]} saved  The operator-added endpoints just saved.
 */
function _applyRpcUrls(saved) {
  try {
    const urls = composeRpcUrls({
      saved,
      chainUrls: config.RPC_URLS_BASE,
    });
    config.setRpcUrls(urls);
    if (sendTx.setRpcUrls(urls))
      log.info("[server] RPC now in use: %s", urls[0]);
  } catch (err) {
    log.warn("[server] Could not apply the new RPC list: %s", err.message);
  }
}

/**
 * Build the `POST /api/config` handler.
 *
 * @param {object} deps
 * @param {object} deps.diskConfig  The loaded bot-config.json, saved here.
 * @param {object} deps.positionMgr  For resolving a key a rebalance moved.
 * @param {Function} deps.jsonResponse  `(res, status, body) => void`.
 * @param {Function} deps.readJsonBody  `(req) => Promise<object>`.
 * @param {Function} deps.getAllPositionBotStates  Per-position bot states,
 *   a Map keyed by composite key.
 * @returns {Function} `(req, res) => Promise<void>`.
 */
function createConfigRouteHandler(deps) {
  const {
    diskConfig,
    positionMgr,
    jsonResponse,
    readJsonBody,
    getAllPositionBotStates,
  } = deps;

  /**
   * Apply the global keys, and their effect on the running process.
   * @param {object} gPatch
   */
  function _applyGlobal(gPatch) {
    Object.assign(diskConfig.global, gPatch);
    /*-
     *  Same null-sweep the per-position patch gets, and for the same
     *  reason: `null` means "clear this setting", and assigning it
     *  leaves a literal `null` on disk instead. Global keys reach this
     *  now that an empty Bot Settings field is sent as `null` — Max Gas
     *  Fee and Approval Multiple are both global. Their readers do cope
     *  with a stored `null`, so this is about what the file says, not
     *  about what the bot does.
     */
    for (const k of Object.keys(gPatch))
      if (gPatch[k] === null) delete diskConfig.global[k];
    /*-
     *  Applied to the in-memory holder as well as saved, so the running
     *  process stops calling Moralis on the next price lookup rather
     *  than at the next restart. A cleared choice leaves the default.
     */
    if (gPatch.moralisEnabled !== undefined)
      setServiceEnabled("moralis", moralisEnabledIn(diskConfig.global));
    // The same for the rpc list: rebuild the providers now.
    if (gPatch.rpcUrls !== undefined) _applyRpcUrls(gPatch.rpcUrls);
  }

  /**
   * Apply the position keys to the position the request names.
   * @param {string} positionKey  The key the request carried, checked.
   * @param {object} pPatch
   * @returns {string} The key the values were saved under: the request's,
   *   or the one a rebalance moved it to.
   */
  function _applyPosition(positionKey, pPatch) {
    /*-
     *  Resolve to the LIVE composite key. The user's POST carries a key
     *  captured from a recent dashboard poll, and a parallel rebalance
     *  may have migrated the key out from under it. resolveLiveKey
     *  returns the post-migration key when the bot state's
     *  rebalanceEvents show a chain from the original tokenId, else the
     *  original key (for stopped positions, disk is source of truth and
     *  can't migrate).
     */
    const states = getAllPositionBotStates();
    const liveKey = resolveLiveKey(positionMgr, positionKey, (k) =>
      states.get(k),
    );
    _clearSlippagePause(pPatch, states.get(liveKey));
    _clearIlGuardWait(pPatch, states.get(liveKey));
    /*-
     *  Lazy-create the slot so per-position settings can be saved for a
     *  position that has not yet been Manage'd. The user's workflow:
     *  select an unmanaged position, edit OOR threshold / slippage /
     *  etc., Save, THEN click Manage — the live `addManagedPosition`
     *  only flips `status` to "running" and preserves every other field,
     *  so the user's pre-Manage edits carry through into the running
     *  bot's config. The phantom-slot risk (a POST to a dead old key
     *  after a rebalance migrated it) is what `resolveLiveKey` above
     *  answers.
     */
    const posRef = getOrCreatePositionConfig(diskConfig, liveKey);
    const statusBefore = posRef.status;
    Object.assign(posRef, pPatch);
    /*-
     *  Null-sweep: a position key sent as `null` means "clear this
     *  setting". Without it, `Object.assign` above stamps a literal
     *  `null` on disk. Deletes only when the client explicitly sent
     *  `null`; a key the body left out is `undefined` and was never
     *  copied into the patch.
     */
    for (const k of Object.keys(pPatch))
      if (pPatch[k] === null) delete posRef[k];
    if (statusBefore && !posRef.status)
      log.warn(
        "[api/config] status WIPED for %s! pPatch keys: %s",
        liveKey.slice(-10),
        Object.keys(pPatch).join(", "),
      );
    if (pPatch.offsetToken0Pct !== undefined)
      log.info(
        "[offset-trace] POST /api/config key=%s offsetToken0Pct=%d",
        liveKey.slice(-10),
        pPatch.offsetToken0Pct,
      );
    return liveKey;
  }

  return async function handleApiConfig(req, res) {
    const body = await readJsonBody(req);
    const gPatch = {},
      pPatch = {};
    for (const k of GLOBAL_KEYS) if (body[k] !== undefined) gPatch[k] = body[k];
    for (const k of POSITION_KEYS)
      if (body[k] !== undefined) pPatch[k] = body[k];
    /*-
     *  Every answer names the position it is about, so a dashboard that
     *  has moved to another position since it asked can tell the answer
     *  is not for the one on screen.
     */
    const tag = positionTag(body.positionKey);
    const refusal = _refusal(body, gPatch, pPatch);
    if (refusal) {
      jsonResponse(res, 400, { ok: false, ...refusal, ...tag });
      return;
    }
    _applyGlobal(gPatch);
    const liveKey =
      Object.keys(pPatch).length > 0
        ? _applyPosition(body.positionKey, pPatch)
        : undefined;
    saveConfig(diskConfig);
    jsonResponse(res, 200, {
      ok: true,
      applied: { ...gPatch, ...pPatch },
      ...positionTag(body.positionKey, liveKey),
    });
  };
}

module.exports = { createConfigRouteHandler };
