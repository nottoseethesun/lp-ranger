/**
 * @file dashboard-reopen-flow.js
 * @description Closed-position re-open flow: dust-check + two-step
 *   dialog sequence + handoff to the existing rebalance modal in
 *   `reopenContext` mode.  Extracted from `dashboard-events-manage.js`
 *   so that file stays under the 500-line cap.
 *
 *   Entry point: `runReopenFlow(active, opts)`.  Opts carry the
 *   handful of helpers the flow needs from the events module so this
 *   file stays free of circular imports back to its caller.
 */

import { log } from "./dashboard-log.js";
import { fetchWithCsrf } from "./dashboard-helpers.js";
import { _createModal } from "./dashboard-data-status.js";

/**
 * Run the closed-position re-open flow.
 *
 * @param {object} active                    Position store entry.
 * @param {object} opts
 * @param {Function} opts.formatPositionSpec One-line position spec for
 *   modal context (typically `_formatPositionSpec` from the events
 *   module).
 * @param {Function} opts.handleManageFailure Existing error display
 *   function (`_handleManageFailure` from the events module).
 */
export async function runReopenFlow(active, opts) {
  const { formatPositionSpec, handleManageFailure } = opts;
  /*- Lazy-import the rebalance-modal opener to avoid a circular
   *  dependency: dashboard-throttle-rebalance.js imports from the
   *  events module (which calls into here), so eager-importing it
   *  here would form a cycle. */
  const { openRebalanceRangeModal } =
    await import("./dashboard-throttle-rebalance.js");

  let res;
  try {
    res = await fetchWithCsrf("/api/position/can-reopen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token0: active.token0,
        token1: active.token1,
        token0Symbol: active.token0Symbol,
        token1Symbol: active.token1Symbol,
      }),
    });
  } catch (err) {
    handleManageFailure("manage", err.message, active);
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    /*- Server returns 503 + `wallet-read-unavailable` when the RPC /
     *  Moralis read couldn't complete after the retry budget was
     *  exhausted.  Surface in a dedicated modal that tells the user
     *  to try again in 10+ minutes (per the user-approved wording)
     *  rather than the generic alert, so the failure mode is
     *  recoverable without a restart. */
    if (res.status === 503 && body.error === "wallet-read-unavailable") {
      _showWalletReadUnavailableModal(body, active, formatPositionSpec);
      return;
    }
    handleManageFailure("manage", body.error || `HTTP ${res.status}`, active);
    return;
  }
  log.info(
    "[lp-ranger] [reopen] can-reopen check for #%s → canReopen=%s",
    active.tokenId,
    body.canReopen,
  );
  if (!body.canReopen) {
    _showInsufficientTokensModal(body, active, formatPositionSpec);
    return;
  }
  _showReopenIntroModal(active, formatPositionSpec, openRebalanceRangeModal);
}

/*- Render the "wallet read unavailable" modal when the server
 *  returned 503 + `wallet-read-unavailable`.  Raw err.message is
 *  injected via textContent (not innerHTML) into the existing
 *  scrollable error box from PR #137 so a misbehaving RPC message
 *  can't inject HTML.  Tells the user to wait at least 10 minutes
 *  before retrying — typical transient RPC / Moralis outages clear
 *  in well under that. */
const WALLET_READ_UNAVAILABLE_MODAL_ID =
  "9mm-pos-mgr-wallet-read-unavailable-modal";
function _showWalletReadUnavailableModal(body, active, formatPositionSpec) {
  const spec = formatPositionSpec(active);
  const html =
    "<p>Could not read your wallet balances and token prices from the blockchain right now.</p>" +
    (spec
      ? '<p class="9mm-pos-mgr-text-muted">Position: ' + spec + "</p>"
      : "") +
    '<div class="9mm-pos-mgr-err-scroll" data-err-slot></div>' +
    "<p>Try again later after 10 minutes or more.</p>";
  _createModal(
    WALLET_READ_UNAVAILABLE_MODAL_ID,
    "9mm-pos-mgr-modal-help",
    "Wallet read unavailable",
    html,
  );
  const overlay = document.getElementById(WALLET_READ_UNAVAILABLE_MODAL_ID);
  const slot = overlay?.querySelector("[data-err-slot]");
  if (slot) slot.textContent = body.message || "(no detail returned)";
}

/*- Render the "insufficient wallet tokens" modal.  Per-token
 *  textContent injection so a misbehaving on-chain symbol can't
 *  inject HTML.  Balance-slot lookup is SCOPED to the freshly-created
 *  overlay to avoid binding to a stale duplicate. */
const INSUFFICIENT_TOKENS_MODAL_ID = "9mm-pos-mgr-insufficient-tokens-modal";
function _showInsufficientTokensModal(body, active, formatPositionSpec) {
  const spec = formatPositionSpec(active);
  const thr = body.dustThresholdUsd?.toFixed
    ? body.dustThresholdUsd.toFixed(4)
    : String(body.dustThresholdUsd ?? "—");
  const html =
    "<p>To re-open this position you need at least one of the two pair tokens above the dust threshold (currently <strong>$" +
    thr +
    " USD</strong>).</p>" +
    (spec
      ? '<p class="9mm-pos-mgr-text-muted">Position: ' + spec + "</p>"
      : "") +
    "<p>Your wallet currently holds:</p>" +
    '<ul class="9mm-pos-mgr-reopen-balances">' +
    '<li data-token-slot="0"></li>' +
    '<li data-token-slot="1"></li>' +
    "</ul>" +
    '<p class="9mm-pos-mgr-text-muted">Fund the wallet with one or both tokens, then click Manage again.</p>';
  _createModal(
    INSUFFICIENT_TOKENS_MODAL_ID,
    "9mm-pos-mgr-modal-help",
    "Wallet has insufficient tokens to re-open",
    html,
  );
  const overlay = document.getElementById(INSUFFICIENT_TOKENS_MODAL_ID);
  if (!overlay) return;
  _injectBalanceRow(overlay, 0, body.balances?.token0);
  _injectBalanceRow(overlay, 1, body.balances?.token1);
}

/*- Inject "<symbol>: <amount> ($usd)" into the modal's balance-list
 *  slot via textContent.  Defensive against a bad on-chain symbol or
 *  missing per-token data in the response payload. */
function _injectBalanceRow(overlay, slot, bal) {
  const li = overlay.querySelector('[data-token-slot="' + slot + '"]');
  if (!li || !bal) return;
  const amountStr = Number(bal.amount).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
  const usdStr = Number(bal.usd).toFixed(4);
  li.textContent = `${bal.symbol}: ${amountStr} ($${usdStr})${bal.isDust ? "  — below threshold" : ""}`;
}

/*- Render the "re-open requires a rebalance" intro modal.  The
 *  standard modal template's footer ships an "OK" close button (used
 *  here as the dismiss action — user clicks OK to back out, edit
 *  settings, then re-click Manage).  We append a "Re-open Position"
 *  button in an action row inside the body for the proceed action.
 *
 *  IMPORTANT: scope every querySelector to the freshly-created
 *  overlay (by id) — a bare document-level lookup would bind to a
 *  stale duplicate if any prior modal with the same id is still in
 *  the DOM, leaving the new button inert. */
const REOPEN_INTRO_MODAL_ID = "9mm-pos-mgr-reopen-intro-modal";
function _showReopenIntroModal(
  active,
  formatPositionSpec,
  openRebalanceRangeModal,
) {
  const spec = formatPositionSpec(active);
  const html =
    "<p>Re-opening this position requires a rebalance to seed liquidity from your wallet.</p>" +
    (spec
      ? '<p class="9mm-pos-mgr-text-muted">Position: ' + spec + "</p>"
      : "") +
    '<p class="9mm-pos-mgr-text-muted">Review your rebalance settings below (range width, slippage) and edit them if needed — click OK to back out, edit, then click Manage again.  When ready, click <strong>Re-open Position</strong> to proceed.</p>' +
    '<div class="9mm-pos-mgr-modal-action-row">' +
    '<button type="button" class="modal-btn primary" data-action="reopen-confirm">Re-open Position</button>' +
    "</div>";
  _createModal(
    REOPEN_INTRO_MODAL_ID,
    "9mm-pos-mgr-modal-help",
    "Re-open closed position",
    html,
  );
  const overlay = document.getElementById(REOPEN_INTRO_MODAL_ID);
  const btn = overlay?.querySelector('[data-action="reopen-confirm"]');
  if (!btn) return;
  btn.addEventListener("click", () => {
    /*- Close the intro modal, then hand off to the existing rebalance
     *  modal.  Its Confirm path derives reopen context from position
     *  state and POSTs `/api/position/manage` with the re-open flags. */
    if (overlay) overlay.remove();
    openRebalanceRangeModal();
  });
}
