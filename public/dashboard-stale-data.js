/**
 * @file dashboard-stale-data.js
 * @description Whether the figures on screen belong to the position on
 *   screen: the single source of truth for that, and the watch that shows
 *   it on the page.
 *
 *   A position's figures are fresh once the server has answered about it:
 *   the status poll for an open, managed position, its details request for
 *   an unmanaged one, its history request for a closed one. Each of those
 *   answers calls `markPositionDataFresh` with the position it was about,
 *   which records that position's key while it is the one on screen. The
 *   figures are stale whenever the position on screen has another key.
 *   Every way the position on screen changes therefore makes them stale
 *   with no step of its own: a pick in the position browser, a deep link,
 *   the page restoring the position last viewed, a change of wallet. And an
 *   answer about the previous position, arriving late, cannot make the
 *   next one's fresh. With no position on screen nothing is stale, and
 *   neither is an entry the server is never asked about (one with no NFT
 *   id), since no answer could ever make it fresh.
 *
 *   The dashboard holds one status answer at a time, the last, read for
 *   whichever position was on screen when it came (`getLastStatus`). One
 *   read for another position replaces the fresh position's, so
 *   `noteStatusAnswerFor` forgets it: switching back to that position
 *   then waits for a new answer, rather than act on the other one's.
 *
 *   The watch reads the flag every `staleDataCheckIntervalMs`, a setting
 *   the server sends. While it is set, the page's body carries
 *   `data-position-data-stale`, and the stylesheet shows a plain dash in
 *   place of every figure marked `data-position-figure`, hides each
 *   graphic marked `data-position-graphic` (the range and composition
 *   bars), gives each history table one row of dashes, and greys every
 *   control. The watch also makes the page inert, all of it except the
 *   disclaimer and the wallet unlock, so no button, box or link can be
 *   used: nothing is done to a position whose figures have not arrived,
 *   while the wallet can still be unlocked, which some answers wait for.
 */

import { compositeKey } from "./dashboard-helpers.js";
import { activeChainId } from "./dashboard-chain.js";
import { posStore } from "./dashboard-positions-store.js";

/** The body attribute the stylesheet keys the stale look on. */
export const STALE_ATTRIBUTE = "data-position-data-stale";

/*-
 *  What stays usable while the figures are stale: the disclaimer, which
 *  must be accepted before anything starts, and the wallet unlock, its
 *  dialog and the button that opens it.
 */
const _USABLE_IDS = Object.freeze([
  "disclaimerOverlay",
  "walletUnlockModal",
  "unlockWalletBtn",
]);

/*-
 *  The key of the position the last fresh answer was about: null until
 *  one arrives, and again once the dashboard's answers are forgotten.
 */
let _freshKey = null;

// The elements the watch made inert, so it frees those and no others.
const _madeInert = new Set();

/**
 * A position's key, or null for one the server is never asked about.
 * @param {object|null} pos  A position store entry.
 * @returns {string|null}
 */
function _keyOf(pos) {
  if (pos === null || pos === undefined) return null;
  return compositeKey(
    activeChainId(),
    pos.walletAddress,
    pos.contractAddress,
    pos.tokenId,
  );
}

/**
 * Whether the figures on screen may still be another position's: true
 * from the moment a position the server is asked about comes on screen
 * until an answer about it has been shown.
 * @returns {boolean}
 */
export function isPositionDataStale() {
  const key = _keyOf(posStore.getActive());
  return key !== null && key !== _freshKey;
}

/**
 * Record that an answer about `pos` has been shown. It makes the figures
 * fresh only while `pos` is the position on screen, so an answer that
 * arrives after a switch, about the position switched from, changes
 * nothing.
 * @param {object} pos  The position store entry the answer was about.
 */
export function markPositionDataFresh(pos) {
  const key = _keyOf(pos);
  if (key !== null && key === _keyOf(posStore.getActive())) _freshKey = key;
}

/**
 * Record that the status answer the dashboard holds is now one read for
 * `pos`. When `pos` is not the fresh position, that position's answer is
 * no longer held, so it is fresh no longer.
 * @param {object|null} pos  The position on screen when it was read.
 */
export function noteStatusAnswerFor(pos) {
  if (_keyOf(pos) !== _freshKey) _freshKey = null;
}

/**
 * Forget every answer shown, so the position on screen counts as stale
 * until the next one: for when the dashboard drops what it was shown, as
 * a change of wallet does.
 */
export function forgetFreshAnswer() {
  _freshKey = null;
}

/**
 * Every element to make inert: each child of `parent` that neither is
 * nor holds a usable element, and, inside a child holding one, the same
 * again one level down.
 * @param {Element} parent
 * @param {Element[]} usable
 * @param {Element[]} out  Collects the elements.
 * @returns {Element[]} `out`.
 */
function _inertTargets(parent, usable, out) {
  for (const el of parent.children) {
    if (usable.includes(el)) continue;
    if (usable.some((u) => el.contains(u))) _inertTargets(el, usable, out);
    else out.push(el);
  }
  return out;
}

/** The usable elements the page has. */
function _usable() {
  return _USABLE_IDS
    .map((id) => document.getElementById(id))
    .filter((el) => el !== null);
}

/**
 * Bring the page into line with the flag: the body attribute, and the
 * inert parts. Built afresh each time while stale, so a dialog added to
 * the page meanwhile is covered too, and freed at once when not.
 * @param {boolean} stale
 */
function _show(stale) {
  document.body.toggleAttribute(STALE_ATTRIBUTE, stale);
  const targets = new Set(
    stale ? _inertTargets(document.body, _usable(), []) : [],
  );
  for (const el of _madeInert) {
    if (targets.has(el)) continue;
    el.removeAttribute("inert");
    _madeInert.delete(el);
  }
  for (const el of targets) {
    if (_madeInert.has(el)) continue;
    el.setAttribute("inert", "");
    _madeInert.add(el);
  }
}

/**
 * Check the flag at once and then every `intervalMs`, showing it on the
 * page each time. Startup calls this once, with `staleDataCheckIntervalMs`.
 * @param {number} intervalMs
 * @returns {number} The interval's id.
 */
export function startStaleDataWatch(intervalMs) {
  const check = () => _show(isPositionDataStale());
  check();
  return setInterval(check, intervalMs);
}
