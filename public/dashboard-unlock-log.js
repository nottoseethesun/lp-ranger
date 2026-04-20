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
 * All logs are namespaced `[lp-ranger] [unlock]` so they filter
 * cleanly in DevTools.
 */

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
  console.log(
    "%s submitUnlock ENTRY: event=%s isTrusted=%s target=%s modalHidden=%s pwField=%s pwValue.length=%d docHasFocus=%s activeEl=%s",
    NS,
    ev.type,
    ev.isTrusted,
    ev.target,
    _hidden(modal),
    !!pw,
    _len(pw && pw.value),
    foc.hasFocus,
    foc.activeEl,
  );
  /*- The stack trace is the critical signal: it identifies whether
   *  the event dispatch originated from a user gesture (click/keydown),
   *  a programmatic call (would show a non-listener frame), or an
   *  autofill-induced native submit (would show no user-stack at all).
   *  Using `new Error().stack` instead of `console.trace` because the
   *  project's ESLint `no-console` config only allows log/warn/error/
   *  info/debug. */
  console.log("%s submitUnlock stack:\n%s", NS, new Error("trace").stack);
}

/** Log the outbound POST /api/wallet/unlock request. */
export function logSubmitPost(pw) {
  console.log(
    "%s POSTing /api/wallet/unlock (pwLen=%d)",
    NS,
    _len(pw && pw.value),
  );
}

/** Log the server's response to POST /api/wallet/unlock. */
export function logSubmitResponse(d) {
  console.log(
    "%s /api/wallet/unlock response: ok=%s error=%s",
    NS,
    d && d.ok,
    (d && d.error) || "(none)",
  );
}

/** Log a guard-failure or network error within submitUnlock. */
export function logSubmitAbort(reason) {
  console.warn("%s submitUnlock aborted: %s", NS, reason);
}

/** Log the status response consumed by `checkWalletLocked`. */
export function logStatus(label, s) {
  const addr = s && s.address ? s.address.slice(0, 10) + "\u2026" : "(none)";
  console.log(
    "%s %s status: locked=%s loaded=%s address=%s source=%s",
    NS,
    label,
    s && s.locked,
    s && s.loaded,
    addr,
    (s && s.source) || "(none)",
  );
}

/** Log the locked-branch decision in `checkWalletLocked`. */
export function logLockedBranch(modal, pw) {
  console.log(
    "%s locked path: modal=%s modalHidden=%s pwField=%s pwFieldValue.length=%d",
    NS,
    !!modal,
    _hidden(modal),
    !!pw,
    _len(pw && pw.value),
  );
}

/** Log a simple free-form diagnostic line, namespaced. */
export function logInfo(msg) {
  console.log("%s %s", NS, msg);
}

/** Log a warning with a message + optional Error. */
export function logWarn(msg, err) {
  console.warn(
    "%s %s%s",
    NS,
    msg,
    err && err.message ? ": " + err.message : "",
  );
}
