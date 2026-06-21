/**
 * @file src/telegram-notifications/telegram.js
 * @module telegram
 * @description
 * Telegram Bot notification system for LP Ranger.  Sends alerts for
 * configurable position events (rebalance, compound, OOR timeout, errors).
 *
 * Bot token and chat ID are stored encrypted via api-key-store.  Event
 * preferences live in `.bot-config.json` global section.
 *
 * Setup: create a bot via @BotFather, paste the token + your chat ID
 * (from @userinfobot) into the dashboard dialog.
 */

"use strict";

const { log } = require("../log");
const os = require("os");
const config = require("../config");
const { readNftProviders } = require("../nft-providers");
const { getTokenSymbol } = require("../token-symbol-cache");

/** Machine hostname, included in all notifications. */
const _hostname = os.hostname();

/** Compact symbol-truncation width for the header pair lines (sym0 / sym1).
 *  The Holdings section in `balanced-notifier.js` uses its own wider
 *  budget because each symbol gets its own line there. */
const _SYM_TRUNC_HEADER = 12;

/** In-memory Telegram config (populated from encrypted store on unlock). */
let _botToken = null;
let _chatId = null;

/** Event types and their default enabled state. */
const EVENT_DEFAULTS = {
  oorTimeout: true,
  rebalanceSuccess: false,
  rebalanceFail: true,
  compoundSuccess: false,
  compoundFail: true,
  otherError: true,
  lowGasBalance: true,
  veryLowGas: true,
  shutdown: true,
  positionRetired: true,
  /*- Balanced-band notifier (src/telegram-notifications/balanced-notifier.js).  Default OFF —
   *  enabling it bypasses the idle-driven price-lookup pause for these
   *  positions, so price-source quota is consumed even when the
   *  dashboard is closed. */
  positionBalanced: false,
};

/** Human-readable labels for each event type. */
const EVENT_LABELS = {
  oorTimeout: "OOR Timeout Triggered",
  rebalanceSuccess: "Rebalance Succeeded",
  rebalanceFail: "Rebalance Failed",
  compoundSuccess: "Compound Succeeded",
  compoundFail: "Compound Failed",
  otherError: "Other Error",
  lowGasBalance: "Low Gas Balance",
  veryLowGas: "Very Low Gas",
  shutdown: "Server and Bot Shutdown/Exit",
  positionRetired: "Drained Position Auto-Retired",
  /*- Static string that must track BALANCED_THRESHOLD in
   *  src/telegram-notifications/balanced-notifier.js.  The dashboard checkbox label reads the
   *  live percent from /api/telegram/config; this server-side label is
   *  only used as the Telegram message header and is updated by hand
   *  whenever the threshold changes. */
  positionBalanced: "Position Balanced (\u00b12.5% of 50/50)",
};

/** Currently enabled events (mutated in place by setEnabledEvents). */
const _enabledEvents = { ...EVENT_DEFAULTS };

/**
 * Set the bot token (called after wallet unlock decrypts api-keys).
 * @param {string|null} token  Telegram Bot API token.
 */
function setBotToken(token) {
  _botToken = token || null;
}

/**
 * Set the chat ID (called after wallet unlock decrypts api-keys).
 * @param {string|null} id  Telegram chat ID.
 */
function setChatId(id) {
  _chatId = id || null;
}

/** @returns {boolean} True when both bot token and chat ID are configured. */
function isConfigured() {
  return !!_botToken && !!_chatId;
}

/** @returns {string|null} Current bot token (for shutdown spawn). */
function getBotToken() {
  return _botToken;
}

/** @returns {string|null} Current chat ID (for shutdown spawn). */
function getChatId() {
  return _chatId;
}

/**
 * Update which events trigger notifications.
 * @param {Object<string, boolean>} events  Map of eventType → enabled.
 */
function setEnabledEvents(events) {
  if (!events || typeof events !== "object") return;
  for (const [k, v] of Object.entries(events)) {
    if (k in EVENT_DEFAULTS) _enabledEvents[k] = !!v;
  }
}

/** @returns {Object<string, boolean>} Current enabled-events map. */
function getEnabledEvents() {
  return { ..._enabledEvents };
}

/**
 * Send a Telegram message via the Bot API.
 * @param {string} text  Message text (Markdown or plain).
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function _send(text) {
  if (!_botToken || !_chatId) return false;
  const url = `https://api.telegram.org/bot${_botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: _chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn("[telegram] Send failed: %d %s", res.status, body);
      return false;
    }
    log.info("[telegram] Notification sent: %s", text.split("\n")[0]);
    return true;
  } catch (err) {
    log.warn("[telegram] Send error: %s", err.message);
    return false;
  }
}

/** Truncate a token symbol to `max` chars (default = compact header width).
 *  `?` placeholder when symbol is missing so the line still renders. */
function _truncSym(s, max = _SYM_TRUNC_HEADER) {
  const v = s || "?";
  return v.length > max ? v.slice(0, max) : v;
}

/** Resolve the user-facing NFT-issuer name from
 *  `app-config/app-defaults-for-user-configurable/nft-providers.json` (address-keyed).  The
 *  same map the dashboard NFT panel reads via `GET /api/nft-providers`.
 *  Returns `undefined` when no match — callers omit the provider line. */
function _resolveProviderName() {
  const map = readNftProviders();
  const addr = config.POSITION_MANAGER;
  if (!addr) return undefined;
  return map[addr.toLowerCase()];
}

/** Resolve `[sym0, sym1]` for a position via the standard fallback chain:
 *  pre-attached symbol fields → cached symbol map → `undefined`.  We
 *  return `undefined` (not "T0"/"T1") so `buildHeader` can decide whether
 *  to render the pair lines at all. */
function _resolvePairSymbols(position) {
  const sym0Raw =
    position?.token0Symbol ||
    position?.symbol0 ||
    (position?.token0 ? getTokenSymbol(position.token0) : undefined);
  const sym1Raw =
    position?.token1Symbol ||
    position?.symbol1 ||
    (position?.token1 ? getTokenSymbol(position.token1) : undefined);
  return [sym0Raw, sym1Raw];
}

/**
 * Build the standard Telegram message header used by every notification
 * type — the single source of truth for "what the top of a Telegram
 * message from LP Ranger looks like."  Format:
 *
 *   *LP Ranger on <hostname>*: <title>
 *   <blockchain>            ┐
 *   <provider>              │
 *   <sym0> /                ├ position block (omitted when `position` is
 *       <sym1>              │   falsy — used by shutdown / global alerts)
 *   Fee Tier: <pct>         │
 *   Position: #<tokenId>    ┘
 *
 * Each line in the position block is independently conditional on the
 * data being available — a partial position (e.g. only `tokenId`) still
 * renders a useful header.  Callers append a blank line + body via
 * `notify()`.
 *
 * @param {string}  title       Notification title (typically `EVENT_LABELS[type]`,
 *                              but callers without an event type may pass any string).
 * @param {object} [position]   Position whose context belongs in the header.
 *                              Falsy → only the title line is returned.
 * @returns {string[]}          Header lines (no trailing blank line).
 */
function buildHeader(title, position) {
  const lines = [`*LP Ranger on ${_hostname}*: ${title}`];
  if (!position) return lines;
  const chain = config.CHAIN?.displayName;
  if (chain) lines.push(chain);
  const provider = _resolveProviderName();
  if (provider) lines.push(provider);
  const [sym0Raw, sym1Raw] = _resolvePairSymbols(position);
  if (sym0Raw && sym1Raw) {
    lines.push(`${_truncSym(sym0Raw)} /`);
    lines.push(`    ${_truncSym(sym1Raw)}`);
  }
  if (position.fee) {
    lines.push(`Fee Tier: ${(position.fee / 10_000).toFixed(2)}%`);
  }
  if (position.tokenId) lines.push(`Position: #${position.tokenId}`);
  return lines;
}

/**
 * Send a notification if the event type is enabled and Telegram is
 * configured.  Header is built by `buildHeader()` (single source of
 * truth) — the body, txHash, and error fields are appended after a
 * blank-line separator.
 *
 * @param {string} eventType  One of the `EVENT_DEFAULTS` keys.
 * @param {object} details    Event-specific details.
 * @param {object} [details.position]  Position for the header block — may
 *   carry `tokenId`, `fee`, `token0`, `token1`, `token0Symbol`,
 *   `token1Symbol`.  Each header line renders only when its data is
 *   present; pass nothing for global alerts (e.g. shutdown).
 * @param {string} [details.message]   Body text appended after the header.
 * @param {string} [details.txHash]    Transaction hash appended as `TX: ...`.
 * @param {string} [details.error]     Error message appended as `Error: ...`.
 * @returns {Promise<boolean>} True if sent, false if skipped or failed.
 */
async function notify(eventType, details = {}) {
  if (!isConfigured()) return false;
  if (!_enabledEvents[eventType]) return false;
  const title = EVENT_LABELS[eventType] || eventType;
  const lines = buildHeader(title, details.position);
  if (details.message) {
    lines.push("");
    lines.push(details.message);
  }
  if (details.txHash) lines.push(`TX: \`${details.txHash}\``);
  if (details.error) lines.push(`Error: ${details.error}`);
  return _send(lines.join("\n"));
}

/**
 * Send a test message to verify the bot token and chat ID work.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function testConnection() {
  if (!_botToken || !_chatId) {
    return { ok: false, error: "Bot token or chat ID not configured" };
  }
  const ok = await _send(
    `*LP Ranger on ${_hostname}*: Test notification \u2014 connection OK!`,
  );
  return ok ? { ok: true } : { ok: false, error: "Failed to send message" };
}

module.exports = {
  setBotToken,
  setChatId,
  isConfigured,
  getBotToken,
  getChatId,
  setEnabledEvents,
  getEnabledEvents,
  buildHeader,
  notify,
  testConnection,
  EVENT_DEFAULTS,
  EVENT_LABELS,
  _send,
};
