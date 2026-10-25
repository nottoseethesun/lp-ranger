/**
 * @file dashboard-telegram.js
 * @description Telegram notification setup dialog.
 * Manages the modal for configuring bot token, chat ID, and event preferences.
 *
 * Depends on: dashboard-helpers.js (g).
 */

import { log } from "./dashboard-log.js";
import { g, fetchWithCsrf } from "./dashboard-helpers.js";
import {
  EVENT_DEFAULTS,
  eventTitle,
} from "../../lib/telegram-notifications/telegram-events.js";

/** POST JSON and return parsed response. */
async function _post(url, body) {
  const res = await fetchWithCsrf(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/*-
 *  Every alert the server can send, by name, from the one list the
 *  server keeps them in: the dialog has a checkbox for each.
 */
const _EVENT_IDS = Object.keys(EVENT_DEFAULTS);

/*-
 *  Whether the checkboxes show the server's choices: false from each
 *  opening until its answer ticks them. Until then a save leaves the
 *  saved choices alone, rather than send boxes nobody filled, which
 *  would turn every alert off.
 */
let _eventsFromServer = false;

/**
 * Record whether the checkboxes show the server's choices, and let them
 * be changed only when they do.
 * @param {boolean} answered
 */
function _showEventsFromServer(answered) {
  _eventsFromServer = answered;
  for (const id of _EVENT_IDS) {
    const el = g("tgEvt_" + id);
    if (el) el.disabled = !answered;
  }
}

/**
 * Give the dialog a checkbox for each alert, the first time it opens,
 * so the page holds no copy of the list. Each row goes before the note
 * under the list, and its title is painted by `_paintEventTitles`.
 */
function _buildEventRows() {
  const note = g("tgBalancedNote");
  const built = g("tgEvt_" + _EVENT_IDS[0]);
  if (note === null || built !== null) return;
  for (const id of _EVENT_IDS) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "tgEvt_" + id;
    const title = document.createElement("span");
    title.id = "tgEvtTitle_" + id;
    const row = document.createElement("label");
    row.append(box, " ", title);
    note.before(row);
  }
}

/*- Format a millisecond duration into the most human-readable unit:
 *  seconds under a minute, minutes under an hour, otherwise hours with
 *  one decimal.  Used by _refreshBalancedCadence so the warning text
 *  next to the "Position Balanced" checkbox always reflects the actual
 *  fetch cadence (CHECK_INTERVAL_SEC × pricePauseExceptionPollWindowMultiple). */
function _fmtCadence(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} seconds`;
  const min = sec / 60;
  if (min < 60)
    return Number.isInteger(min)
      ? `${min} minute${min === 1 ? "" : "s"}`
      : `${min.toFixed(1)} minutes`;
  const hr = min / 60;
  return `${hr.toFixed(1)} hours`;
}

/**
 * Pull the base poll interval and the multiplier from the server, then
 * paint the cadence span in the modal.  Silent on failure: the span
 * stays empty, since the page holds no value of its own.
 */
async function _refreshBalancedCadence() {
  const span = g("tgBalancedCadence");
  if (!span) return;
  try {
    const r = await fetch("/api/bot-config-defaults");
    if (!r.ok) return;
    const d = await r.json();
    const sec = Number(d.checkIntervalSec);
    const mult = Number(d.pricePauseExceptionPollWindowMultiple);
    if (!(sec > 0) || !(mult > 0)) return;
    span.textContent = _fmtCadence(sec * mult * 1000);
  } catch {
    /* the span stays empty */
  }
}

/** Track whether the wallet modal was open when we launched. */
let _walletWasOpen = false;

/**
 * When Telegram is configured during fresh-install wallet
 * setup, the wallet password doesn't exist yet so the server
 * can't encrypt. Stash the config here and flush it after
 * wallet confirmation via flushPendingTelegramConfig().
 */
let _pendingConfig = null;

/** Show the Telegram setup modal and load current config from server. */
export async function openTelegramModal() {
  const modal = g("telegramModal");
  if (!modal) return;
  // If the wallet setup modal is open, hide it so we appear on top
  const wm = g("walletModal");
  _walletWasOpen = wm && !wm.classList.contains("hidden");
  if (_walletWasOpen) wm.classList.add("hidden");
  modal.classList.remove("hidden");
  _setStatus("");
  /*- During the initial wallet-setup flow the server has no
   *  session password yet, so it cannot encrypt credentials.
   *  Hide Save and Test entirely to avoid presenting broken-
   *  looking disabled buttons — the values the user enters are
   *  stashed on Close and submitted automatically once wallet
   *  setup confirms (see closeTelegramModal + confirmWallet).
   *  In the Settings flow both buttons remain visible; Test is
   *  enabled/disabled by _updateTestBtn() based on config state. */
  const saveBtn = g("tgSaveBtn");
  const testBtn = g("tgTestBtn");
  if (saveBtn) saveBtn.hidden = _walletWasOpen;
  if (testBtn) testBtn.hidden = _walletWasOpen;
  if (_walletWasOpen) {
    _setStatus("Values will be saved after wallet setup completes.");
  }
  _updateTestBtn(false);
  _buildEventRows();
  _showEventsFromServer(false);
  _paintEventTitles("—");
  _refreshBalancedCadence();
  try {
    const res = await fetch("/api/telegram/config");
    const data = await res.json();
    _applyConfigToModal(data);
  } catch {
    _setStatus("Could not load config");
  }
}

/**
 * Label each alert's checkbox with the title the alert is sent under,
 * from the one list the server sends them from. Position Balanced's
 * quotes the band.
 * @param {string} bandPct  The band, or a dash until the server names it.
 */
function _paintEventTitles(bandPct) {
  for (const id of _EVENT_IDS) {
    const el = g("tgEvtTitle_" + id);
    if (el) el.textContent = eventTitle(id, bandPct);
  }
}

/**
 * Paint the dialog from the server's Telegram settings, once
 * `openTelegramModal` has them: tick each alert's checkbox as saved and
 * let it be changed, title each alert with the balanced band the
 * notifier uses, and show in the token and chat id fields whether one
 * is saved.
 * @param {object} data  The answer to GET /api/telegram/config.
 */
function _applyConfigToModal(data) {
  const events = data.enabledEvents;
  if (events !== null && typeof events === "object") {
    for (const id of _EVENT_IDS) {
      const el = g("tgEvt_" + id);
      if (el) el.checked = events[id] === true;
    }
    _showEventsFromServer(true);
  }
  const band = Number(data.balancedThresholdPct);
  _paintEventTitles(Number.isFinite(band) ? String(band) : "—");
  const tokenEl = g("tgBotToken");
  const chatEl = g("tgChatId");
  if (tokenEl)
    tokenEl.placeholder = data.hasToken ? "(saved)" : "123456789:ABCdefGhI...";
  if (chatEl) chatEl.placeholder = data.hasChatId ? "(saved)" : "123456789";
  _updateTestBtn(data.configured);
  if (_walletWasOpen) {
    /*- Re-opened during wallet setup: keep the deferred-save
     *  notice; Save is still hidden and the stash/flush path
     *  will run on Close / confirmWallet. */
    _setStatus("Values will be saved after wallet setup completes.");
  } else if (_pendingConfig) {
    _setStatus("Previous save did not complete — Save again to retry.", true);
  }
}

/** Close the Telegram setup modal. */
export function closeTelegramModal() {
  const modal = g("telegramModal");
  /*- Launched-from-wallet-setup flow: Save is hidden, so capture
   *  whatever the user entered now and stash it for confirmWallet
   *  to submit once the session password exists. */
  if (_walletWasOpen) _stashCurrentFormForDeferredSave();
  if (modal) modal.classList.add("hidden");
  // Restore the wallet modal if we hid it on open
  if (_walletWasOpen) {
    const wm = g("walletModal");
    if (wm) wm.classList.remove("hidden");
    _walletWasOpen = false;
  }
}

/**
 * Read the current form fields and stash a config body into
 * _pendingConfig so confirmWallet can submit it once the
 * wallet password is available. Only stashes when the user
 * actually provided a token or chat ID, to avoid overwriting
 * existing server-side config with an empty body.
 */
function _stashCurrentFormForDeferredSave() {
  const tokenEl = g("tgBotToken");
  const chatEl = g("tgChatId");
  const token = tokenEl?.value.trim();
  const chatId = chatEl?.value.trim();
  if (!token && !chatId) return;
  const body = {};
  const events = _readEvents();
  if (events !== null) body.enabledEvents = events;
  if (token) body.botToken = token;
  if (chatId) body.chatId = chatId;
  _pendingConfig = body;
  log.info(
    "[lp-ranger] [telegram] Credentials stashed for deferred save after wallet setup.",
  );
}

/**
 * Read the event checkboxes into an enabledEvents map, or null while
 * they do not show the server's choices.
 * @returns {Object<string, boolean>|null}
 */
function _readEvents() {
  if (!_eventsFromServer) return null;
  const events = {};
  for (const id of _EVENT_IDS) {
    const el = g("tgEvt_" + id);
    events[id] = el ? el.checked : false;
  }
  return events;
}

/** Set the status message in the modal. */
function _setStatus(msg, isError) {
  const el = g("tgStatus");
  if (!el) return;
  el.textContent = msg;
  el.className =
    "9mm-pos-mgr-mt-sm" +
    (isError ? " 9mm-pos-mgr-text-err" : " 9mm-pos-mgr-text-ok");
}

/** Enable or disable the Test button. */
function _updateTestBtn(enabled) {
  const btn = g("tgTestBtn");
  if (btn) btn.disabled = !enabled;
}

/**
 * Stash the body for deferred encryption and clear the input
 * fields so the user sees a pending state.
 */
function _stashPending(body, tokenEl, chatEl) {
  _pendingConfig = body;
  _setStatus("Saved — will be applied after wallet setup");
  if (tokenEl && body.botToken) {
    tokenEl.value = "";
    tokenEl.placeholder = "(pending)";
  }
  if (chatEl && body.chatId) {
    chatEl.value = "";
    chatEl.placeholder = "(pending)";
  }
  _updateTestBtn(false);
}

/** Apply post-save UI updates after a successful server save. */
function _applySaveSuccess(body, tokenEl, chatEl) {
  _setStatus("Saved");
  if (tokenEl) tokenEl.value = "";
  if (chatEl) chatEl.value = "";
  if (tokenEl && body.botToken) tokenEl.placeholder = "(saved)";
  if (chatEl && body.chatId) chatEl.placeholder = "(saved)";
  _updateTestBtn(true);
}

/** Save Telegram config to the server. */
async function _save() {
  const tokenEl = g("tgBotToken");
  const chatEl = g("tgChatId");
  const body = {};
  const events = _readEvents();
  if (events !== null) body.enabledEvents = events;
  if (tokenEl?.value.trim()) body.botToken = tokenEl.value.trim();
  if (chatEl?.value.trim()) body.chatId = chatEl.value.trim();
  _setStatus("Saving...");
  try {
    const res = await _post("/api/telegram/config", body);
    if (res.ok) {
      _applySaveSuccess(body, tokenEl, chatEl);
      return;
    }
    /*- Fresh-install path: the server has no session password yet,
     *  so it cannot encrypt. Stash the config in memory;
     *  flushPendingTelegramConfig() will submit it with the wallet
     *  password once confirmWallet() runs. */
    if (res.error === "Password required") {
      log.info(
        "[lp-ranger] [telegram] Save deferred — server has no session password yet; " +
          "will be submitted after wallet setup confirms.",
      );
      _stashPending(body, tokenEl, chatEl);
      return;
    }
    _setStatus(res.error || "Save failed", true);
  } catch (err) {
    _setStatus(err.message, true);
  }
}

/**
 * Flush any Telegram config that was stashed during the
 * wallet setup dialog. Called by confirmWallet() once the
 * wallet password is available so the server can encrypt.
 *
 * On failure the pending config is retained so a later
 * openTelegramModal() can detect it and offer a retry. Both
 * success and failure are logged to the browser console so
 * the user can see what happened without reopening the modal.
 *
 * @param {string} password - the wallet password from setup.
 */
export async function flushPendingTelegramConfig(password) {
  if (!_pendingConfig) return;
  const body = { ..._pendingConfig, password };
  try {
    const res = await _post("/api/telegram/config", body);
    if (res && res.ok) {
      _pendingConfig = null;
      log.info(
        "[lp-ranger] [telegram] Deferred credentials saved after wallet setup.",
      );
      return;
    }
    log.warn(
      "[lp-ranger] [telegram] Deferred save REJECTED by server — credentials NOT saved:",
      res?.error || "(no error message)",
      "Re-open Telegram Setup to retry.",
    );
  } catch (err) {
    log.warn(
      "[lp-ranger] [telegram] Deferred save FAILED — credentials NOT saved:",
      err.message,
      "Re-open Telegram Setup to retry.",
    );
  }
}

/** Send a test notification. */
async function _test() {
  _setStatus("Sending test...");
  try {
    const res = await _post("/api/telegram/test", {});
    _setStatus(res.ok ? "Test sent!" : res.error || "Test failed", !res.ok);
  } catch (err) {
    _setStatus(err.message, true);
  }
}

/** Wire up all Telegram-related event listeners. */
export function initTelegram() {
  const saveBtn = g("tgSaveBtn");
  const testBtn = g("tgTestBtn");
  const closeBtn = g("tgCloseBtn");
  if (saveBtn) saveBtn.addEventListener("click", _save);
  if (testBtn) testBtn.addEventListener("click", _test);
  if (closeBtn) closeBtn.addEventListener("click", closeTelegramModal);

  const settingsBtn = g("telegramSettingsBtn");
  if (settingsBtn) settingsBtn.addEventListener("click", openTelegramModal);

  for (const btn of document.querySelectorAll(".setupTelegramBtn")) {
    btn.addEventListener("click", openTelegramModal);
  }

  const modal = g("telegramModal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeTelegramModal();
    });
  }
}
