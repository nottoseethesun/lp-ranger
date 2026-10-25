/**
 * @file src/lib/il-guard.js
 * @module il-guard
 * @description
 * The Impermanent Loss Guard (ILG): a ceiling on how much impermanent
 * loss a position may carry before the bot stops rebalancing it, since a
 * rebalance locks that loss in.
 *
 * The comparison is between the **hypothetical post-rebalance position**
 * and **holding the coins the NFT currently held was minted with**, both
 * at today's prices: the Current panel's IL/G for that NFT
 * (`snap.totalIL`), read rather than recomputed. Reject when the
 * projection falls more than `impermanentLossGuardPct` below holding.
 * Valuing the minted coins at the mint day's prices instead would count
 * a move both coins' dollar prices share, which a rebalance does not
 * lock in: it blocked a position whose coins had both fallen, and
 * passed a deep loss hidden inside a shared rise.
 *
 * Slippage is deliberately excluded from the projection.  A rebalance
 * moves the same dollars from one tick range to another, so with swap
 * costs left out the hypothetical new position is worth what the
 * current one is worth: its LP value. As in IL/G, the fees this NFT has
 * compounded are left out of it: they are earnings, and counting them
 * would let them hide a loss.
 *
 * The comparison is even, the user's ruling (2026-10-23): its purpose
 * "is to compare the existing position in its state when it was first
 * minted, directly against a hypothetical rebalanced one. If you add in
 * residual coins, it's not an even comparison." So it counts no coin in
 * the wallet, neither a rebalance's leftovers nor a deposit waiting
 * there; and the wallet's coins a compound took into the NFT after its
 * mint, beyond its fees, count with the minted coins on the holding
 * side, since the LP value holds them (src/lib/bot-pnl-il.js).
 *
 * **This module never touches the chain.**  Both inputs are already
 * computed by the poll cycle before the gate runs, so evaluating the
 * guard cannot drain, collect from, or otherwise alter the NFT.  A
 * rejection is a decision not to start the rebalance at all — the gate
 * sits upstream of `executeRebalance`, so no `decreaseLiquidity` or
 * `collect` is ever reached.  That ordering is the guarantee; see
 * `_checkRebalanceGates` in `src/lib/bot-cycle.js`.
 *
 * Two consequences worth understanding, both documented for the user in
 * the `inIlGuard` help dialog:
 *
 *   1. **A rejection clears only at a retry check.**  The minted coins
 *      are reset by `updateHodlBaseline` when a rebalance mints a new
 *      NFT. A position rejected by the Impermanent Loss Guard cannot
 *      rebalance, so it cannot mint, so it keeps measuring against the
 *      same coins — it stays blocked until the two coins' prices move
 *      back enough to bring it within the Guard of holding, seen at the
 *      next retry check, or the operator saves a higher guard
 *      percentage, which lifts the wait (`clearIlGuardWait`) so the
 *      next poll reads it.
 *   2. **It bites while the position is idle.**  The guard only comes
 *      up when a rebalance was going to happen, which usually means the
 *      position is out of range and earning nothing.  A tight setting
 *      therefore stops the bot from restarting fee income.
 *
 * The shipped default is tight all the same, because the two sides are
 * not alike: a rebalance crystallizes the loss by re-minting around the
 * current price, while declining costs only fees an out-of-range
 * position is largely not earning.
 */

"use strict";

const { log } = require("./log");
const { notify } = require("./telegram-notifications/telegram");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { SETTING_BOUNDS } = require("./setting-bounds");
const { withinBound } = require("./range-check");
const { duration } = require("./help-figures");
const { hodlValueUsd } = require("./il-calculator");
const { isThisPositionDrained } = require("./position-drained");

/*- Retry backoff tunables.  Read through `readBotConfigDefaults` — NOT
 *  `loadShippedDefaults` — so a per-install override at
 *  `app-config/user-configurable/bot-config-defaults.json` is honoured
 *  and out-of-range values are clamped, the same way gas-monitor and
 *  bot-cycle-residual read their own tunable groups.  Read once at
 *  module init like those two: a live edit needs a restart. */
const _DEFAULTS = readBotConfigDefaults();

/*-
 *  The retry wait's ceiling and the gas share a rebalance waits behind,
 *  worded for the rejection message from the values the bot acts on, so
 *  an operator's override reaches the message too.
 */
const _RETRY_CEILING = duration(_DEFAULTS.ilGuardRetry.maxMs / 1000);
const _GAS_DEFER_PCT = _DEFAULTS.rebalanceGasDeferPct;

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
 * Fails OPEN.  When either input is unusable — the minted coins not
 * resolved yet on a freshly-managed position, a guard percentage that is
 * not a sane number — the rebalance is allowed and `evaluated` is false.
 * The guard is a brake on a losing position, not a safety interlock, and
 * freezing the bot because a figure has not finished loading would do
 * more harm than the case it protects against.
 *
 * An impermanent GAIN can never reject: a projection at or above
 * holding is necessarily at or above the floor, which sits below
 * holding for any guard percentage in [1, 100].
 *
 * @param {object} args
 * @param {number} args.projectedValueUsd  Hypothetical post-rebalance
 *   position value: the LP value, this NFT's compounded fees left out.
 * @param {number} args.holdValueUsd       What holding the coins the held
 *   NFT was minted with, and the wallet's coins its compounds took in
 *   since, is worth at today's prices.
 * @param {number} args.guardPct           Percent, inside its range in
 *   setting-bounds.json.
 * @returns {{evaluated: boolean, rejected: boolean, floorUsd: number|null,
 *            lossPct: number|null, reason: string|null}}
 */
function evaluateIlGuard({ projectedValueUsd, holdValueUsd, guardPct }) {
  const allow = (reason) => ({
    evaluated: false,
    rejected: false,
    floorUsd: null,
    lossPct: null,
    reason,
  });
  /*-
   *  The same range a saved value is held to, from setting-bounds.json:
   *  outside it there is no guard to apply.
   */
  if (!withinBound(guardPct, SETTING_BOUNDS.impermanentLossGuardPct))
    return allow("guard-not-set");
  /*-
   *  A zero or negative holding value means the mint-transaction scan
   *  has not resolved the minted coins yet, or today's prices are
   *  missing.  There is nothing to measure against.
   */
  if (!Number.isFinite(holdValueUsd) || holdValueUsd <= 0)
    return allow("no-hold-value");
  if (!Number.isFinite(projectedValueUsd) || projectedValueUsd < 0)
    return allow("no-projected-value");
  const floorUsd = holdValueUsd * (1 - guardPct / 100);
  const lossPct = ((holdValueUsd - projectedValueUsd) / holdValueUsd) * 100;
  return {
    evaluated: true,
    rejected: projectedValueUsd < floorUsd,
    floorUsd,
    lossPct,
    reason: null,
  };
}

/**
 * Build the guard's inputs from the poll cycle's own snapshot.  Extracted
 * so the arithmetic above stays free of the snapshot's shape.
 *
 * Both come from the Current panel's IL/G for the NFT held, which
 * `_computeIL` (src/lib/bot-pnl-il.js) has already put on the snapshot:
 * `totalIL` and the coins and prices it was measured with, in
 * `ilInputs`: the minted coins and the wallet's coins this NFT's
 * compounds took in since. Holding is those coins at those prices; the
 * projection is holding plus IL/G, which is the LP value less what this
 * NFT compounded. Read rather than recomputed, so the Guard and the
 * panel cannot differ.
 *
 * @param {object|null|undefined} snap  P&L snapshot for this poll.
 * @returns {{projectedValueUsd: number|null, holdValueUsd: number|null}}
 *   Nulls when the snapshot carries no IL/G yet, as before the minted
 *   coins have been read.
 */
function ilGuardInputs(snap) {
  const none = { projectedValueUsd: null, holdValueUsd: null };
  const il = snap?.totalIL;
  const inputs = snap?.ilInputs;
  if (!Number.isFinite(il) || !inputs?.cur) return none;
  const holdValueUsd = hodlValueUsd({
    hodlAmount0: inputs.cur.hodlAmount0,
    hodlAmount1: inputs.cur.hodlAmount1,
    currentPrice0: inputs.price0,
    currentPrice1: inputs.price1,
  });
  if (!Number.isFinite(holdValueUsd)) return none;
  return { projectedValueUsd: holdValueUsd + il, holdValueUsd };
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
 *  Guarded on purpose.  This reads `src/lib/shared-help-content.json` —
 *  help copy, which the trading engine has no business
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
      fs.readFileSync(path.join(__dirname, "shared-help-content.json"), "utf8"),
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
 * src/client/web/dashboard-fmt-usd.js) — the message renders in the UI too.
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
    `This position is worth ${usd(v.projectedValueUsd)}, leaving out ` +
      `fees compounded into it. Holding the coins this NFT was minted ` +
      `with, and any a compound has since added from the wallet, would ` +
      `be worth ${usd(v.holdValueUsd)} at today's prices, so its ` +
      `impermanent loss is ${v.lossPct.toFixed(1)}%.`,
    "",
    `Your Impermanent Loss Guard is set to ${v.guardPct}%, so rebalancing ` +
      `stops below ${usd(v.floorUsd)}. No rebalance was attempted. ` +
      `The position was not touched.`,
    "",
    "The Guard refuses to re-centre a position whose impermanent loss is " +
      "that deep, because a rebalance would lock the loss in.",
    "",
    `Next check in about ${v.nextCheckHours} hours; each further rejection ` +
      `doubles that wait, up to ${_RETRY_CEILING}. The block lifts at a ` +
      `check that finds the position's value back above the floor. Raising ` +
      `the Guard in Bot Configuration \u2192 Execution lowers the floor; a ` +
      `change you save is read at the bot's next check. A manual ` +
      `Rebalance Now ignores the Guard, but like any rebalance waits while ` +
      `its gas would cost more than ${_GAS_DEFER_PCT}% of the position's ` +
      `value.`,
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

/**
 * Start the Guard afresh for a position whose Guard setting was just
 * saved, so its next check decides on the new value at once rather than
 * after the wait a rejection under the old value started. A rejection on
 * the new value then begins the wait again at its first rung. Called by
 * `POST /api/config` (src/server/server-config-route.js), the way a Slippage
 * save frees a slippage pause. The block the dashboard shows stays until
 * that check, which lifts it or words it again.
 *
 * @param {object|null|undefined} st  Per-position bot state; absent for
 *   a position with no running loop, which has no wait to clear.
 * @returns {void}
 */
function clearIlGuardWait(st) {
  if (st === undefined || st === null) return;
  _clearRetryState(st);
}

/**
 * End the Guard's block when a rebalance succeeds: forget its wait and
 * take down its alert. The Guard measures each NFT against the coins
 * that NFT was minted with, and a rebalance mints a new one whose loss
 * starts near zero, so a wait and an alert earned by the old NFT say
 * nothing about it. The bot state that holds them moves to the new
 * NFT's key with the rest of the position's state, so they are ended
 * here, by the poll cycle after every rebalance that succeeds
 * (src/lib/bot-cycle.js). A Rebalance Now past a block is the rebalance
 * that finds one standing, since the Guard stands aside for it.
 *
 * @param {object} deps  Bot deps: `_botState` holds the wait, and
 *   `updateBotState` takes the alert down.
 * @returns {void}
 */
function endIlGuardBlock(deps) {
  _clearBlocked(deps, deps._botState);
}

/*- End a blocked episode and tell the dashboard.  Emitted on the
 *  TRANSITION only — a position with no block published emits nothing,
 *  so the common path adds no per-poll churn to `/api/status`.
 *
 *  Whether a block is published is read from the block itself, the
 *  state the dashboard shows, not from the wait's clock: a Guard save
 *  zeroes the clock (`clearIlGuardWait`) and leaves the block standing
 *  for this check to lift. */
function _clearBlocked(deps, st) {
  if (!st) return;
  const wasBlocked =
    st.ilGuardBlocked !== undefined && st.ilGuardBlocked !== null;
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

/**
 * Whether the Guard will measure this poll, rather than stand aside for
 * a Rebalance Now or a position that holds no liquidity, or wait out a
 * rejection. The poll asks before taking fresh prices for it
 * (src/lib/bot-cycle.js), so a lookup is spent only when the Guard will use
 * it.
 * @param {object} deps    Bot deps; `_botState` holds the Guard's wait,
 *   `position` the position's liquidity.
 * @param {boolean} forced  A Rebalance Now.
 * @returns {boolean}
 */
function ilGuardWillMeasure(deps, forced) {
  return (
    !forced &&
    !isThisPositionDrained(deps.position) &&
    !_inBackoff(deps._botState)
  );
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
 * below holding the coins the held NFT was minted with, at today's
 * prices; null to let the rebalance proceed.
 *
 * Read-only by construction: both inputs come from this poll cycle's
 * figures, worked out again with fresh prices while price lookups are
 * paused (`snapForGuard`, src/lib/bot-cycle-gates.js), and this runs BEFORE
 * `executeRebalance`, so a rejection cannot reach `removeLiquidity`.
 * The position is left exactly as it was found.
 *
 * Skipped for user-forced rebalances, like every other gate in
 * `_checkRebalanceGates` — a
 * Rebalance Now click is held by none of them, and it has already shown
 * its own impermanent-loss confirmation.
 *
 * Skipped too while the position holds no liquidity, the user's decision
 * (2026-10-23), as after a rebalance that emptied the old position and
 * failed to mint the new one: the bot retries the mint as an automatic
 * rebalance. The drain locked the loss in, and that rebalance passed the
 * Guard before it drained, so there is nothing left to protect; and the
 * Guard, which counts no coin in the wallet, would see an empty position
 * worth nothing and turn the mint down, leaving the coins idle.
 */
function checkIlGuard(deps, forced, snap, notifyPos) {
  /*- Manual rebalances return here, so a Rebalance Now is held by
   *  neither the guard nor its backoff. */
  if (forced) return null;
  /*- Before the backoff, so a wait left by an earlier rejection holds no
   *  mint either. */
  if (isThisPositionDrained(deps.position)) {
    log.info(
      "[bot] ILG stands aside for #%s: the position holds no liquidity, so the rebalance under way finishes",
      deps.position?.tokenId,
    );
    return null;
  }
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
  const { projectedValueUsd, holdValueUsd } = ilGuardInputs(snap);
  const r = evaluateIlGuard({ projectedValueUsd, holdValueUsd, guardPct });
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
    "[bot] ILG rejected rebalance for #%s: projected $%s is %s%% below the " +
      "$%s its minted coins are worth at today's prices (floor $%s at %d%% " +
      'as set by the Bot Configuration setting, "Impermanent Loss Guard ' +
      '(%%)"). Position untouched; next check in %sh.',
    deps.position?.tokenId,
    projectedValueUsd.toFixed(2),
    r.lossPct.toFixed(1),
    holdValueUsd.toFixed(2),
    r.floorUsd.toFixed(2),
    guardPct,
    nextCheckHours,
  );
  /*-
   *  The operator needs to know: the position is out of range, earning
   *  nothing, and the bot has decided not to act.  Nothing the bot does
   *  can clear it — a price recovery or a higher guard percentage can, at
   *  the next check — so the message explains the setting rather than
   *  just reporting the event.
   *
   *  One stamp paces both concerns.  The backoff stops the gate
   *  re-deciding every poll, and because the alert sits behind the same
   *  stamp it follows the same widening schedule — without it a block
   *  that persists for days would send a message every
   *  CHECK_INTERVAL_SEC, hundreds a day per position.  No separate
   *  "already alerted" flag: one observation serves both
   *  (feedback_no_extra_state).
   */
  _stampRejection(st);
  /*- One set of figures, both channels — built here rather than twice
   *  over, so the modal and the phone alert cannot disagree. */
  const v = {
    projectedValueUsd,
    holdValueUsd,
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
  clearIlGuardWait,
  endIlGuardBlock,
  ilGuardWillMeasure,
};
