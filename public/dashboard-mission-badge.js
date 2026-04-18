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
 */
import { g, truncName } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions.js";

/*- Optimistic latch: flips the badge immediately on click, before
 * the bot-cycle (up to CHECK_INTERVAL_SEC) picks up the request.
 * Clears when the server confirms that specific kind for our active
 * position, or after _OPT_TIMEOUT_MS as a safety reset. */
let _optKind = null; // "compound" | "rebalance" | null
let _optAt = 0;
let _optTimer = null;
const _OPT_TIMEOUT_MS = 90_000;

/*- Server-observed action tracking. Whenever the active server action
 * (kind + tokenId) changes, record the observation time so we can
 * compare it against _optAt to pick the most recent signal. */
let _lastServerSig = null;
let _lastServerAt = 0;

/**
 * Mark a special action as optimistically in-progress. Overwrites any
 * prior latch — the latest click always wins. The badge will show the
 * action immediately until either the server confirms it, or
 * _OPT_TIMEOUT_MS elapses.
 * @param {"compound"|"rebalance"} kind
 */
export function setOptimisticSpecialAction(kind) {
  if (kind !== "compound" && kind !== "rebalance") return;
  _optKind = kind;
  _optAt = Date.now();
  clearTimeout(_optTimer);
  _optTimer = setTimeout(() => {
    _optKind = null;
    _optAt = 0;
  }, _OPT_TIMEOUT_MS);
}

/**
 * Scan all position states for any with an action in progress.
 * Same-wallet nonce serialization means at most one is active at a
 * time, so the first match is authoritative.
 * @param {object|undefined} allStates  Map of compositeKey → state.
 * @returns {{kind:"compound"|"rebalance", tokenId:string, fee:number|undefined, token0Symbol:string|undefined, token1Symbol:string|undefined}|null}
 */
export function findActiveAction(allStates) {
  if (!allStates) return null;
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
    return {
      kind,
      tokenId,
      fee: ap.fee ?? entry?.fee,
      token0Symbol: entry?.token0Symbol,
      token1Symbol: entry?.token1Symbol,
    };
  }
  return null;
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

function _paintLines(info, label) {
  const text = g("missionStatusText");
  const posLine = g("missionStatusPos");
  const tokLine = g("missionStatusTokens");
  if (text) text.textContent = label;
  const hasInfo = !!info?.tokenId;
  if (posLine) {
    posLine.textContent = hasInfo
      ? `Position #${info.tokenId} / Fee Tier: ${_formatFee(info.fee)}`
      : "";
  }
  if (tokLine) {
    const t0 = truncName(info?.token0Symbol || "?", 12);
    const t1 = truncName(info?.token1Symbol || "?", 12);
    tokLine.textContent = hasInfo ? `${t0}/${t1}` : "";
  }
}

function _labelFor(kind) {
  if (kind === "rebalance") return "Special Action: Rebalancing";
  if (kind === "compound") return "Special Action: Compounding";
  return "Special Action: None";
}

/*- If the server has confirmed our optimistic action (same kind on
 * our active position), retire the latch so future signal comparisons
 * use the authoritative server timestamp. */
function _maybeClearLatch(server) {
  if (!server || !_optKind) return;
  const active = posStore.getActive();
  if (active?.tokenId === server.tokenId && server.kind === _optKind) {
    _optKind = null;
    _optAt = 0;
    clearTimeout(_optTimer);
  }
}

/**
 * Paint the Mission Control "Special Action" badge. Scans all
 * position states so that automatic rebalances/compounds on any
 * managed position light up the badge.
 * @param {object} d  Status payload from /api/status.
 */
export function updateMissionStatusBadge(d) {
  const badge = g("missionStatusBadge");
  if (!badge) return;
  const server = findActiveAction(d?._allPositionStates);
  const sig = server ? server.kind + ":" + server.tokenId : null;
  if (sig !== _lastServerSig) {
    _lastServerSig = sig;
    _lastServerAt = Date.now();
  }
  _maybeClearLatch(server);
  let kind = null,
    info = null;
  const optNewer = _optKind && _optAt >= _lastServerAt;
  if (optNewer) {
    kind = _optKind;
    info = _currentPositionInfo();
  } else if (server) {
    kind = server.kind;
    info = server;
  } else if (_optKind) {
    kind = _optKind;
    info = _currentPositionInfo();
  }
  _paintLines(kind ? info : null, _labelFor(kind));
  badge.classList.toggle("active", !!kind);
}
