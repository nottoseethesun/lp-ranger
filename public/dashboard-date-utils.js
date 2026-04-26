/**
 * @file dashboard-date-utils.js
 * @description Pure date utilities shared by dashboard modules.  Kept in its
 * own module (no DOM imports) so it can be unit-tested via dynamic ESM import.
 *
 * Root module — no imports from other dashboard files.
 */

/**
 * Pick the earliest valid YYYY-MM-DD date string from a list of candidates.
 *
 * YYYY-MM-DD strings sort lexicographically the same as chronologically, so
 * a simple string min works without any Date parsing.  Filters out null,
 * undefined, non-strings, and strings shorter than the minimum length needed
 * to express a date (10 chars for "YYYY-MM-DD").  Strings longer than 10
 * chars are truncated to the date prefix before comparison so an ISO
 * timestamp like "2024-06-21T12:34:56Z" is treated as "2024-06-21".
 *
 * @param {Array<string|null|undefined>} candidates  Possible YYYY-MM-DD strings.
 * @returns {string|null}  The earliest YYYY-MM-DD prefix, or null if none valid.
 */
export function pickEarliestDate(candidates) {
  const valid = [];
  for (const c of candidates) {
    if (typeof c !== "string" || c.length < 10) continue;
    valid.push(c.slice(0, 10));
  }
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a < b ? a : b));
}

/**
 * Convert a `hodlBaseline.mintTimestamp` value to Unix seconds.
 *
 * Historically the server wrote three different shapes for this field:
 *   - Unix seconds (number) — the canonical form.
 *   - ISO string ("YYYY-MM-DDTHH:MM:SS.sssZ") — written by the patch path
 *     in `_patchMintTimestamp` and the publish path in `_publishBaseline`
 *     before normalization.  Older `.bot-config.json` files in the wild
 *     still carry these.
 *   - Unix milliseconds (number > 1e12) — never intentional but defended
 *     here as a safety net.
 *
 * Returns Unix seconds (number) or null when the input cannot be parsed.
 *
 * @param {number|string|null|undefined} v  Mint timestamp in any historical shape.
 * @returns {number|null}  Unix seconds, or null.
 */
export function toMintTsSeconds(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    /*- Heuristic: anything past year ~5138 must be milliseconds. */
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}
