/**
 * @file src/il-guard.js
 * @module il-guard
 * @description
 * The Impermanent Loss Guard (ILG): a ceiling on how much value a
 * position may have lost before the bot stops rebalancing it.
 *
 * The comparison is between the **hypothetical post-rebalance position**
 * and the **original USD value of the NFT currently being held** — that
 * NFT's own worth on the day it was minted, not a lifetime or
 * chain-wide figure.  Reject when the projection falls more than
 * `impermanentLossGuardPct` below that original value.
 *
 * Slippage is deliberately excluded from the projection.  A rebalance
 * moves the same dollars from one tick range to another, so with swap
 * costs left out the hypothetical new position is worth what the
 * current one is worth: its LP value plus the pool-scoped wallet
 * residual that the rebalance would fold back in.
 *
 * **This module never touches the chain.**  Both inputs are already
 * computed by the poll cycle before the gate runs, so evaluating the
 * guard cannot drain, collect from, or otherwise alter the NFT.  A
 * rejection is a decision not to start the rebalance at all — the gate
 * sits upstream of `executeRebalance`, so no `decreaseLiquidity` or
 * `collect` is ever reached.  That ordering is the guarantee; see
 * `_checkRebalanceGates` in `src/bot-cycle.js`.
 *
 * Two consequences worth understanding, both documented for the user in
 * the `inIlGuard` help dialog:
 *
 *   1. **A rejection is self-clearing only by price.**  The baseline is
 *      reset by `_updateHodlBaseline` when a rebalance mints a new NFT.
 *      A position rejected by the Impermanent Loss Guard cannot
 *      rebalance, so it cannot mint, so it
 *      cannot get a new baseline — it stays blocked until the market
 *      brings its value back above the floor.
 *   2. **It bites while the position is idle.**  The guard only comes
 *      up when a rebalance was going to happen, which usually means the
 *      position is out of range and earning nothing.  A tight setting
 *      therefore stops the bot from restarting fee income.
 *
 * Hence the shipped default of 50 rather than something tighter: a
 * catastrophe brake, not a routine one.
 */

"use strict";

const { log } = require("./log");
const { notify } = require("./telegram-notifications/telegram");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { readBotConfigDefaults } = require("./bot-config-defaults");

/*- Retry backoff tunables.  Read through `readBotConfigDefaults` — NOT
 *  `loadShippedDefaults` — so a per-install override at
 *  `app-config/user-configurable/bot-config-defaults.json` is honoured
 *  and out-of-range values are clamped, the same way gas-monitor and
 *  bot-cycle-residual read their own tunable groups.  Read once at
 *  module init like those two: a live edit needs a restart. */
const _DEFAULTS = readBotConfigDefaults();

/*- The effective guard percentage for a position with nothing saved.
 *  Taken from `config` rather than the JSON directly, because config is
 *  the one place that layers the env var on top of the merged defaults —
 *  and `posDefaults` in handle-api-status.js publishes that same value
 *  to the Auto-Rebalance Settings badge.  Reading the JSON here instead
 *  made `IMPERMANENT_LOSS_GUARD_PCT=30` show 30 on the badge while the
 *  bot went on enforcing the shipped default. */
const _DEFAULT_GUARD_PCT = config.IMPERMANENT_LOSS_GUARD_PCT;

/**
 * Decide whether the Impermanent Loss Guard rejects a rebalance.
 *
 * Fails OPEN.  When either input is unusable — no baseline resolved
 * yet on a freshly-managed position, a guard percentage that is not a
 * sane number — the rebalance is allowed and `evaluated` is false.  The
 * guard is a brake on a losing position, not a safety interlock, and
 * freezing the bot because a figure has not finished loading would do
 * more harm than the case it protects against.
 *
 * An impermanent GAIN can never reject: a projection at or above the
 * original value is necessarily at or above the floor, which sits below
 * the original value for any guard percentage in [1, 100].
 *
 * @param {object} args
 * @param {number} args.projectedValueUsd  Hypothetical post-rebalance
 *   position value: LP value plus the pool residual it would absorb.
 * @param {number} args.originalValueUsd   The held NFT's USD value at
 *   its own mint (`hodlBaseline.entryValue`).
 * @param {number} args.guardPct           Percent, 1..100.
 * @returns {{evaluated: boolean, rejected: boolean, floorUsd: number|null,
 *            lossPct: number|null, reason: string|null}}
 */
function evaluateIlGuard({ projectedValueUsd, originalValueUsd, guardPct }) {
  const allow = (reason) => ({
    evaluated: false,
    rejected: false,
    floorUsd: null,
    lossPct: null,
    reason,
  });
  if (!Number.isFinite(guardPct) || guardPct <= 0 || guardPct > 100)
    return allow("guard-not-set");
  /*- A zero or negative original value means the mint-transaction scan
   *  has not resolved the baseline yet (or could not price it).  There
   *  is nothing to measure against. */
  if (!Number.isFinite(originalValueUsd) || originalValueUsd <= 0)
    return allow("no-original-value");
  if (!Number.isFinite(projectedValueUsd) || projectedValueUsd < 0)
    return allow("no-projected-value");
  const floorUsd = originalValueUsd * (1 - guardPct / 100);
  const lossPct =
    ((originalValueUsd - projectedValueUsd) / originalValueUsd) * 100;
  return {
    evaluated: true,
    rejected: projectedValueUsd < floorUsd,
    floorUsd,
    lossPct,
    reason: null,
  };
}

/**
 * Build the guard's inputs from the poll cycle's own state.  Extracted
 * so the arithmetic above stays free of the snapshot's shape.
 *
 * The projected value folds in `residualValueUsd` — the pool-scoped
 * coins sitting on the wallet — because a rebalance sweeps those into
 * the new position.  Leaving them out would understate what the
 * rebalance would actually mint.
 *
 * @param {object|null|undefined} snap      P&L snapshot for this poll.
 * @param {object|null|undefined} baseline  `hodlBaseline` for the held NFT.
 * @returns {{projectedValueUsd: number|null, originalValueUsd: number|null}}
 */
function ilGuardInputs(snap, baseline) {
  const lp = snap?.currentValue;
  const residual = snap?.residualValueUsd;
  const projectedValueUsd = Number.isFinite(lp)
    ? lp + (Number.isFinite(residual) ? residual : 0)
    : null;
  const entry = baseline?.entryValue;
  return {
    projectedValueUsd,
    originalValueUsd: Number.isFinite(entry) ? entry : null,
  };
}

/*- Deep link to the published User Manual section carrying the full
 *  explanation.  The Telegram message is deliberately short — a phone
 *  alert, not a reference — and points here rather than restating the
 *  help text.
 *
 *  Built from `shared-help-content.json` rather than written out, so the
 *  anchor exists in exactly one place: the same file the manual section
 *  and the circle-i dialog are both generated from.  A hand-written URL
 *  would be a second copy of the anchor, free to drift the moment the
 *  section is renamed.
 *
 *  Guarded on purpose.  This reads a file under `public/` — help copy,
 *  which the trading engine has no business
 *  depending on.  Unguarded, a missing or malformed
 *  shared-help-content.json takes `bot-cycle` down with it and the bot
 *  will not start at all: a docs file breaking the money loop.  Degrade
 *  to a message without a link instead.
 *
 *  Read with `fs` rather than `require` because it is data, not a
 *  module — and a guarded `require` here trips `n/global-require`. */
function _resolveManualUrl() {
  try {
    const h = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "public", "shared-help-content.json"),
        "utf8",
      ),
    );
    const anchor = h?.inIlGuard?.manualAnchor;
    if (!h?.manualBaseUrl || !anchor) return null;
    return `${h.manualBaseUrl}#${anchor}`;
  } catch (err) {
    log.warn(
      "[il-guard] Could not read shared-help-content.json (%s) — the " +
        "Telegram alert will omit its manual link.",
      err.message,
    );
    return null;
  }
}

const _MANUAL_URL = _resolveManualUrl();

/**
 * The prose for one rejection, written once and used by both channels
 * that report it: the Telegram alert and the dashboard modal (which
 * receives it on `ilGuardBlocked.message` and renders each blank-line
 * block as a paragraph).  Two hand-maintained copies of these five
 * sentences drifted apart the moment either was copy-edited, and the
 * numbers are the same numbers.
 *
 * Under 200 words by design: Telegram caps a message at 4096
 * characters, and mirroring the whole info dialog measured 4086 with a
 * worst-case header — a 10-character margin a longer token pair or
 * hostname would silently blow.  So this carries the numbers and what
 * to do about them, and links out for the rest.  Written to stand
 * alone: whoever reads it on a phone has no dashboard in front of them.
 *
 * `$usd` prefix per the dashboard's own currency convention (see
 * public/dashboard-fmt-usd.js) — the message renders in the UI too.
 *
 * @param {object} v            Rejection figures.
 * @param {object} [opts]
 * @param {boolean} [opts.link] Append the manual link.  Telegram wants
 *   it; the modal does not — it has the circle-i beside the setting,
 *   and a bare URL in plain text would not be clickable there anyway.
 * @returns {string}
 */
function _ilGuardMessage(v, { link } = {}) {
  const usd = (n) => "$usd " + n.toFixed(2);
  return [
    `This position is worth ${usd(v.projectedValueUsd)} — ` +
      `${v.lossPct.toFixed(1)}% below the ${usd(v.originalValueUsd)} ` +
      `it was worth when this NFT was minted.`,
    "",
    `Your Impermanent Loss Guard is set to ${v.guardPct}%, so rebalancing ` +
      `stops below ${usd(v.floorUsd)}. No rebalance was attempted. ` +
      `The position was not touched.`,
    "",
    "The Guard refuses to re-centre a position that has fallen too far, " +
      "rather than locking the loss in at a new price range.",
    "",
    `Next check in about ${v.nextCheckHours} hours; each further rejection ` +
      `doubles that wait, up to a week. The bot cannot clear this itself — ` +
      `it lifts when the position recovers above the floor, or when you ` +
      `lower the Guard in Bot Settings \u2192 Execution. A manual Rebalance ` +
      `Now always works and ignores the Guard.`,
    "",
    "While blocked and out of range, the position earns no fees.",
    ...(link && _MANUAL_URL ? ["", `Full explanation: ${_MANUAL_URL}`] : []),
  ].join("\n");
}

/*- Forget an episode: both the clock and the doubling counter, so the
 *  next one starts at the base interval. */
function _clearRetryState(st) {
  st._ilGuardRejectedAt = 0;
  st._ilGuardRejectCount = 0;
}

/*- End a blocked episode and tell the dashboard.  Emitted on the
 *  TRANSITION only — a position that was never blocked emits nothing, so
 *  the common path adds no per-poll churn to `/api/status`. */
function _clearBlocked(deps, st) {
  if (!st) return;
  const wasBlocked = (st._ilGuardRejectedAt || 0) > 0;
  _clearRetryState(st);
  if (wasBlocked) deps.updateBotState?.({ ilGuardBlocked: null });
}

/*- Publish the block so the dashboard can raise an alert.  A rejection
 *  is otherwise invisible on screen: the user sees a position sitting
 *  out of range, nothing happening, and no reason given.  Carries the
 *  composed message rather than the raw figures, so the modal and the
 *  Telegram alert cannot word the same event differently.  Transient
 *  per-position state — `ilGuardBlocked` is not a POSITION_KEY, so it
 *  never reaches disk. */
function _publishBlocked(deps, v) {
  deps.updateBotState?.({ ilGuardBlocked: { message: _ilGuardMessage(v) } });
}

/**
 * How long to leave a rejected position alone before re-deciding.
 *
 * Doubles with each consecutive rejection — 4 h, 8 h, 16 h, 32 h — and
 * holds at the ceiling, the same shape the rebalance throttle's doubling
 * mode uses.  `rejectCount` is reset to 0 the moment the guard lets a
 * rebalance through, so a position that recovers and later falls again
 * starts over at the base interval rather than resuming a long wait.
 *
 * Exported for tests: the ladder is the behaviour worth pinning, and
 * driving it through eight real waits is not an option.
 *
 * @param {number} rejectCount  Consecutive rejections so far, 1-based.
 * @param {{baseMs:number, maxMs:number}} [cfg]  Defaults to the shipped
 *   `ilGuardRetry` group.  Operator-tunable through the layered
 *   defaults file only, like `residualCleanup` — not per position, since
 *   it paces the bot rather than shaping any one position's range.
 * @returns {number}  Milliseconds to wait.
 */
function ilGuardRetryWaitMs(rejectCount, cfg) {
  const { baseMs, maxMs } = cfg || _DEFAULTS.ilGuardRetry;
  const n = Number.isFinite(rejectCount) && rejectCount > 1 ? rejectCount : 1;
  /*- `2 ** (n - 1)` overflows to Infinity for a large n; Math.min then
   *  yields the ceiling, which is the right answer anyway. */
  return Math.min(baseMs * 2 ** (n - 1), maxMs);
}

/**
 * Whether a previously-rejected position is still inside its backoff
 * window, and so should be left alone without re-deciding.
 *
 * The guard costs nothing to run, so this is not a gas saving — it
 * bounds how often a rejected rebalance is retried at all, which matters
 * on a chain where the eventual successful rebalance is expensive.
 * Accepted cost: a position that recovers inside the window waits for it
 * to expire.
 *
 * @param {object|null|undefined} st  Per-position bot state.
 * @returns {boolean}
 */
function _inBackoff(st) {
  const since = st?._ilGuardRejectedAt || 0;
  if (since <= 0) return false;
  return Date.now() - since < ilGuardRetryWaitMs(st._ilGuardRejectCount);
}

/*- Record an episode: the clock the backoff measures from, and the
 *  doubling counter that widens the next wait. */
function _stampRejection(st) {
  if (!st) return;
  st._ilGuardRejectedAt = Date.now();
  st._ilGuardRejectCount = (st._ilGuardRejectCount || 0) + 1;
}

/**
 * The gate itself.  Returns an early poll-cycle result when the hypothetical
 * post-rebalance position would sit more than `impermanentLossGuardPct`
 * below the held NFT's own value at mint; null to let the rebalance
 * proceed.
 *
 * Read-only by construction: both inputs were computed earlier in this
 * poll cycle, and this runs BEFORE `executeRebalance`, so a rejection
 * cannot reach `removeLiquidity`.  The position is left exactly as it
 * was found.
 *
 * Skipped for user-forced rebalances, like every other gate in
 * `_checkRebalanceGates` — a
 * Rebalance Now click always works, and it has already shown its own
 * impermanent-loss confirmation.
 */
function checkIlGuard(deps, forced, snap, notifyPos) {
  /*- Manual rebalances return here, so a Rebalance Now is held by
   *  neither the guard nor its backoff. */
  if (forced) return null;
  const st = deps._botState;
  if (_inBackoff(st))
    return {
      rebalanced: false,
      ilGuardRejected: true,
      ilGuardCoolingDown: true,
    };
  /*- `readConfigValue` returns undefined for a key that was never
   *  saved, and the layered defaults file is NOT consulted on that path
   *  — consumers apply the shipped default themselves (see
   *  `bot-cycle-opts.js`, which does the same for slippage and approval
   *  multiple).  Without this fallback the Guard is inert on every
   *  position until the user opens Bot Settings and presses Save, which
   *  is the opposite of shipping it on by default. */
  const guardPct =
    deps._getConfig?.("impermanentLossGuardPct") ?? _DEFAULT_GUARD_PCT;
  const { projectedValueUsd, originalValueUsd } = ilGuardInputs(
    snap,
    st?.hodlBaseline,
  );
  const r = evaluateIlGuard({ projectedValueUsd, originalValueUsd, guardPct });
  if (!r.evaluated) {
    if (r.reason !== "guard-not-set")
      log.info("[bot] ILG not evaluated (%s) — allowing rebalance", r.reason);
    _clearBlocked(deps, st);
    return null;
  }
  if (!r.rejected) {
    /*- Recovered above the floor: clear the stamp so a future episode
     *  is retried and announced immediately, not on the old schedule. */
    _clearBlocked(deps, st);
    return null;
  }
  /*- The wait that is about to apply: the counter is incremented by
   *  `_stampRejection` below, so the next rung is current + 1. */
  const nextCheckHours = (
    ilGuardRetryWaitMs((st?._ilGuardRejectCount || 0) + 1) / 3_600_000
  ).toFixed(0);
  log.info(
    "[bot] ILG rejected rebalance for #%s: projected $%s is %s%% below the $%s this NFT was worth at mint (floor $%s at %d%%). Position untouched; next check in %sh.",
    deps.position?.tokenId,
    projectedValueUsd.toFixed(2),
    r.lossPct.toFixed(1),
    originalValueUsd.toFixed(2),
    r.floorUsd.toFixed(2),
    guardPct,
    nextCheckHours,
  );
  /*- The operator needs to know: the position is out of range, earning
   *  nothing, and the bot has decided not to act.  Nothing the bot does
   *  can clear it — only a price recovery can — so the message explains
   *  the setting rather than just reporting the event.
   *
   *  One stamp paces both concerns.  The backoff stops the gate
   *  re-deciding every poll, and because the alert sits behind the same
   *  stamp it follows the same widening schedule — without it a block
   *  that persists for days would send a message every
   *  CHECK_INTERVAL_SEC, hundreds a day per position.  No separate
   *  "already alerted" flag: one observation serves both
   *  (feedback_no_extra_state). */
  _stampRejection(st);
  /*- One set of figures, both channels — built here rather than twice
   *  over, so the modal and the phone alert cannot disagree. */
  const v = {
    projectedValueUsd,
    originalValueUsd,
    floorUsd: r.floorUsd,
    lossPct: r.lossPct,
    guardPct,
    nextCheckHours,
  };
  _publishBlocked(deps, v);
  notify("ilGuardRejected", {
    position: notifyPos(deps.position),
    message: _ilGuardMessage(v, { link: true }),
  });
  return { rebalanced: false, ilGuardRejected: true };
}

module.exports = {
  /*- Exported so `test/il-guard.test.js` can pin the length: Telegram
   *  caps a message at 4096 characters and this one carries a
   *  worst-case header on top. */
  _ilGuardMessage,
  MANUAL_URL: _MANUAL_URL,
  evaluateIlGuard,
  ilGuardInputs,
  ilGuardRetryWaitMs,
  checkIlGuard,
};
