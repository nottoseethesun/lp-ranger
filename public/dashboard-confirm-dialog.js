/**
 * @file dashboard-confirm-dialog.js
 * @description One promise-based replacement for the native `confirm()`,
 *   rendered as a standard tool-grey Action Dialog.
 *
 *   One implementation shared by every such dialog (Reload Current
 *   Position, Clear Local Storage & Cookies). The Escape handling below
 *   has to unbind its own listener on every exit path, so a second copy
 *   would be a second place to get that right.
 *
 *   Call it where a native `confirm()` would otherwise go:
 *
 *       if (!(await confirmViaDialog("tplMyModal"))) return;
 *
 *   Body markup lives in a `<template>` in index.html — no HTML is built
 *   here (per feedback_no_new_html_in_js).
 */

import { cloneTpl } from "./dashboard-helpers.js";

/**
 * Show a confirm dialog and resolve with the user's answer.
 *
 * Resolves `true` only when the user activates the `[data-tpl="go"]`
 * action button. The Close button, Escape, and any other dismissal all
 * resolve `false`, so the caller's test stays the single boolean it was
 * with `confirm()`.
 *
 * Escape is handled here as well as by the global handler in
 * dashboard-events-manage.js. That handler removes any dynamic overlay
 * but knows nothing about this promise, so without a listener of our own
 * the dialog would vanish and leave the promise pending forever. Both run
 * on the same keydown; the `settled` latch makes the double dismissal
 * idempotent.
 *
 * @param {string} templateId  Id of the `<template>` holding the body.
 * @param {object} [opts]
 * @param {string} [opts.overlayId]  Id to put on the overlay element.
 * @param {(frag: DocumentFragment) => void} [opts.fill]  Populate
 *   `data-tpl` placeholders before the fragment is attached.
 * @returns {Promise<boolean>} True when the user confirmed.
 */
export function confirmViaDialog(templateId, opts = {}) {
  return new Promise((resolve) => {
    const frag = cloneTpl(templateId);
    if (!frag) return resolve(false);
    if (typeof opts.fill === "function") opts.fill(frag);

    const overlay = document.createElement("div");
    overlay.className = "9mm-pos-mgr-modal-overlay";
    if (opts.overlayId) overlay.id = opts.overlayId;
    overlay.appendChild(frag);
    document.body.appendChild(overlay);

    let settled = false;
    /** @param {boolean} ok */
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(ok);
    };
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };

    document.addEventListener("keydown", onKey);
    overlay
      .querySelector("[data-dismiss-modal]")
      ?.addEventListener("click", () => finish(false));
    overlay
      .querySelector('[data-tpl="go"]')
      ?.addEventListener("click", () => finish(true));
  });
}
