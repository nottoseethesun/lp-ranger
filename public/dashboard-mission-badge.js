/**
 * @file dashboard-mission-badge.js
 * @description Mission Control "Special Action" status badge painter
 * and optimistic-latch helper. Split from dashboard-data.js for
 * line-count compliance.
 *
 * The badge reflects the most recent action signal — whichever is
 * newer between the user's latest click (optimistic latch) and the
 * server's latest observed rebalanceInProgress/compoundInProgress on
 * any position. Most recent always wins, so a manual click overrides
 * an auto-action already running, and a new auto-action overrides a
 * stale optimistic latch.
 *
 * When multiple positions have a Special Action in progress at the
 * same time (rare, but possible when one is in-flight and another is
 * queued behind the rebalance lock), the badge stacks them vertically:
 * the first entry fills the original label/position/tokens lines and
 * additional entries are appended into `#missionStatusExtras`.
 */
import { g, truncName } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";

/*- Optimistic latch: flips the badge immediately on click, before
 * the bot-cycle (up to CHECK_INTERVAL_SEC) picks up the request.
 * Clears when the server confirms that specific kind for the
 * position the click was made on, or after _OPT_TIMEOUT_MS as a
 * safety reset. `_optInfo` captures the position at click time so
 * the badge keeps showing the correct pool even if the user
 * switches tabs to a different position before the server confirms. */
let _optKind = null; // "compound" | "rebalance" | null
let _optAt = 0;
let _optInfo = null; // {tokenId, fee, token0Symbol, token1Symbol}
let _optTimer = null;
const _OPT_TIMEOUT_MS = 90_000;

/*- Server-observed action tracking. Whenever the set of active server
 * actions changes (any kind+tokenId added/removed), record the
 * observation time so we can compare it against _optAt to pick the
 * most recent signal. */
let _lastServerSig = null;
let _lastServerAt = 0;

/**
 * Mark a special action as optimistically in-progress. Overwrites any
 * prior latch — the latest click always wins. The badge will show the
 * action immediately until either the server confirms it, or
 * _OPT_TIMEOUT_MS elapses.  `info` captures the position the click was
 * made on so the badge continues to show the correct pool even if the
 * user switches tabs before the server confirms.
 * @param {"compound"|"rebalance"} kind
 * @param {{tokenId:string, fee:number|undefined, token0Symbol:string|undefined, token1Symbol:string|undefined}} [info]
 */
export function setOptimisticSpecialAction(kind, info) {
  if (kind !== "compound" && kind !== "rebalance") return;
  _optKind = kind;
  _optAt = Date.now();
  _optInfo = info
    ? {
        tokenId: info.tokenId,
        fee: info.fee,
        token0Symbol: info.token0Symbol,
        token1Symbol: info.token1Symbol,
      }
    : _currentPositionInfo();
  clearTimeout(_optTimer);
  _optTimer = setTimeout(() => {
    _optKind = null;
    _optAt = 0;
    _optInfo = null;
  }, _OPT_TIMEOUT_MS);
}

/**
 * Scan all position states for every position with an action in
 * progress. Returns an array ordered by iteration of allStates.
 * @param {object|undefined} allStates  Map of compositeKey → state.
 * @returns {Array<{kind:"compound"|"rebalance", tokenId:string, fee:number|undefined, token0Symbol:string|undefined, token1Symbol:string|undefined}>}
 */
export function findActiveActions(allStates) {
  if (!allStates) return [];
  const out = [];
  for (const [key, s] of Object.entries(allStates)) {
    const kind = s.rebalanceInProgress
      ? "rebalance"
      : s.compoundInProgress
        ? "compound"
        : null;
    if (!kind) continue;
    const tokenId = key.split("-").pop();
    const ap = s.activePosition || {};
    const entry = posStore.entries.find((e) => e.tokenId === tokenId);
    out.push({
      kind,
      tokenId,
      fee: ap.fee ?? entry?.fee,
      token0Symbol: entry?.token0Symbol,
      token1Symbol: entry?.token1Symbol,
    });
  }
  return out;
}

/**
 * Legacy single-action helper: returns the first active action or
 * null. Preserved because `showQueuedActionModal` callers use it to
 * detect any in-flight action regardless of which position is active.
 * @param {object|undefined} allStates  Map of compositeKey → state.
 * @returns {object|null}
 */
export function findActiveAction(allStates) {
  const all = findActiveActions(allStates);
  return all[0] || null;
}

/*- For optimistic state, the user just acted on the current tab's
 * position — pull its info from posStore. */
function _currentPositionInfo() {
  const a = posStore.getActive();
  if (!a) return null;
  return {
    tokenId: a.tokenId,
    fee: a.fee,
    token0Symbol: a.token0Symbol,
    token1Symbol: a.token1Symbol,
  };
}

function _formatFee(fee) {
  if (typeof fee !== "number" || !isFinite(fee)) return "\u2014";
  return (fee / 10000).toFixed(2) + "%";
}

function _posLineText(info) {
  return info?.tokenId
    ? `Position #${info.tokenId} / Fee Tier: ${_formatFee(info.fee)}`
    : "";
}

function _tokLineText(info) {
  if (!info?.tokenId) return "";
  const t0 = truncName(info.token0Symbol || "?", 12);
  const t1 = truncName(info.token1Symbol || "?", 12);
  return `${t0}/${t1}`;
}

function _labelFor(kind) {
  if (kind === "rebalance") return "Special Action: Rebalancing";
  if (kind === "compound") return "Special Action: Compounding";
  return "Special Action: None";
}

/*- Render the first entry into the original three lines. */
function _paintPrimary(entry) {
  const text = g("missionStatusText");
  const posLine = g("missionStatusPos");
  const tokLine = g("missionStatusTokens");
  const info = entry || null;
  const label = _labelFor(entry?.kind);
  if (text) text.textContent = label;
  if (posLine) posLine.textContent = _posLineText(info);
  if (tokLine) tokLine.textContent = _tokLineText(info);
}

/*- Render entries beyond the first into a dedicated extras container.
 * Uses textContent (not innerHTML) — no interpolated markup. */
function _paintExtras(entries) {
  const host = g("missionStatusExtras");
  if (!host) return;
  while (host.firstChild) host.removeChild(host.firstChild);
  for (const entry of entries) {
    const block = document.createElement("span");
    block.className = "9mm-pos-mgr-mission-status-extra";
    const lbl = document.createElement("span");
    lbl.className = "9mm-pos-mgr-mission-status-extra-label";
    lbl.textContent = _labelFor(entry.kind);
    const pos = document.createElement("span");
    pos.className = "9mm-pos-mgr-mission-status-extra-pos";
    pos.textContent = _posLineText(entry);
    const tok = document.createElement("span");
    tok.className = "9mm-pos-mgr-mission-status-extra-tokens";
    tok.textContent = _tokLineText(entry);
    block.appendChild(lbl);
    block.appendChild(pos);
    block.appendChild(tok);
    host.appendChild(block);
  }
}

/*- Clear the optimistic latch when EITHER:
 *  (a) the server has confirmed our optimistic action (same kind on
 *      the position the click was made on), OR
 *  (b) the latched position is no longer in `allStates` at all —
 *      meaning the server retired it (e.g., the immediate-retire path
 *      after a failed re-open).  Without (b) the badge would linger
 *      for the full _OPT_TIMEOUT_MS (90 s) on every aborted re-open,
 *      since the bot's abort + retire can complete inside one
 *      bot-poll window without the dashboard ever observing
 *      `rebalanceInProgress=true`. */
function _maybeClearLatch(serverList, allStates) {
  if (!_optKind) return;
  const clickedTokenId = _optInfo?.tokenId;
  const confirmed = serverList.some(
    (a) => a.tokenId === clickedTokenId && a.kind === _optKind,
  );
  /*- After retire, the disk config still has the position as
   *  `status=stopped` so `allStates[key]` is non-undefined — checking
   *  for absence misses the retire case.  Instead detect "no longer
   *  actively managed": the matched entry exists but has status !==
   *  "running" (and no in-progress flags).  Also clear if the entry
   *  was never seen at all (defensive). */
  const stateEntry = allStates
    ? Object.entries(allStates).find(
        ([key]) => key.split("-").pop() === String(clickedTokenId),
      )
    : null;
  const st = stateEntry ? stateEntry[1] : null;
  const positionGone =
    !st ||
    (st.status !== "running" &&
      !st.rebalanceInProgress &&
      !st.compoundInProgress);
  if (!confirmed && !positionGone) return;
  _optKind = null;
  _optAt = 0;
  _optInfo = null;
  clearTimeout(_optTimer);
}

/*- Build the combined action list. Optimistic click is prepended if
 * it is not already reflected in the server list. When the latch is
 * newer than the most recent server-list change, it stays at the top
 * so the just-clicked action is the primary visible entry. */
function _buildList(serverList) {
  const list = [...serverList];
  if (_optKind && _optInfo) {
    const already = list.some(
      (a) => a.tokenId === _optInfo.tokenId && a.kind === _optKind,
    );
    if (!already) {
      const optEntry = { kind: _optKind, ..._optInfo };
      if (_optAt >= _lastServerAt) list.unshift(optEntry);
      else list.push(optEntry);
    }
  }
  return list;
}

/**
 * Paint the Mission Control "Special Action" badge. Scans all
 * position states so that automatic rebalances/compounds on any
 * managed position light up the badge, and stacks multiple
 * concurrent actions vertically.
 * @param {object} d  Status payload from /api/status.
 */
export function updateMissionStatusBadge(d) {
  const badge = g("missionStatusBadge");
  if (!badge) return;
  const serverList = findActiveActions(d?._allPositionStates);
  const sig = serverList.map((a) => `${a.kind}:${a.tokenId}`).join("|");
  if (sig !== _lastServerSig) {
    _lastServerSig = sig;
    _lastServerAt = Date.now();
  }
  _maybeClearLatch(serverList, d?._allPositionStates);
  const list = _buildList(serverList);
  _paintPrimary(list[0] || null);
  _paintExtras(list.slice(1));
  badge.classList.toggle("active", list.length > 0);
}
