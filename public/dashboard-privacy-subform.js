/**
 * @file public/dashboard-privacy-subform.js
 * @description
 * State persistence + event wiring for the Privacy Mode sub-form in the
 * Settings popover. Three independent controls nested under the master
 * "Privacy Mode" toggle:
 *
 *   1. `privacyBlurWalletSwitch`    — blur wallet-address strings
 *   2. `privacyBlurUsdSwitch`       — blur USD-denominated amounts
 *   3. `privacyUsdThreshold`        — numeric input (0-99999); amounts at
 *                                     or below this value are NOT blurred
 *                                     even when (2) is on
 *
 * Persistence model mirrors `dashboard-sounds.js`:
 *   • Each control persists to its own localStorage key.
 *   • When a key is absent, the value comes from the cached server
 *     default fetched via `GET /api/ui-defaults` (backed by
 *     `app-config/app-defaults-for-user-configurable/ui-defaults.json`).
 *
 * This module only owns the sub-form state. Wiring the settings into the
 * actual blur-application path lives in `dashboard-events-manage.js`.
 */

"use strict";

import { log } from "./dashboard-log.js";
import { g } from "./dashboard-helpers.js";

/** localStorage keys. Values: "0" / "1" for booleans; decimal string for threshold. */
const _LS_BLUR_WALLET = "9mm_privacy_blur_wallet";
const _LS_BLUR_USD = "9mm_privacy_blur_usd";
const _LS_USD_THRESHOLD = "9mm_privacy_usd_threshold";
const _LS_MASTER = "9mm_privacy_mode";

/** Class applied to blurred elements (shared with master toggle). */
const _BLUR_CLASS = "9mm-pos-mgr-privacy-blur";

/** Wallet-category target IDs (addresses, keys, mnemonics). */
const _WALLET_TARGET_IDS = [
  "wsAddr",
  "wsToken",
  "headerWalletLabel",
  "genAddr",
  "genKey",
  "genMnemonic",
  "revealAddr",
  "revealKey",
  "revealMnemonic",
  "seedValidAddr",
  "keyValidAddr",
];

/**
 * Wallet-category CSS selectors. `[data-privacy="blur"]` and `.adt`
 * capture legacy-tagged wallet-adjacent content (tx hashes, activity
 * log lines, history-table position references).
 */
const _WALLET_SELECTORS = [
  ".pos-row-title",
  ".pos-row-meta",
  '[data-privacy="blur"]',
  ".adt",
];

/**
 * USD-category CSS selectors. Elements matched here are scanned for a
 * dollar-prefixed number in their text content; blur is applied only
 * when the parsed value strictly exceeds the user-configured threshold.
 * `.kpi-value` covers the dashboard's big numeric readouts;
 * `[data-privacy="usd"]` is a future-extension hook for tagging other
 * USD-displaying elements (token-count cells, etc.).
 */
const _USD_SELECTORS = [".kpi-value", '[data-privacy="usd"]'];

/*-
 * Coin-category selectors. These elements display token-count amounts
 * (no `

 prefix, just a bare number). When "Hide $USD Values Above
 * Threshold" is on, they are blurred unconditionally — the threshold is
 * a USD value and doesn't directly apply to token counts, but the
 * tooltip ("Where possible, includes the value of token (coin) amounts.")
 * commits us to hiding them as part of the USD-privacy bundle.
 */
const _COIN_SELECTORS = ['[data-privacy="coin"]'];

/*-
 * Bare-USD selectors. Elements whose textContent is a raw number that is
 * already understood to be a USD amount (e.g. Daily P&L cells produced
 * by `_tblUsd`). Parsed as a signed decimal and blurred when the
 * magnitude exceeds the threshold.
 */
const _USD_RAW_SELECTORS = ['[data-privacy="usd-raw"]'];

/*-
 * Matches the first dollar-prefixed number in a text fragment. Handles:
 *   $1,234.56    →  1234.56
 *   $1234        →  1234
 *   -$50.00      →  50.00    (sign stripped — magnitude is what matters
 *                              for "above threshold" comparison)
 *   ($1,112.86)  →  1112.86  (common negative-in-parens format)
 * Returns null when no $-number appears.
 */
const _USD_RE = /\$\s*(?:usd\s*)?-?([\d,]+(?:\.\d+)?)/i;

/** Built-in fallbacks used when both localStorage and the server fetch fail. */
const _BUILTIN_DEFAULTS = Object.freeze({
  blurWallet: true,
  blurUsd: true,
  usdThreshold: 99,
});

/*- Cached server defaults. Populated by `restorePrivacySubform()`; used
 *  when the corresponding localStorage key is absent. Matches the
 *  fallback shape so consumers never see `undefined`. */
const _serverDefaults = { ..._BUILTIN_DEFAULTS };

/**
 * Clamp a numeric string to the 5-digit input range (0..99999). Returns
 * null when the input is not a finite non-negative integer in range so
 * callers can fall back to the default.
 * @param {string|number} v
 * @returns {number|null}
 */
function _parseThreshold(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < 0 || floored > 99999) return null;
  return floored;
}

/** @returns {boolean} Whether wallet-address blur is enabled. */
export function isPrivacyBlurWalletEnabled() {
  try {
    const v = localStorage.getItem(_LS_BLUR_WALLET);
    return v === null ? _serverDefaults.blurWallet : v === "1";
  } catch {
    return _serverDefaults.blurWallet;
  }
}

/** @returns {boolean} Whether USD-amount blur is enabled. */
export function isPrivacyBlurUsdEnabled() {
  try {
    const v = localStorage.getItem(_LS_BLUR_USD);
    return v === null ? _serverDefaults.blurUsd : v === "1";
  } catch {
    return _serverDefaults.blurUsd;
  }
}

/** @returns {number} USD threshold; amounts at or below this are not blurred. */
export function getPrivacyUsdThreshold() {
  try {
    const raw = localStorage.getItem(_LS_USD_THRESHOLD);
    const parsed = _parseThreshold(raw);
    return parsed === null ? _serverDefaults.usdThreshold : parsed;
  } catch {
    return _serverDefaults.usdThreshold;
  }
}

/**
 * Force both sub-checkboxes on and persist. Called by the master
 * Privacy Mode toggle whenever it transitions to "on" so the sub-form
 * always starts a privacy session with full coverage — user can then
 * opt out of individual categories.
 */
export function forceBothSubOptionsOn() {
  try {
    localStorage.setItem(_LS_BLUR_WALLET, "1");
    localStorage.setItem(_LS_BLUR_USD, "1");
  } catch {
    /* */
  }
  const bw = g("privacyBlurWalletSwitch");
  if (bw) bw.checked = true;
  const bu = g("privacyBlurUsdSwitch");
  if (bu) bu.checked = true;
  log.info("[lp-ranger] [privacy] master on → both sub-options forced on");
}

/*- When both sub-category checkboxes are off there's nothing left for
 *  Privacy Mode to hide. Clear the master toggle (localStorage + UI)
 *  so the eye-icon state and the master switch reflect reality.
 *  Called after either sub-checkbox changes. */
function _autoDisableMasterIfEmpty() {
  const wOn = g("privacyBlurWalletSwitch")?.checked;
  const uOn = g("privacyBlurUsdSwitch")?.checked;
  if (wOn || uOn) return;
  try {
    localStorage.setItem(_LS_MASTER, "0");
  } catch {
    /* */
  }
  const sw = g("privacySwitch");
  if (sw) sw.checked = false;
  log.info("[lp-ranger] [privacy] master auto-off (both sub-options off)");
}

/*- Change handler for the wallet-address checkbox. */
function _onBlurWalletChange() {
  const on = g("privacyBlurWalletSwitch")?.checked ? "1" : "0";
  try {
    localStorage.setItem(_LS_BLUR_WALLET, on);
    log.info("[lp-ranger] [privacy] blur wallet:", on === "1" ? "on" : "off");
  } catch {
    /* */
  }
  _autoDisableMasterIfEmpty();
  applyPrivacyState();
}

/*- Change handler for the USD-amount checkbox. */
function _onBlurUsdChange() {
  const on = g("privacyBlurUsdSwitch")?.checked ? "1" : "0";
  try {
    localStorage.setItem(_LS_BLUR_USD, on);
    log.info("[lp-ranger] [privacy] blur usd:", on === "1" ? "on" : "off");
  } catch {
    /* */
  }
  _autoDisableMasterIfEmpty();
  applyPrivacyState();
}

/*- Strip non-digits from the threshold input. `inputmode="numeric"` +
 *  `pattern` guides mobile keyboards, but desktop users can still paste
 *  arbitrary text. Silently coerce on input. */
function _sanitizeThresholdInput(input) {
  const stripped = input.value.replace(/\D+/g, "");
  if (stripped !== input.value) input.value = stripped;
}

/*- Change handler for the threshold input. Persists on blur/change so
 *  partial typing ("9" while the user is heading for "99") doesn't
 *  corrupt state mid-keystroke. */
function _onThresholdChange() {
  const input = g("privacyUsdThreshold");
  if (!input) return;
  _sanitizeThresholdInput(input);
  const parsed = _parseThreshold(input.value);
  if (parsed === null) {
    /*- Empty or out-of-range: restore the default into the input so the
     *  UI never shows a blank field, and clear the localStorage override
     *  so the server default re-applies. */
    input.value = String(_serverDefaults.usdThreshold);
    try {
      localStorage.removeItem(_LS_USD_THRESHOLD);
    } catch {
      /* */
    }
    return;
  }
  try {
    localStorage.setItem(_LS_USD_THRESHOLD, String(parsed));
    log.info("[lp-ranger] [privacy] usd threshold:", parsed);
  } catch {
    /* */
  }
  applyPrivacyState();
}

/*- Parse the first dollar amount in a string. Returns null on no match. */
function _parseUsdFromText(s) {
  if (!s) return null;
  const m = _USD_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/*-
 * Clear the blur class from every element in both wallet and USD
 * categories. Called first by `applyPrivacyState()` so toggling a
 * sub-setting or the master switch always produces a clean redraw —
 * no stale blur survives when a category is turned off.
 */
function _clearAllPrivacyBlur() {
  for (const id of _WALLET_TARGET_IDS) {
    const el = g(id);
    if (el) el.classList.remove(_BLUR_CLASS);
  }
  const allSelectors = [
    ..._WALLET_SELECTORS,
    ..._USD_SELECTORS,
    ..._COIN_SELECTORS,
    ..._USD_RAW_SELECTORS,
  ];
  for (const sel of allSelectors)
    document
      .querySelectorAll(sel)
      .forEach((el) => el.classList.remove(_BLUR_CLASS));
}

/*- True when the element's text is an actual wallet address / key / seed
 *  (worth blurring) rather than a UI label like "Change Wallet Address". */
function _looksLikeSecret(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  /*- 0x-prefixed hex (addresses, keys) or BIP-39 mnemonic (multi-word). */
  if (/^0x[0-9a-f]+/i.test(t)) return true;
  if (/^[a-z]+(\s+[a-z]+){5,}$/i.test(t)) return true;
  return false;
}

/*- Apply blur to every wallet-category element. Elements whose visible
 *  text is a UI label (e.g. "Change Wallet Address") are skipped — no
 *  address is being displayed, so there's nothing to hide. */
function _applyWalletBlur() {
  for (const id of _WALLET_TARGET_IDS) {
    const el = g(id);
    if (!el) continue;
    if (!_looksLikeSecret(el.textContent)) continue;
    el.classList.add(_BLUR_CLASS);
  }
  for (const sel of _WALLET_SELECTORS)
    document
      .querySelectorAll(sel)
      .forEach((el) => el.classList.add(_BLUR_CLASS));
}

/*-
 * Apply blur to USD-category elements whose parsed dollar value
 * strictly exceeds the threshold. Elements with no parseable dollar
 * amount (e.g. `.kpi-value` that currently shows "—" or "IN RANGE")
 * are left alone — we only hide numbers we can quantify.
 */
function _applyUsdBlurThresholded(threshold) {
  const seen = new Set();
  for (const sel of _USD_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const val = _parseUsdFromText(el.textContent);
      if (val !== null && val > threshold) el.classList.add(_BLUR_CLASS);
    });
  }
  for (const sel of _USD_RAW_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const val = _parseBareUsdFromText(el.textContent);
      if (val !== null && val > threshold) el.classList.add(_BLUR_CLASS);
    });
  }
  /*- Coin amounts are tagged `data-privacy="coin"`. Token-count values
   *  have no direct USD magnitude in their own textContent, so apply
   *  blur unconditionally whenever USD privacy is on — the sub-form
   *  checkbox label's tooltip explicitly covers them. */
  for (const sel of _COIN_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      el.classList.add(_BLUR_CLASS);
    });
  }
}

/*-
 * Parse a bare decimal number (no `

 prefix) as an absolute USD value.
 * Handles the output of `_tblUsd` which renders "12.34", "\u221212.34",
 * or "0.00". Returns the absolute magnitude for threshold comparison
 * (we hide large-magnitude gains and losses equally).
 */
function _parseBareUsdFromText(s) {
  if (!s) return null;
  const cleaned = s.replace(/[\u2212,]/g, "").trim();
  if (cleaned === "" || cleaned === "\u2014") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/**
 * Re-render the privacy blur state across the dashboard based on the
 * master switch + both sub-settings + current USD threshold. Safe to
 * call any number of times; always clears first so toggling a category
 * off restores the unblurred view without a page reload.
 *
 * Call sites: (1) master-switch change, (2) sub-form checkbox/threshold
 * change, (3) `reapplyPrivacyBlur()` after a status-poll DOM update,
 * (4) page-load restore.
 */
export function applyPrivacyState() {
  _clearAllPrivacyBlur();
  const masterOn = localStorage.getItem(_LS_MASTER) === "1";
  const icon = g("privacyIcon");
  if (icon) icon.classList.toggle("9mm-pos-mgr-privacy-active", masterOn);
  if (!masterOn) return;
  if (isPrivacyBlurWalletEnabled()) _applyWalletBlur();
  if (isPrivacyBlurUsdEnabled())
    _applyUsdBlurThresholded(getPrivacyUsdThreshold());
}

/**
 * Bind change handlers for every control in the sub-form. Safe to call
 * before the form is in the DOM; missing controls are skipped silently.
 */
export function bindPrivacySubform() {
  const bw = g("privacyBlurWalletSwitch");
  if (bw) bw.addEventListener("change", _onBlurWalletChange);
  const bu = g("privacyBlurUsdSwitch");
  if (bu) bu.addEventListener("change", _onBlurUsdChange);
  const th = g("privacyUsdThreshold");
  if (th) {
    th.addEventListener("input", () => _sanitizeThresholdInput(th));
    th.addEventListener("change", _onThresholdChange);
    th.addEventListener("blur", _onThresholdChange);
  }
}

/**
 * Restore the sub-form control states on page load. Fetches server
 * defaults from `/api/ui-defaults` first so a fresh browser (no
 * localStorage yet) reflects the operator-configured values from
 * `ui-defaults.json`. Fetch failures leave the built-in defaults
 * in effect.
 * @returns {Promise<void>}
 */
export async function restorePrivacySubform() {
  try {
    const res = await fetch("/api/ui-defaults");
    if (res.ok) {
      const data = await res.json();
      if (typeof data.privacyBlurWalletAddresses === "boolean")
        _serverDefaults.blurWallet = data.privacyBlurWalletAddresses;
      if (typeof data.privacyBlurUsdAmounts === "boolean")
        _serverDefaults.blurUsd = data.privacyBlurUsdAmounts;
      const t = _parseThreshold(data.privacyUsdAmountThreshold);
      if (t !== null) _serverDefaults.usdThreshold = t;
    }
  } catch {
    /* keep built-in defaults */
  }
  const bw = g("privacyBlurWalletSwitch");
  if (bw) bw.checked = isPrivacyBlurWalletEnabled();
  const bu = g("privacyBlurUsdSwitch");
  if (bu) bu.checked = isPrivacyBlurUsdEnabled();
  const th = g("privacyUsdThreshold");
  if (th) th.value = String(getPrivacyUsdThreshold());
}
