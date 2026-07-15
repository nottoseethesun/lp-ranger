/**
 * @file dashboard-ui-icons.js
 * @description Inline-SVG loader for `data-svg="…"` placeholders in
 * `public/index.html`.  Reads the placeholder's `data-svg` attribute
 * (a relative URL to a file under `public/icons/`), fetches the SVG,
 * parses it via DOMParser, and appends the resulting `<svg>` element
 * as the placeholder's child.
 *
 * Called once at page init from `dashboard-init.js`.  Silent on
 * fetch/parse failure — the placeholder simply stays empty rather
 * than throwing.
 *
 * Why inline injection instead of `<img src="…">` (which is what the
 * Activity-Log icons use)?  The UI icons in the header, wallet
 * strip, and unlock modals use `currentColor` / `var(--accent)` so
 * their stroke tracks the button or wallet-strip theme via CSS
 * cascade.  `<img>` isolates the SVG in its own document context,
 * breaking that cascade.  See docs/engineering.md § "SVG Assets".
 */

"use strict";

async function _loadUiIcon(placeholder) {
  const url = placeholder.dataset.svg;
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const svgText = await res.text();
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.tagName !== "svg") return;
    /*- Per-placeholder render size lives on the placeholder as
     *  data-w/data-h so the same SVG file can render at multiple
     *  sizes across the app (e.g. ui-lock.svg at 14 in the reveal
     *  button and at 24 in the wallet-unlock modal). */
    if (placeholder.dataset.w) svg.setAttribute("width", placeholder.dataset.w);
    if (placeholder.dataset.h)
      svg.setAttribute("height", placeholder.dataset.h);
    placeholder.appendChild(svg);
  } catch {
    /* silent — placeholder stays empty */
  }
}

/**
 * Fetch and inject every `data-svg="…"` placeholder currently in the
 * DOM.  Idempotent per-placeholder: a placeholder that already has an
 * `<svg>` child is skipped so a second call doesn't stack duplicates.
 */
export function loadAllUiIcons() {
  document.querySelectorAll("[data-svg]").forEach((el) => {
    if (el.querySelector("svg")) return;
    _loadUiIcon(el);
  });
}
