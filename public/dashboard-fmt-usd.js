/**
 * @file dashboard-fmt-usd.js
 * @description USD amount formatter for the Current and Lifetime panels.
 * Uses numbro for locale-aware thousands/decimal separators, falling
 * back to en-US when the browser's preferred language has no numbro
 * locale. Currency text is always literal "$usd".
 */
import numbro from "numbro";
import allLanguages from "numbro/dist/languages.min.js";

/*- Register every numbro locale once, then pick the active one based
 *  on the browser's preferred language. Falls back to en-US if no
 *  match. This makes thousands/decimal separators follow user
 *  expectations (e.g. "1,320.22" in en-US vs "1.320,22" in de-DE). */
for (const _k of Object.keys(allLanguages || {})) {
  numbro.registerLanguage(allLanguages[_k]);
}
(function _pickNumbroLocale() {
  const browserLang =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : "en-US";
  const tries = [browserLang, browserLang.split("-")[0], "en-US"];
  for (const t of tries) {
    if (allLanguages && allLanguages[t]) {
      numbro.setLanguage(t);
      console.log(
        "[numbro] formatting locale: %s (browser preference: %s)",
        t,
        browserLang,
      );
      return;
    }
  }
  console.log(
    "[numbro] no matching locale; defaulting to en-US (browser: %s)",
    browserLang,
  );
})();

/*- numbro format options: thousands-separated body, fixed 2 decimals.
 *  Active locale (set above) controls the actual separator characters. */
const _USD_FORMAT = { thousandSeparated: true, mantissa: 2 };

/**
 * Format a USD amount for display in the Current and Lifetime panels.
 * Currency text is always literal "$usd"; only the numeric body is
 * locale-formatted.
 * @param {number|null|undefined} val
 * @returns {string}
 */
export function _fmtUsd(val) {
  if (val === null || val === undefined || isNaN(val)) return "\u2014";
  const isZero = Math.abs(val) < 0.005;
  const body = numbro(Math.abs(val)).format(_USD_FORMAT);
  return isZero ? "$usd " + body : "$usd " + (val < 0 ? "-" : "") + body;
}
