/**
 * @file public/dashboard-sounds.js
 * @description
 * Sound-effect playback for the dashboard.  A single master "Sounds" toggle
 * (Settings popover) controls whether UI-action sounds play.  State is
 * persisted in localStorage under the `9mm_sounds_enabled` key and defaults
 * to on (enabled).
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

/** Path to the sound played when the user clicks "Manage Position" on the NFT panel. */
export const SOUND_MANAGE_START =
  "/media/TheTexasRangers-by-Harry-McClintock_3m14p6s_to_3m17p8s.mp3";

/**
 * Whether the master Sounds toggle is enabled.
 * Defaults to `true` when no setting has been stored.
 * @returns {boolean}
 */
export function isSoundsEnabled() {
  try {
    const v = localStorage.getItem(_LS_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
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
 * Restore the Sounds checkbox state on page load from localStorage.
 * Call once after the DOM is ready.
 */
export function restoreSoundsToggle() {
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
