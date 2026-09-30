/**
 * @file src/telegram-notifications/telegram.js
 * @module telegram
 * @description
 * Telegram Bot notification system for LP Ranger.  Sends alerts for
 * configurable position events (rebalance, compound, OOR timeout, errors).
 *
 * Bot token and chat ID are stored encrypted via api-key-store.  Event
 * preferences live in `bot-config.json` global section.
 *
 * Setup: create a bot via @BotFather, paste the token + your chat ID
 * (from @userinfobot) into the dashboard dialog.
 */

"use strict";

const { log } = require("../log");
const os = require("os");
const config = require("../config");
const { getLpProviderDisplayName } = require("../lp-providers");
const { getTokenSymbol } = require("../token-symbol-cache");

/** Machine hostname, included in all notifications. */
const _hostname = os.hostname();

/** Compact symbol-truncation width for the header pair lines (sym0 / sym1).
 *  The Holdings section in `balanced-notifier.js` uses its own wider
 *  budget because each symbol gets its own line there.  Widened from
 *  12 to 22 on 2026-06-21 — at 12, "Wrapped Pulse" (13 chars) was
 *  losing the final "e" in production Telegram messages. */
const _SYM_TRUNC_HEADER = 22;

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
  positionDataInvalid: true,
  /*- Impermanent Loss Guard rejection.  Default ON: the bot has
   *  declined to act on a position that is out of range and earning
   *  nothing, and the block can only clear when price recovers, so the
   *  operator needs to know it is happening. */
  ilGuardRejected: true,
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
  positionDataInvalid: "Position Auto-Stopped: Invalid Token Data",
  ilGuardRejected: "Rebalance Rejected Due to Excessive Impermanent Loss",
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
 * Post one message to the Bot API.
 *
 * @param {string} url        The sendMessage endpoint.
 * @param {string} text       Message text.
 * @param {string|null} mode  `parse_mode` to request, or null for none.
 * @returns {Promise<{ok: boolean, status: number, body: string}>}
 *   `status` is 0 and `body` the error message when the request itself
 *   could not be made.
 */
async function _post(url, text, mode) {
  const payload = {
    chat_id: _chatId,
    text,
    disable_web_page_preview: true,
  };
  if (mode) payload.parse_mode = mode;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true, status: res.status, body: "" };
    return {
      ok: false,
      status: res.status,
      body: await res.text().catch(() => ""),
    };
  } catch (err) {
    return { ok: false, status: 0, body: err.message };
  }
}

/**
 * Whether Telegram rejected a message because it could not parse the
 * formatting, as opposed to any other refusal.
 *
 * Telegram answers 400 with a description naming the offending byte —
 * "can't parse entities: Can't find end of the entity starting at byte
 * offset 597". Matched on the phrase rather than the status, because a
 * 400 also covers a bad chat id, which resending fixes nothing about.
 *
 * @param {{status: number, body: string}} res  A failed `_post` result.
 * @returns {boolean}
 */
function _isParseFailure(res) {
  return res.status === 400 && /can't parse entities/i.test(res.body);
}

/**
 * Send a Telegram message via the Bot API, in Markdown when Telegram
 * will take it and as plain text when it will not.
 *
 * The retry is the point. Notifications carry text the app does not
 * control — an error message, a token symbol, an operator's hostname —
 * and Telegram's legacy Markdown treats `_`, `*`, `` ` `` and `[` as
 * entity delimiters. One unbalanced delimiter anywhere makes the whole
 * message unparseable, and Telegram then refuses all of it. On
 * Production that silently swallowed a compound-failure alert whose
 * body quoted a raw ethers error, and the operator learned of the
 * failure a day later by reading the log.
 *
 * Escaping the values instead would be the tidier fix if legacy
 * Markdown had a dependable escape, which it does not; and an escaping
 * pass that missed one future call site would restore exactly this
 * silence. Resending covers every message, including ones not yet
 * written, and costs a second request only when the first was refused.
 *
 * The formatting is what gets sacrificed, never the alert.
 *
 * @param {string} text  Message text (Markdown or plain).
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function _send(text) {
  if (!_botToken || !_chatId) return false;
  const url = `https://api.telegram.org/bot${_botToken}/sendMessage`;
  const first = await _post(url, text, "Markdown");
  if (first.ok) {
    log.info("[telegram] Notification sent: %s", text.split("\n")[0]);
    return true;
  }
  if (!_isParseFailure(first)) {
    log.warn("[telegram] Send failed: %d %s", first.status, first.body);
    return false;
  }
  log.warn(
    "[telegram] Markdown refused (%s) — resending as plain text",
    first.body,
  );
  const plain = await _post(url, text, null);
  if (plain.ok) {
    log.info(
      "[telegram] Notification sent unformatted: %s",
      text.split("\n")[0],
    );
    return true;
  }
  /*- Both attempts refused, so this alert is lost. Logged at error
   *  level because nothing downstream reports it and the operator's
   *  only other sign would be the silence itself. */
  log.error(
    "[telegram] Send failed after plain-text retry: %d %s",
    plain.status,
    plain.body,
  );
  return false;
}

/** Truncate a token symbol to `max` chars (default = compact header width).
 *  `?` placeholder when symbol is missing so the line still renders. */
function _truncSym(s, max = _SYM_TRUNC_HEADER) {
  const v = s || "?";
  return v.length > max ? v.slice(0, max) : v;
}

/** Resolve the user-facing LP-provider name from
 *  `app-config/app-defaults-for-user-configurable/lp-providers.json`
 *  (composite factory+positionManager-keyed).  Same lookup the
 *  dashboard NFT panel reads via `GET /api/lp-providers`.  Returns
 *  `undefined` when no match — callers omit the provider line. */
function _resolveProviderName() {
  return getLpProviderDisplayName(config.FACTORY, config.POSITION_MANAGER);
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
