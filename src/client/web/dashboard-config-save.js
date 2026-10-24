/**
 * @file dashboard-config-save.js
 * @description The one path a Bot Settings value takes to the server,
 * and the one way a refused value comes back.
 *
 * The browser does not decide whether a value is acceptable. Every
 * control sends what the operator typed; `src/lib/config-bounds.js` on the
 * server decides, and answers 400 with `invalidValueForKey` naming the
 * setting it refused. This module reads that answer, empties the field,
 * asks the server for the position on screen and fills the field from
 * that answer, as when the position came on screen, and says why.
 *
 * The browser keeps no copy of a value the server accepted. The server
 * is the only home of a saved setting, and a copy kept by field could
 * be another position's: switch from a position with a saved value to
 * one without, type a value the server refuses, and the copy would put
 * the first position's value in the field, for a second Save to store.
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
import { clearInputDirty } from "./dashboard-data-cache.js";
import { log } from "./dashboard-log.js";

/*-
 *  How the panel fills its boxes again from the server's answer about
 *  the position on screen: announced by dashboard-data.js, which owns
 *  those fills, as it loads.
 */
let _refill = null;

/**
 * Announce how the panel fills its boxes again from the server.
 *
 * @param {() => Promise<void>} refill  Asks the server about the
 *   position on screen and fills the boxes from its answer; settled once
 *   that answer is applied.
 * @returns {void}
 */
export function announceRefill(refill) {
  _refill = refill;
}

/**
 * Fill a refused field from the server, and say what to tell the
 * operator.
 *
 * The field is emptied and its edit forgotten first, so the panel's fill
 * writes what the server holds into it. A form the panel does not fill
 * fills itself in `onRefused`, from the same answer.
 *
 * Exported so a test can drive it with a refill of its own: the request
 * goes through the global `fetch`, which a test must not replace.
 *
 * @param {{inputId: string, error?: string}} refused  The field, and the
 *   server's reason.
 * @param {() => *} [onRefused]  A form's own fill, after the panel's.
 * @returns {Promise<string>}  The dialog text.
 */
export async function _refillRefused({ inputId, error }, onRefused) {
  const el = g(inputId);
  if (el) el.value = "";
  clearInputDirty(inputId);
  if (_refill !== null) await _refill();
  if (onRefused) await onRefused();
  const shown = g(inputId)?.value ?? "";
  return `That value was not accepted:\n\n${
    error || "It is outside the allowed range."
  }\n\nNothing was saved, and the value in force for this position stands${
    shown === "" ? "" : `: ${shown}`
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

/*-
 *  The field holding the value the server refused, if it is one of this
 *  save's: a request can carry several keys, and only the one the server
 *  named goes back. Null for a 400 about the request rather than a value
 *  (no position selected, most often), which raises no dialog and leaves
 *  what the operator typed alone.
 */
function _refusedField(inputs, body) {
  const key = body?.invalidValueForKey;
  const inputId = typeof key === "string" ? inputs?.[key] : undefined;
  return inputId === undefined ? null : { inputId, error: body.error };
}

/**
 * Save one or more config values, and handle a refusal.
 *
 * @param {object} o
 * @param {object} o.values            Config keys to write.
 * @param {string} [o.positionKey]     Required for position-specific keys.
 * @param {object} [o.inputs]          Config key → input element id, so a
 *   refused value's field can be filled from the server.
 * @param {Function} [o.onSaved]       Ran only once the server has taken
 *   it, so nothing reports success the server refused. Passed whether
 *   the answer is for the position on screen, so it can leave the
 *   screen alone when it is not.
 * @param {Function} [o.onRefused]     For a form the panel does not fill:
 *   fills its fields from the server's answer after a refusal.
 * @returns {Promise<{saved: boolean, onScreen: boolean}>}  Whether it
 *   saved, and whether the position it was saved for is still the one
 *   on screen, for what the caller does to the screen after it.
 */
export async function saveConfigValues({
  values,
  positionKey,
  inputs,
  onSaved,
  onRefused,
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
    positionKey,
    inputs,
    onSaved,
  });
  if (settled.refused !== null)
    alert(await _refillRefused(settled.refused, onRefused));
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
 * for the position on screen, and which field, if any, the server
 * refused.
 *
 * Exported so a test can drive it with an answer of its own: the request
 * itself goes through the global `fetch`, which a test must not replace.
 *
 * @param {object} o
 * @param {boolean} o.ok        Whether the server took the values.
 * @param {number} o.status     The answer's HTTP status.
 * @param {object} o.body       The answer's body.
 * @param {string} [o.positionKey]  The key the request named.
 * @param {object} [o.inputs]   As for `saveConfigValues`.
 * @param {Function} [o.onSaved]  As for `saveConfigValues`.
 * @returns {{saved: boolean, onScreen: boolean,
 *   refused: ({inputId: string, error?: string}|null)}}  `refused` is
 *   the field to fill from the server, or null to leave the fields alone.
 */
export function _settleSaveAnswer({
  ok,
  status,
  body,
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
    if (onSaved) onSaved(onScreen);
    return { saved: true, onScreen, refused: null };
  }
  if (!onScreen) return { saved: false, onScreen, refused: null };
  /*- The server refuses a value it cannot run on rather than quietly
   *  correcting it, so the field is filled from the server again and the
   *  operator told why. They can edit and save again. */
  return { saved: false, onScreen, refused: _refusedField(inputs, body) };
}
