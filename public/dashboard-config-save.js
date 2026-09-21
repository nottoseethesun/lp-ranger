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
 *   it, so nothing reports success the server refused.
 * @returns {Promise<boolean>}  Whether it saved.
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
    return false;
  }
  if (res.ok) {
    for (const [key, inputId] of Object.entries(inputs || {}))
      rememberGoodInput(inputId, values[key]);
    if (onSaved) onSaved();
    return true;
  }
  /*- The server refuses a value it cannot run on rather than quietly
   *  correcting it, so put the field back to what was last accepted and
   *  say why. The operator can edit and save again.
   *
   *  Only for a rejected VALUE, which `invalidValueForKey` marks. This
   *  route also 400s on a malformed request — no position selected,
   *  most often — and that is not something to show a dialog about,
   *  nor a reason to touch what they typed. */
  const body = await res.json().catch(() => ({}));
  const message = _restoreRefusedField(inputs, body);
  if (message) alert(message);
  return false;
}
