/**
 * @file dashboard-config-save.js
 * @description The one path a Bot Settings value takes to the server,
 * and the one way a refused value comes back.
 *
 * The browser does not decide whether a value is acceptable. Every
 * control sends what the operator typed; `src/config-bounds.js` on the
 * server decides, and answers 400 with `invalidValueForKey` naming the
 * setting it refused. This module reads that answer, puts the field
 * back to the value the server last accepted, and says why.
 *
 * Before this existed each control had its own opinion — four quietly
 * rewrote what was typed and saved the rewrite, three refused with no
 * message, the rest each raised a modal of their own wording — and
 * none of it applied to a request that did not come from the form.
 *
 * Depends on: dashboard-helpers.js.
 */

import { g, fetchWithCsrf } from "./dashboard-helpers.js";
import { isAnswerForPositionOnScreen } from "./dashboard-answer-position.js";
import { log } from "./dashboard-log.js";

/*- The value each Bot Settings input last held that the server
 *  accepted, so a rejected save can put the field back to it. Seeded by
 *  `rememberGoodInput` when the panel populates from `/api/status`, and
 *  updated on every save the server takes. */
const _lastGoodByInput = new Map();

/**
 * Record what an input currently shows as a value the server accepts.
 *
 * @param {string} inputId
 * @param {*} value
 * @returns {void}
 */
export function rememberGoodInput(inputId, value) {
  if (value !== undefined && value !== null)
    _lastGoodByInput.set(inputId, String(value));
}

/**
 * Put a refused field back to its last accepted value, and say what to
 * tell the operator.
 *
 * Exported so the decision can be driven directly by a test —
 * `fetchWithCsrf` goes through the global `fetch`, which a test must
 * not replace. The dialog itself stays with the caller.
 *
 * @param {string} inputId
 * @param {string} key     The setting that was being saved.
 * @param {object} body    The server's response body.
 * @returns {string|null}  The dialog text, or null to say nothing —
 *   which is the answer whenever the 400 was about the request rather
 *   than the value, such as no position being selected.
 */
export function _applySaveRejection(inputId, key, body) {
  if (!body || body.invalidValueForKey !== key) return null;
  const prior = _lastGoodByInput.get(inputId);
  const el = g(inputId);
  if (el && prior !== undefined) el.value = prior;
  return `That value was not accepted:\n\n${
    body.error || "It is outside the allowed range."
  }\n\nThe field has been set back to ${
    prior === undefined ? "its previous value" : prior
  }. Edit it and save again if you like.`;
}

/*- An empty field parses to `NaN`, and `JSON.stringify` would turn that
 *  into `null` on its own. Doing it here says so out loud, because
 *  `null` is not nothing to the server: it is how a setting is CLEARED,
 *  back to the shipped default. Saving an empty box therefore removes
 *  the override rather than refusing — which is what an empty box
 *  means, and the one reading that leaves no setting the operator
 *  cannot undo from the form they set it in. */
function _clearEmpties(values) {
  const out = {};
  for (const [key, value] of Object.entries(values))
    out[key] = typeof value === "number" && Number.isNaN(value) ? null : value;
  return out;
}

/*- Which input, if any, holds each key being saved. A save that carries
 *  several keys can then restore the one the server named rather than
 *  all of them. */
function _restoreRefusedField(inputs, body) {
  for (const [key, inputId] of Object.entries(inputs || {})) {
    const message = _applySaveRejection(inputId, key, body);
    if (message) return message;
  }
  return null;
}

/**
 * Save one or more config values, and handle a refusal.
 *
 * @param {object} o
 * @param {object} o.values            Config keys to write.
 * @param {string} [o.positionKey]     Required for position-specific keys.
 * @param {object} [o.inputs]          Config key → input element id, so a
 *   refused value can be put back where it came from.
 * @param {Function} [o.onSaved]       Ran only once the server has taken
 *   it, so nothing reports success the server refused. Passed whether
 *   the answer is for the position on screen, so it can leave the
 *   screen alone when it is not.
 * @returns {Promise<{saved: boolean, onScreen: boolean}>}  Whether it
 *   saved, and whether the position it was saved for is still the one
 *   on screen, for what the caller does to the screen after it.
 */
export async function saveConfigValues({
  values,
  positionKey,
  inputs,
  onSaved,
}) {
  let res;
  try {
    res = await fetchWithCsrf("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ..._clearEmpties(values), positionKey }),
    });
  } catch {
    /*- Dashboard-only mode, or the server went away mid-edit. Nothing
     *  was saved and nothing was refused, so the field stands. */
    return { saved: false, onScreen: _onScreenFor(null, positionKey) };
  }
  const body = await res.json().catch(() => ({}));
  const settled = _settleSaveAnswer({
    ok: res.ok,
    status: res.status,
    body,
    values,
    positionKey,
    inputs,
    onSaved,
  });
  if (settled.message) alert(settled.message);
  return { saved: settled.saved, onScreen: settled.onScreen };
}

/**
 * A position's save that answers after the operator has moved to
 * another position is not this screen's: the fields on screen are the
 * other position's. A save of global settings is every screen's.
 */
function _onScreenFor(answer, positionKey) {
  return (
    typeof positionKey !== "string" ||
    isAnswerForPositionOnScreen(answer, positionKey)
  );
}

/**
 * What the answer to a save does, once it has arrived: whether it is
 * for the position on screen, the fields it remembers or puts back, and
 * the dialog to show.
 *
 * Exported so a test can drive it with an answer of its own: the request
 * itself goes through the global `fetch`, which a test must not replace.
 *
 * @param {object} o
 * @param {boolean} o.ok        Whether the server took the values.
 * @param {number} o.status     The answer's HTTP status.
 * @param {object} o.body       The answer's body.
 * @param {object} o.values     The values sent.
 * @param {string} [o.positionKey]  The key the request named.
 * @param {object} [o.inputs]   As for `saveConfigValues`.
 * @param {Function} [o.onSaved]  As for `saveConfigValues`.
 * @returns {{saved: boolean, onScreen: boolean, message: string|null}}
 *   `message` is the dialog's text, or null to show none.
 */
export function _settleSaveAnswer({
  ok,
  status,
  body,
  values,
  positionKey,
  inputs,
  onSaved,
}) {
  const onScreen = _onScreenFor(body, positionKey);
  if (!onScreen)
    log.info(
      "[lp-ranger] [config] the answer to a save for %s came after the screen moved to another position, so it is left off the screen: %s",
      body?.positionKey ?? positionKey,
      ok ? "saved" : body?.error || "HTTP " + status,
    );
  if (ok) {
    if (onScreen)
      for (const [key, inputId] of Object.entries(inputs || {}))
        rememberGoodInput(inputId, values[key]);
    if (onSaved) onSaved(onScreen);
    return { saved: true, onScreen, message: null };
  }
  if (!onScreen) return { saved: false, onScreen, message: null };
  /*- The server refuses a value it cannot run on rather than quietly
   *  correcting it, so put the field back to what was last accepted and
   *  say why. The operator can edit and save again.
   *
   *  Only for a rejected VALUE, which `invalidValueForKey` marks. This
   *  route also 400s on a malformed request — no position selected,
   *  most often — and that is not something to show a dialog about,
   *  nor a reason to touch what they typed. */
  return {
    saved: false,
    onScreen,
    message: _restoreRefusedField(inputs, body),
  };
}
