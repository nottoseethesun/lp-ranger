/**
 * @file dashboard-unlock-log.js
 * @description Diagnostic logging helpers for the wallet-unlock flow.
 *
 * Investigating a "no prompt on reload, yet wallet got unlocked"
 * mystery on localhost:5555. We need to trace WHO triggered the
 * unlock: a click, an autofill-induced submit, a programmatic call,
 * or some other path. Keeping these helpers in their own module
 * avoids bloating `dashboard-wallet.js` past its 500-line cap or
 * pushing `submitUnlock` over the complexity limit.
 *
 * All logs are namespaced `[lp-ranger] [unlock]`.  The namespace is
 * inlined into every format string via a template literal so that
 * `dashboard-log.js`'s `_withTimestamp` sees a literal `[` at the
 * start and can route the timestamp injection correctly.  An earlier
 * version passed NS as a `%s` substitution argument, which produced
 * `[<timestamp>] [lp-ranger] [unlock] ...` (timestamp first — wrong)
 * because the `%s` placeholder defeated tag detection.  See
 * [[feedback-no-classlist-for-state]]'s sibling principle: keep the
 * data the logger needs to make routing decisions in the format
 * string itself, not behind a substitution.
 */

import { log } from "./dashboard-log.js";
const NS = "[lp-ranger] [unlock]";

/** Safely read the id/tagName of a DOM element, or "n/a". */
function _elId(el) {
  if (!el) return "n/a";
  return el.id || el.tagName || "n/a";
}

/** Safely read the length of a string-like value, or -1 if absent. */
function _len(v) {
  if (v === null || v === undefined) return -1;
  return String(v).length;
}

/** Safely read hidden state of an element, or "n/a". */
function _hidden(el) {
  if (!el) return "n/a";
  return el.classList && el.classList.contains("hidden");
}

/** Fingerprint an Event object's relevant fields for diagnostics. */
function _eventInfo(e) {
  if (!e) return { type: "(none)", isTrusted: "n/a", target: "n/a" };
  return {
    type: e.type,
    isTrusted: e.isTrusted,
    target: _elId(e.target),
  };
}

/** Fingerprint document focus state for diagnostics. */
function _docFocus() {
  if (typeof document === "undefined") {
    return { hasFocus: "n/a", activeEl: "n/a" };
  }
  return {
    hasFocus: document.hasFocus(),
    activeEl: _elId(document.activeElement),
  };
}

/**
 * Log entry into `submitUnlock` with full diagnostic context.
 * @param {Event|null} e            Submit event (or null for programmatic calls).
 * @param {HTMLElement|null} modal  The unlock-modal overlay element.
 * @param {HTMLInputElement|null} pw The password input element.
 */
export function logSubmitEntry(e, modal, pw) {
  const ev = _eventInfo(e);
  const foc = _docFocus();
  log.info(
    `${NS} submitUnlock ENTRY: event=%s isTrusted=%s target=%s modalHidden=%s pwField=%s pwValue.length=%d docHasFocus=%s activeEl=%s`,
    ev.type,
    ev.isTrusted,
    ev.target,
    _hidden(modal),
    !!pw,
    _len(pw && pw.value),
    foc.hasFocus,
    foc.activeEl,
  );
}

/** Log the outbound POST /api/wallet/unlock request. */
export function logSubmitPost(pw) {
  log.info(`${NS} POSTing /api/wallet/unlock (pwLen=%d)`, _len(pw && pw.value));
}

/** Log the server's response to POST /api/wallet/unlock. */
export function logSubmitResponse(d) {
  log.info(
    `${NS} /api/wallet/unlock response: ok=%s error=%s`,
    d && d.ok,
    (d && d.error) || "(none)",
  );
}

/** Log a guard-failure or network error within submitUnlock. */
export function logSubmitAbort(reason) {
  log.warn(`${NS} submitUnlock aborted: %s`, reason);
}

/** Log the status response consumed by `checkWalletLocked`. */
export function logStatus(label, s) {
  const addr = s && s.address ? s.address.slice(0, 10) + "…" : "(none)";
  log.info(
    `${NS} %s status: locked=%s loaded=%s address=%s source=%s`,
    label,
    s && s.locked,
    s && s.loaded,
    addr,
    (s && s.source) || "(none)",
  );
}

/** Log the locked-branch decision in `checkWalletLocked`. */
export function logLockedBranch(modal, pw) {
  log.info(
    `${NS} locked path: modal=%s modalHidden=%s pwField=%s pwFieldValue.length=%d`,
    !!modal,
    _hidden(modal),
    !!pw,
    _len(pw && pw.value),
  );
}

/** Log a simple free-form diagnostic line, namespaced. */
export function logInfo(msg) {
  log.info(`${NS} ${msg}`);
}

/** Log a warning with a message + optional Error. */
export function logWarn(msg, err) {
  log.warn(`${NS} ${msg}${err && err.message ? ": " + err.message : ""}`);
}
