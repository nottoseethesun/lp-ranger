/**
 * @file dashboard-kpi-dom.js
 * @description Shared DOM helper for KPI elements whose value text lives
 *   inside a `.9mm-pos-mgr-kpi-val-wrap` span (so an info "i" button can
 *   sit next to the number without being destroyed on every update).
 *
 *   Multiple callers (poll-driven live KPIs in dashboard-data-kpi.js and
 *   closed-position historical KPIs in dashboard-closed-pos.js) update
 *   the same elements on every position switch.  Centralising the write
 *   here guarantees both paths target the wrapper span correctly, so
 *   stray sibling text nodes cannot be created in the first place.
 */

/**
 * Set the leading value text of a KPI element, preserving any
 * `.9mm-pos-mgr-kpi-val-wrap` child (which may contain an info button).
 * @param {HTMLElement|null} el    KPI container element.
 * @param {string}           text  New value text.
 */
export function setLeadingText(el, text) {
  if (!el) return;
  const target = el.firstChild?.classList?.contains("9mm-pos-mgr-kpi-val-wrap")
    ? el.firstChild
    : el;
  if (target.firstChild?.nodeType === 3) target.firstChild.textContent = text;
  else target.insertBefore(document.createTextNode(text), target.firstChild);
}
