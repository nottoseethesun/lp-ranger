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
export function g(id) {
  return document.getElementById(id);
}

/**
 * Clone the content of a <template> by id and return the resulting
 * DocumentFragment. Caller fills [data-tpl="..."] slots via textContent
 * (or sets href/src/etc.) and then appends the fragment to the DOM.
 *
 * This is the project-wide replacement for innerHTML assignments from
 * JS: the static markup lives in public/index.html, and JS only owns
 * the dynamic values. See feedback_no_new_html_in_js for the rule.
 *
 * @param {string} id  The <template> element's id attribute.
 * @returns {DocumentFragment|null}
 */
export function cloneTpl(id) {
  const tpl = document.getElementById(id);
  if (!tpl || !("content" in tpl)) return null;
  return tpl.content.cloneNode(true);
}

const _EMOJI = [
  "🌵",
  "🔥",
  "⚡",
  "🌊",
  "🎯",
  "💎",
  "🚀",
  "🌙",
  "⭐",
  "🎪",
  "🦅",
  "🐎",
  "🌻",
  "🍀",
  "🎲",
  "🔔",
];
/**
 * Convert a string to a 3-emoji fingerprint (browser-side).
 * Uses the same emoji set and algorithm as src/logger.js emojiId
 * so server and browser logs show matching fingerprints.
 * @param {string} str  Input string (e.g. NFT token ID).
 * @returns {string}  3-emoji string.
 */
export function emojiId(str) {
  const s = String(str);
  let h0 = 0,
    h1 = 0,
    h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h0 = (h0 * 31 + c) | 0;
    h1 = (h1 * 37 + c) | 0;
    h2 = (h2 * 41 + c) | 0;
  }
  return (
    _EMOJI[Math.abs(h0) % 16] +
    _EMOJI[Math.abs(h1) % 16] +
    _EMOJI[Math.abs(h2) % 16]
  );
}

/**
 * Append an entry to the on-screen activity log.
 * Newest entries appear at the top; the list is capped at 50 items.
 * @param {string} icon   Emoji icon for the entry.
 * @param {string} type   CSS class suffix for colouring (e.g. 'fee', 'alert').
 * @param {string} title  Short heading text.
 * @param {string} detail Longer description text.
 */
const _S =
  'xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"';
/** Inline SVG icons for the activity log — pixel-perfect centering. */
export const ACT_ICONS = {
  grid: `<svg ${_S}><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>`,
  target: `<svg ${_S}><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2"/></svg>`,
  cross: `<svg ${_S}><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  scan: `<svg ${_S}><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>`,
  link: `<svg ${_S}><rect x="1" y="1" width="14" height="14" rx="2"/><path d="M5 8h6M8 5v6"/></svg>`,
  play: `<svg ${_S}><path d="M5 3l8 5-8 5z"/></svg>`,
  lock: `<svg ${_S}><rect x="3" y="7" width="10" height="8" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>`,
  diamond: `<svg ${_S}><path d="M8 2l6 6-6 6-6-6z"/></svg>`,
  clear: `<svg ${_S}><rect x="2" y="2" width="12" height="12" rx="2"/></svg>`,
  gear: `<svg ${_S}><path d="M6.5.5h3l.4 1.8.9.4 1.6-.9 2.1 2.1-.9 1.6.4.9 1.8.4v3l-1.8.4-.4.9.9 1.6-2.1 2.1-1.6-.9-.9.4-.4 1.8h-3l-.4-1.8-.9-.4-1.6.9L1.5 12.6l.9-1.6-.4-.9L.2 9.7v-3l1.8-.4.4-.9-.9-1.6L3.6 1.7l1.6.9.9-.4z"/><circle cx="8" cy="8" r="2"/></svg>`,
  warn: `<svg ${_S}><path d="M8 1L1 15h14z"/><path d="M8 6v4M8 12v1"/></svg>`,
  swap: `<svg ${_S}><path d="M2 5h12M10 2l4 3-4 3"/><path d="M14 11H2M6 8l-4 3 4 3"/></svg>`,
};
/** Maximum entries in the Activity Log. */
const ACT_LOG_MAX = 500;
const _ICON_NODE_CACHE = new Map();

/**
 * Populate an icon container. If `icon` looks like markup (starts with "<"),
 * parse it once via DOMParser and append a clone; otherwise treat it as text.
 * Keeps the activity log free of JS-side innerHTML.
 */
function _setActIcon(el, icon) {
  if (!icon) return;
  if (icon.charAt(0) !== "<") {
    el.textContent = icon;
    return;
  }
  let cached = _ICON_NODE_CACHE.get(icon);
  if (!cached) {
    const doc = new DOMParser().parseFromString(icon, "image/svg+xml");
    cached = doc.documentElement;
    _ICON_NODE_CACHE.set(icon, cached);
  }
  el.appendChild(cached.cloneNode(true));
}

/** Append a short TX hash + copy icon to the main detail element. */
function _appendTxAffordance(adt, txHash) {
  adt.appendChild(document.createElement("br"));
  const wrap = document.createElement("span");
  const short = document.createElement("span");
  short.textContent = txHash.slice(0, 4) + "\u2026" + txHash.slice(-4) + " ";
  const copy = document.createElement("span");
  copy.className = "9mm-pos-mgr-copy-icon";
  copy.title = "Copy full TX hash";
  copy.setAttribute("data-copy-tx", txHash);
  copy.textContent = "\u274F";
  wrap.appendChild(short);
  wrap.appendChild(copy);
  adt.appendChild(wrap);
}

/**
 * Append an entry to the Activity Log.
 * @param {string} icon    SVG markup (ACT_ICONS.*) or plain text/emoji.
 * @param {string} type    CSS modifier class for the icon (e.g. "start", "alert").
 * @param {string} title   Plain-text title.
 * @param {string} detail  Plain-text detail; first line is main, remainder is ctx.
 * @param {Date}   [when]  Timestamp; defaults to now.
 * @param {string} [txHash] Optional TX hash — appended as short hash + copy icon.
 */
export function act(icon, type, title, detail, when, txHash) {
  const list = g("actList");
  const ts = (when || new Date()).getTime();
  const frag = cloneTpl("tplActItem");
  if (!frag) return;
  const div = frag.querySelector(".ai");
  div.dataset.ts = ts;
  const nl = detail.indexOf("\n");
  const main = nl >= 0 ? detail.slice(0, nl) : detail;
  const ctx = nl >= 0 ? detail.slice(nl + 1) : "";
  const aico = div.querySelector('[data-tpl="aico"]');
  aico.classList.add(type);
  _setActIcon(aico, icon);
  div.querySelector('[data-tpl="title"]').textContent = title;
  const adt = div.querySelector('[data-tpl="main"]');
  adt.textContent = main;
  if (txHash) _appendTxAffordance(adt, txHash);
  div.querySelector('[data-tpl="when"]').textContent = fmtDateTime(
    when || new Date(),
  );
  const ctxEl = div.querySelector('[data-tpl="ctx"]');
  if (ctx) {
    ctxEl.textContent = ctx;
    ctxEl.hidden = false;
  } else {
    ctxEl.remove();
  }
  let ref = list.firstChild;
  while (ref && Number(ref.dataset?.ts) > ts) ref = ref.nextSibling;
  list.insertBefore(div, ref);
  while (list.children.length > ACT_LOG_MAX) list.removeChild(list.lastChild);
}

/**
 * Format milliseconds as minutes and seconds.
 * @param {number} ms  Duration in milliseconds.
 * @returns {string}  e.g. "10m", "30s", "10m 30s"
 */
export function fmtMs(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (m === 0) return s + "s";
  if (s === 0) return m + "m";
  return m + "m " + s + "s";
}

/**
 * Format a countdown as MM:SS, returning "READY" when expired.
 * @param {number} ms  Remaining milliseconds.
 * @returns {string}  e.g. "02:15" or "READY"
 */
export function fmtCountdown(ms) {
  if (ms <= 0) return "READY";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

/**
 * Get the local timezone 3-letter code (e.g. "EST", "PST", "CET").
 * Falls back to the IANA timezone name if no abbreviation is available.
 * @returns {string}
 */
export function tzCode() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZoneName: "short",
    }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === "timeZoneName");
    return tz ? tz.value : Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local";
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
  if (!input) return "\u2014";
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return "\u2014";

  const dateOnly = opts && opts.dateOnly;
  const utcDate = d.toISOString().slice(0, 10);
  const utcTime = d.toISOString().slice(11, 16);
  const localDate = d.toLocaleDateString();
  const localTime = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const tz = tzCode();

  if (dateOnly) {
    return utcDate + " UTC (" + localDate + " " + tz + ")";
  }
  return (
    utcDate +
    " " +
    utcTime +
    " UTC (" +
    localDate +
    " " +
    localTime +
    " " +
    tz +
    ")"
  );
}

/** Format a daily-reset timestamp as "Resets HH:MM UTC (HH:MM TZ)". */
export function fmtReset(r) {
  if (!r) return "";
  const d = new Date(r);
  const u = d.toISOString().slice(11, 16) + " UTC";
  const l = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const z = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return "Resets " + u + " (" + l + " " + (z ? z.value : "local") + ")";
}

// ── Composite key ────────────────────────────────────────────────────────────

/**
 * Build a composite key matching the server's format: blockchain-wallet-contract-tokenId.
 * Returns null if any component is missing.
 * @param {string} [blockchain]  Defaults to 'pulsechain'.
 * @param {string} wallet        Wallet address.
 * @param {string} contract      NFT contract address.
 * @param {string} tokenId       NFT token ID.
 * @returns {string|null}
 */
export function compositeKey(blockchain, wallet, contract, tokenId) {
  if (!wallet || !contract || !tokenId) return null;
  return (
    (blockchain || "pulsechain") + "-" + wallet + "-" + contract + "-" + tokenId
  );
}

// ── Bot configuration state ─────────────────────────────────────────────────

/**
 * Shared configuration and live-position state for the dashboard.
 * Updated by the bot config panel and position selection.
 * Price/range fields are placeholders until live on-chain data is wired.
 */
export const botConfig = {
  oorThreshold: 5,
  price: 0,
  lower: 0,
  upper: 0,
  tL: 0,
  tU: 0,
  triggerType: "oor",
  oorSince: null,
};

/** Truncate a string with ellipsis if longer than max. */
export function truncName(name, max) {
  return name && name.length > max ? name.slice(0, max) + "\u2026" : name;
}

/**
 * Copy `text` to the clipboard and give visual feedback by swapping
 * `iconEl`'s textContent to a checkmark for 1200ms.
 * @param {HTMLElement} iconEl  The clicked copy-icon element.
 * @param {string} text  The text to copy.
 */
export function copyWithFeedback(iconEl, text) {
  if (!iconEl || !text) return;
  navigator.clipboard.writeText(text).catch(() => {});
  const orig = iconEl.textContent;
  iconEl.textContent = "\u2713";
  setTimeout(() => {
    iconEl.textContent = orig;
  }, 1200);
}

/** Copy textContent of element `tId` via icon `bId` with checkmark feedback. */
export function copyElText(tId, bId) {
  const t = g(tId),
    b = g(bId);
  if (t && b) copyWithFeedback(b, t.textContent.trim());
}

/** Format a number: up to 6 decimals for normal, compact for huge/tiny, dash for non-finite. */
export function fmtNum(n) {
  if (!Number.isFinite(n)) return "\u2014";
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a >= 1e12) return n.toExponential(4);
  if (a >= 1)
    return n.toFixed(Math.min(6, Math.max(0, 6 - Math.floor(Math.log10(a)))));
  return n.toPrecision(6);
}

/** Detect full-range positions (ticks near ±887272 produce astronomical prices). */
export function isFullRange(lo, hi) {
  return lo < 1e-30 || hi > 1e30;
}

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
// ── Per-position localStorage helpers ────────────────────────────────────────

/** localStorage key prefix for per-position OOR threshold. */
const POS_RANGE_PREFIX = "9mm_oorThreshold_";

/**
 * Build a unique storage key for a position.
 * Uses tokenId for NFTs, contractAddress for ERC-20s.
 * @param {object} pos  Position entry from posStore.
 * @returns {string|null}  Storage key, or null if position has no identifier.
 */
function posStorageKey(pos) {
  if (!pos) return null;
  if (pos.positionType === "nft" && pos.tokenId)
    return POS_RANGE_PREFIX + "nft_" + pos.tokenId;
  if (pos.contractAddress)
    return POS_RANGE_PREFIX + "erc20_" + pos.contractAddress.toLowerCase();
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
  try {
    localStorage.setItem(key, String(oorPct));
  } catch (_) {
    /* private browsing */
  }
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
    return Number.isFinite(n) && n > 0 ? n : def;
  } catch (_) {
    return def;
  }
}

import { DISCLOSURE_HTML, DISCLOSURE_VERSION } from "./disclosure-content.js";

/**
 * Populate the disclosure modal body from the single-source module and
 * log the disclosure version.  Called once before first show.
 */
function _populateDisclosure() {
  const body = g("disclaimerBody");
  if (body && !body.innerHTML.trim()) body.innerHTML = DISCLOSURE_HTML;
  console.log("[lp-ranger] Disclosure version: %s", DISCLOSURE_VERSION);
}

/**
 * Show the disclosure modal on every app launch and return a Promise that
 * resolves when the user affirmatively acknowledges it.  No suppression
 * mechanism — the disclosure must appear on every launch so users always
 * see the current version.
 * @returns {Promise<void>}
 */
export function initDisclaimer() {
  _populateDisclosure();
  const overlay = g("disclaimerOverlay");
  const disabled = g("appDisabledOverlay");
  if (!overlay) return Promise.resolve();

  overlay.classList.remove("hidden");

  const acceptBtn = g("disclaimerAccept");
  const declineBtn = g("disclaimerDecline");

  return new Promise((resolve) => {
    if (acceptBtn) {
      acceptBtn.onclick = function () {
        overlay.classList.add("hidden");
        resolve();
      };
    }
    if (declineBtn) {
      declineBtn.onclick = function () {
        overlay.classList.add("hidden");
        if (disabled) disabled.classList.add("active");
        // Don't resolve — app stays disabled
      };
    }
  });
}

/**
 * Open the disclosure modal from the Settings menu.
 * Same modal, same content, same dismiss button.
 */
export function showDisclosure() {
  _populateDisclosure();
  const overlay = g("disclaimerOverlay");
  if (overlay) {
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      overlay.scrollTop = 0;
    });
  }
}

/** Toggle the settings popover visibility. */
export function toggleSettingsPopover() {
  const pop = g("settingsPopover");
  if (!pop) return;
  const opening = !pop.classList.contains("9mm-pos-mgr-visible");
  pop.classList.toggle("9mm-pos-mgr-visible");
  if (opening) checkMoralisKeyStatus();
}

/** Ping the server to check Moralis API key status and update the dot. */
export async function checkMoralisKeyStatus() {
  const dot = g("moralisKeyDot");
  if (!dot) return "none";
  try {
    const res = await fetch("/api/api-keys/status");
    const data = await res.json();
    const s = data.moralis || "none";
    dot.classList.remove(
      "9mm-pos-mgr-api-dot--valid",
      "9mm-pos-mgr-api-dot--invalid",
      "9mm-pos-mgr-api-dot--quota",
    );
    void dot.offsetWidth; // force reflow to restart animation
    if (s === "valid") {
      dot.classList.add("9mm-pos-mgr-api-dot--valid");
      dot.title = "Moralis API key is active and valid";
    } else if (s === "quota") {
      dot.classList.add("9mm-pos-mgr-api-dot--quota");
      dot.title =
        "Moralis API key is valid but daily quota exhausted — resets tomorrow";
    } else if (s === "invalid") {
      dot.classList.add("9mm-pos-mgr-api-dot--invalid");
      dot.title = "Moralis API key is invalid — check your key";
    } else if (s === "locked") {
      dot.title = "Moralis API key stored but wallet is locked";
    } else {
      dot.title = "No Moralis API key configured";
    }
    const inp = g("moralisKeyInput");
    if (inp)
      inp.placeholder =
        s === "valid" || s === "quota" || s === "locked"
          ? "Paste replacement key"
          : "Paste key here";
    return s;
  } catch {
    /* network error — leave dot in default state */
    return "none";
  }
}

/** Clear all localStorage and cookies, then reload. */
export function clearLocalStorageAndCookies() {
  const msg =
    "This will clear all locally stored settings including wallet preferences, initial deposit, and realized gains. Continue?";
  if (!confirm(msg)) return;
  localStorage.clear();
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0].trim();
    if (name)
      document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
  }
  location.reload();
}

/** Format a duration in ms as "Xd Yh Zm". */
export function fmtDuration(ms) {
  const d = Math.floor(ms / 86400000),
    h = Math.floor((ms % 86400000) / 3600000),
    m = Math.floor((ms % 3600000) / 60000);
  return (d > 0 ? d + "d " : "") + (h > 0 || d > 0 ? h + "h " : "") + m + "m";
}

// ── CSRF token management ───────────────────────────────────────────────────

let _csrfToken = null;
let _csrfExpiresAt = 0;

/** Refresh interval — fetch a new token 5 minutes before expiry. */
const _CSRF_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Fetch a fresh CSRF token from the server.  Called on init and
 * automatically before the current token expires.
 * @returns {Promise<void>}
 */
export async function refreshCsrfToken() {
  try {
    const res = await fetch("/api/csrf-token");
    if (res.ok) {
      const data = await res.json();
      _csrfToken = data.token;
      _csrfExpiresAt = data.expiresAt;
    }
  } catch {
    /* network error — keep existing token */
  }
}

/**
 * Return headers object with the current CSRF token.
 * Every mutating fetch() call should spread this into its headers.
 * @returns {Record<string, string>}
 */
export function csrfHeaders() {
  return _csrfToken ? { "x-csrf-token": _csrfToken } : {};
}

/**
 * Return true when the token needs refreshing (expired or near expiry).
 * @returns {boolean}
 */
export function csrfNeedsRefresh() {
  return Date.now() > _csrfExpiresAt - _CSRF_REFRESH_BUFFER_MS;
}
