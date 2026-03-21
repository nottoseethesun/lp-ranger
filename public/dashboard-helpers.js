/**
 * @file dashboard-helpers.js
 * @description Shared utility functions and bot configuration state for the
 * 9mm v3 Position Manager dashboard.  Provides DOM access, activity logging,
 * time-formatting helpers, and the shared {@link botConfig} object used by
 * every other dashboard module.
 *
 * Root module — no imports from other dashboard files.
 */

/**
 * Get a DOM element by its ID.
 * @param {string} id  The element's id attribute.
 * @returns {HTMLElement|null}
 */
export function g(id) { return document.getElementById(id); }

/**
 * Append an entry to the on-screen activity log.
 * Newest entries appear at the top; the list is capped at 50 items.
 * @param {string} icon   Emoji icon for the entry.
 * @param {string} type   CSS class suffix for colouring (e.g. 'fee', 'alert').
 * @param {string} title  Short heading text.
 * @param {string} detail Longer description text.
 */
export function act(icon, type, title, detail, when) {
  const list = g('actList');
  const div  = document.createElement('div');
  div.className = 'ai';
  div.innerHTML =
    `<div class="aico ${type}">${icon}</div>` +
    `<div class="ab"><div class="att">${title}</div><div class="adt">${detail}</div></div>` +
    `<div class="atm">${fmtDateTime(when || new Date())}</div>`;
  list.insertBefore(div, list.firstChild);
  if (list.children.length > 50) list.removeChild(list.lastChild);
}

/**
 * Format milliseconds as minutes and seconds.
 * @param {number} ms  Duration in milliseconds.
 * @returns {string}  e.g. "10m", "30s", "10m 30s"
 */
export function fmtMs(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m === 0) return s + 's';
  if (s === 0) return m + 'm';
  return m + 'm ' + s + 's';
}

/**
 * Format a countdown as MM:SS, returning "READY" when expired.
 * @param {number} ms  Remaining milliseconds.
 * @returns {string}  e.g. "02:15" or "READY"
 */
export function fmtCountdown(ms) {
  if (ms <= 0) return 'READY';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/**
 * Get the local timezone 3-letter code (e.g. "EST", "PST", "CET").
 * Falls back to the IANA timezone name if no abbreviation is available.
 * @returns {string}
 */
export function tzCode() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
    const tz = parts.find(p => p.type === 'timeZoneName');
    return tz ? tz.value : Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'local';
  }
}

/**
 * Format a date/time string showing both UTC and local time with TZ code.
 * @param {string|number|Date} input  ISO string, Unix ms, or Date object.
 * @param {object} [opts]
 * @param {boolean} [opts.dateOnly]  If true, show only the date (no time).
 * @returns {string}  e.g. "2026-03-15 14:30 UTC (3/15/2026 10:30 AM EST)"
 */
export function fmtDateTime(input, opts) {
  if (!input) return '\u2014';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '\u2014';

  const dateOnly = opts && opts.dateOnly;
  const utcDate = d.toISOString().slice(0, 10);
  const utcTime = d.toISOString().slice(11, 16);
  const localDate = d.toLocaleDateString();
  const localTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tz = tzCode();

  if (dateOnly) {
    return utcDate + ' UTC (' + localDate + ' ' + tz + ')';
  }
  return utcDate + ' ' + utcTime + ' UTC (' + localDate + ' ' + localTime + ' ' + tz + ')';
}

// ── Bot configuration state ─────────────────────────────────────────────────

/**
 * Shared configuration and live-position state for the dashboard.
 * Updated by the bot config panel and position selection.
 * Price/range fields are placeholders until live on-chain data is wired.
 */
export const botConfig = {
  oorThreshold: 5,
  price:        0,
  lower:        0,
  upper:        0,
  tL:           0,
  tU:           0,
  triggerType:  'oor',
  oorSince:     null,
};

/**
 * Return the Unix timestamp (ms) of the next local midnight.
 * Used by the throttle module for daily counter resets.
 * @returns {number}
 */
export function nextMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + 86400000;
}

// ── Disclaimer cookie helpers ───────────────────────────────────────────────

/** Cookie name for the "Don't show this again" preference. */
const DISCLAIMER_COOKIE = '9mm_disclaimer_accepted';

/**
 * Read a cookie value by name.
 * @param {string} name
 * @returns {string|null}
 */
function getCookie(name) {
  const m = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Set a cookie with a long-lived expiry (400 days, Chrome max).
 * @param {string} name
 * @param {string} value
 */
function setCookie(name, value) {
  const d = new Date();
  d.setTime(d.getTime() + 400 * 86400000);
  document.cookie = name + '=' + encodeURIComponent(value)
    + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
}

// ── Per-position localStorage helpers ────────────────────────────────────────

/** localStorage key prefix for per-position OOR threshold. */
const POS_RANGE_PREFIX = '9mm_oorThreshold_';

/**
 * Build a unique storage key for a position.
 * Uses tokenId for NFTs, contractAddress for ERC-20s.
 * @param {object} pos  Position entry from posStore.
 * @returns {string|null}  Storage key, or null if position has no identifier.
 */
function posStorageKey(pos) {
  if (!pos) return null;
  if (pos.positionType === 'nft' && pos.tokenId) return POS_RANGE_PREFIX + 'nft_' + pos.tokenId;
  if (pos.contractAddress) return POS_RANGE_PREFIX + 'erc20_' + pos.contractAddress.toLowerCase();
  return null;
}

/**
 * Save the OOR threshold % for a position to localStorage.
 * @param {object} pos       Position entry.
 * @param {number} oorPct    OOR threshold percentage.
 */
export function savePositionOorThreshold(pos, oorPct) {
  const key = posStorageKey(pos);
  if (!key) return;
  try { localStorage.setItem(key, String(oorPct)); } catch (_) { /* private browsing */ }
}

/**
 * Load the OOR threshold % for a position from localStorage.
 * Returns the default (5) if no value is stored or the value is invalid.
 * @param {object} pos            Position entry.
 * @param {number} [fallback=5]  Default OOR threshold.
 * @returns {number}
 */
export function loadPositionOorThreshold(pos, fallback) {
  const def = fallback !== undefined ? fallback : 5;
  const key = posStorageKey(pos);
  if (!key) return def;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return def;
    const n = parseFloat(raw);
    return (Number.isFinite(n) && n > 0) ? n : def;
  } catch (_) { return def; }
}

/**
 * Show the disclaimer modal and return a Promise that resolves when accepted.
 * All dashboard initialization should await this before starting polling,
 * routing, or position sync.  If previously accepted (cookie), resolves immediately.
 * @returns {Promise<void>}
 */
export function initDisclaimer() {
  const overlay  = g('disclaimerOverlay');
  const disabled = g('appDisabledOverlay');
  if (!overlay) return Promise.resolve();

  // If cookie exists, user already accepted — hide modal and proceed
  if (getCookie(DISCLAIMER_COOKIE) === '1') {
    overlay.classList.add('hidden');
    return Promise.resolve();
  }

  // Show modal — return promise that resolves on accept
  overlay.classList.remove('hidden');

  const acceptBtn  = g('disclaimerAccept');
  const declineBtn = g('disclaimerDecline');
  const rememberCb = g('disclaimerRemember');

  return new Promise((resolve) => {
    if (acceptBtn) {
      acceptBtn.onclick = function () {
        if (rememberCb && rememberCb.checked) {
          setCookie(DISCLAIMER_COOKIE, '1');
        }
        overlay.classList.add('hidden');
        resolve();
      };
    }
    if (declineBtn) {
      declineBtn.onclick = function () {
        overlay.classList.add('hidden');
        if (disabled) disabled.classList.add('active');
        // Don't resolve — app stays disabled
      };
    }
  });
}

/** Toggle the help popover visibility. */
export function toggleHelpPopover() {
  const pop = g('helpPopover');
  if (!pop) return;
  pop.classList.toggle('9mm-pos-mgr-visible');
}

/** Toggle the settings popover visibility. */
export function toggleSettingsPopover() {
  const pop = g('settingsPopover');
  if (!pop) return;
  pop.classList.toggle('9mm-pos-mgr-visible');
}

/** Clear all localStorage and cookies, then reload. */
export function clearLocalStorageAndCookies() {
  const msg = 'This will clear all locally stored settings including wallet preferences, initial deposit, and realized gains. Continue?';
  if (!confirm(msg)) return;
  localStorage.clear();
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
  }
  location.reload();
}
