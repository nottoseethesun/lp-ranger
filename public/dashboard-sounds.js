/**
 * @file public/dashboard-sounds.js
 * @description
 * Sound-effect playback for the dashboard.  A single master "Sounds" toggle
 * (Settings popover) controls whether UI-action sounds play.  State is
 * persisted in localStorage under the `9mm_sounds_enabled` key; when that
 * key is absent, the default comes from `GET /api/ui-defaults` (backed by
 * `app-config/static-tunables/ui-defaults.json`).
 *
 * Each sound lives under `public/media/` and is played as a one-shot
 * `Audio` element.  Use `playSound(path)` for toggle-gated playback and
 * `playSoundAlways(path)` for sounds that should play regardless of the
 * master toggle (e.g. the About-page Easter Egg).
 */

"use strict";

import { g } from "./dashboard-helpers.js";

/** localStorage key for the master Sounds toggle. Value: "0" or "1". */
const _LS_KEY = "9mm_sounds_enabled";

/**
 * Cached server-provided default for Sounds, used when localStorage is
 * empty. Populated by `restoreSoundsToggle()` on init; falls back to
 * `true` if the fetch fails so a brand-new browser still defaults to
 * sound-on even when the server is unreachable.
 */
let _serverDefaultEnabled = true;

/** Path to the sound played when the user clicks "Manage Position" on the NFT panel. */
export const SOUND_MANAGE_START =
  "/media/TheTexasRangers-by-Harry-McClintock_3m14p6s_to_3m17p8s.mp3";

/** Path to the sound played on successful rebalance (automatic or manual). */
export const SOUND_REBALANCE_SUCCESS =
  "/media/TheTexasRangers-by-Harry-McClintock_2m31p3s_to_2m36p8s.mp3";

/** Path to the sound played on successful compound (automatic or manual). */
export const SOUND_COMPOUND_SUCCESS =
  "/media/TheTexasRangers-by-Harry-McClintock_first26p3sec.mp3";

/** Full-track path for the About dialog Easter Egg (plays regardless of master toggle). */
export const SOUND_ABOUT_EASTER_EGG =
  "/media/TheTexasRangers-by-Harry-McClintock.mp3";

/**
 * Whether the master Sounds toggle is enabled.
 * When no setting has been stored in localStorage, returns the cached
 * server-provided default (see `_serverDefaultEnabled`).
 * @returns {boolean}
 */
export function isSoundsEnabled() {
  try {
    const v = localStorage.getItem(_LS_KEY);
    return v === null ? _serverDefaultEnabled : v === "1";
  } catch {
    return _serverDefaultEnabled;
  }
}

/**
 * Play a sound file, gated on the master Sounds toggle.
 * Failures (autoplay policy, missing file, decoding errors) are swallowed
 * so the calling UI flow is never disrupted.
 * @param {string} path  URL path relative to the site root.
 */
export function playSound(path) {
  if (!isSoundsEnabled()) return;
  playSoundAlways(path);
}

/**
 * Play a sound file regardless of the master Sounds toggle.
 * Reserved for explicit user actions like the About-page Easter Egg.
 * @param {string} path  URL path relative to the site root.
 */
export function playSoundAlways(path) {
  try {
    const audio = new Audio(path);
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => console.warn("[sounds] play failed:", path, err));
    }
  } catch (err) {
    console.warn("[sounds] instantiation failed:", path, err);
  }
}

/**
 * Handler for the Settings popover's "Sounds" checkbox.
 * Reads the checkbox state and persists it to localStorage.
 */
export function _toggleSounds() {
  const on = g("soundsSwitch")?.checked;
  try {
    localStorage.setItem(_LS_KEY, on ? "1" : "0");
    console.log("[sounds] master toggle:", on ? "on" : "off");
  } catch {
    /* localStorage unavailable; keep in-memory behavior */
  }
}

/**
 * Restore the Sounds checkbox state on page load. Fetches the server
 * default from `/api/ui-defaults` first so that a fresh browser (no
 * localStorage entry yet) reflects the operator-configured default
 * from `app-config/static-tunables/ui-defaults.json`. Fetch failures
 * are swallowed — the built-in default (true) remains in effect.
 * @returns {Promise<void>}
 */
export async function restoreSoundsToggle() {
  try {
    const res = await fetch("/api/ui-defaults");
    if (res.ok) {
      const data = await res.json();
      if (typeof data.soundsEnabled === "boolean")
        _serverDefaultEnabled = data.soundsEnabled;
    }
  } catch {
    /* keep built-in default */
  }
  const sw = g("soundsSwitch");
  if (sw) sw.checked = isSoundsEnabled();
}

/**
 * Bind the Sounds checkbox change handler.  Separated from the main
 * event-binding module to keep `dashboard-events.bindAllEvents` within
 * its complexity / line-count limits.
 */
export function bindSoundsToggle() {
  const sw = g("soundsSwitch");
  if (sw) sw.addEventListener("change", _toggleSounds);
}

/* ── Event-driven sound triggers ─────────────────────────────────────────
 * Tracks per-position "last event timestamp" so sounds fire on a change
 * without re-firing on fresh page loads / wallet switches (when the
 * server state already has historical timestamps). Call `primeSoundTrackers()`
 * at the end of the first status-poll pass; call `resetSoundTrackers()` on
 * wallet switch (inside resetPollingState).
 */
const _rebSeen = new Map();
const _compoundSeen = new Map();
let _trackersPrimed = false;

/** Fire rebalance-success sound if the value changed (post-priming). */
export function checkRebalanceSound(key, lastRebalanceAt) {
  if (!lastRebalanceAt || lastRebalanceAt === _rebSeen.get(key)) return;
  _rebSeen.set(key, lastRebalanceAt);
  if (_trackersPrimed) playSound(SOUND_REBALANCE_SUCCESS);
}

/** Fire compound-success sound if the value changed (post-priming). */
export function checkCompoundSound(key, lastCompoundAt) {
  if (!lastCompoundAt || lastCompoundAt === _compoundSeen.get(key)) return;
  _compoundSeen.set(key, lastCompoundAt);
  if (_trackersPrimed) playSound(SOUND_COMPOUND_SUCCESS);
}

/** Mark trackers primed (call after first poll-response processing). */
export function primeSoundTrackers() {
  _trackersPrimed = true;
}

/** Clear trackers + un-prime (call on wallet switch). */
export function resetSoundTrackers() {
  _rebSeen.clear();
  _compoundSeen.clear();
  _trackersPrimed = false;
}

/**
 * Bind the About-dialog Easter Egg button.  Plays the full Texas Rangers
 * track via `playSoundAlways` — explicitly bypasses the master toggle
 * because the button is an opt-in user action.
 */
export function bindAboutEasterEgg() {
  const btn = g("aboutEasterEggBtn");
  if (btn)
    btn.addEventListener("click", () =>
      playSoundAlways(SOUND_ABOUT_EASTER_EGG),
    );
}
