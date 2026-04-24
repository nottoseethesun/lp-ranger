/**
 * @file dashboard-post-rebalance-modal.js
 * @description Post-rebalance warning modals ("Range Width Adjusted"
 * and "Residual Above Threshold"), one combined dialog per position
 * that has a new warning in the current poll. Both dedup trackers are
 * keyed by composite key so warnings on one position never block
 * warnings on another, and every modal is labeled from the originating
 * position's state (never from the currently-viewed tab).
 */

/*- Per-key dedup. `_rrShown` is a Set of keys for which the current
 *  rangeRounded has already produced a modal; `_rwShownAt` maps
 *  key → last-shown residualWarning.at so a new residual event on the
 *  same key re-fires. */
const _rrShown = new Set();
const _rwShownAt = new Map();

/** Build the "Range Width Adjusted" HTML section. */
function _rangeRoundedHtml(rr) {
  return (
    "<p>Requested <strong>" +
    rr.requested +
    "%</strong> but tick spacing rounded to <strong>" +
    rr.effective +
    '%</strong>.</p><p class="9mm-pos-mgr-text-muted">V3 uses tick-spacing multiples.</p>'
  );
}

/**
 * Build the "Residual Above Threshold" HTML section.  Short sentences
 * so the user can skim.  The primary figure is the total wallet residual
 * USD for this pool (the same number the Lifetime panel shows), so the
 * dialog and the Lifetime panel never disagree.  The corrective-swap
 * loop's last-iteration uncorrected imbalance is still reported as
 * supporting technical detail.
 */
function _residualWarningHtml(rw) {
  const walletResidual = Number(rw.walletResidualUsd || 0).toFixed(2);
  const imb = Number(rw.imbalanceUsd || 0).toFixed(2);
  const thr = Number(rw.thresholdUsd || 0).toFixed(2);
  return (
    "<p>A small amount of tokens was left over after this rebalance.</p>" +
    "<p>Residual value in wallet for this pool: <strong>$" +
    walletResidual +
    "</strong>.</p>" +
    '<p class="9mm-pos-mgr-text-muted">' +
    "The corrective-swap loop couldn\u2019t fully balance the leftover tokens \u2014 " +
    "its final uncorrected imbalance was $" +
    imb +
    " (above the $" +
    thr +
    " dust threshold). " +
    "We retried up to " +
    rw.iterations +
    " times and gave up to avoid endless looping. " +
    "Your tokens are safe in your wallet. " +
    "The bot sweeps residuals automatically 10 minutes after each rebalance when they exceed 5% of the position\u2019s value, " +
    "or you can click <strong>Rebalance</strong> to try again sooner." +
    "</p>"
  );
}

function _showForKey(key, st, createModal, posContextHtmlForState) {
  const rrNew = st.rangeRounded && !_rrShown.has(key);
  const rwAt = st.residualWarning?.at || null;
  const rwNew = st.residualWarning && rwAt !== _rwShownAt.get(key);
  if (!rrNew && !rwNew) return;
  const parts = [];
  let title;
  if (rrNew && rwNew) {
    title = "Rebalance \u2014 Range Adjusted & Residual Left";
    parts.push(
      "<h4>Range width adjusted</h4>",
      _rangeRoundedHtml(st.rangeRounded),
    );
    parts.push(
      "<h4>Residual above threshold</h4>",
      _residualWarningHtml(st.residualWarning),
    );
  } else if (rrNew) {
    title = "Range Width Adjusted";
    parts.push(_rangeRoundedHtml(st.rangeRounded));
  } else {
    title = "Residual Above Threshold";
    parts.push(_residualWarningHtml(st.residualWarning));
  }
  if (rrNew) _rrShown.add(key);
  if (rwNew) _rwShownAt.set(key, rwAt);
  createModal(
    null,
    "9mm-pos-mgr-modal-caution",
    title,
    posContextHtmlForState(key, st) + parts.join(""),
  );
}

/**
 * Compose one combined modal per position with new post-rebalance
 * warnings. Iterates all per-position states so warnings on any
 * managed position surface correctly — not just the viewed tab.
 *
 * @param {object} allStates  `_allPositionStates` from /api/status.
 * @param {Function} createModal  injected _createModal (avoids circular import).
 * @param {Function} posContextHtmlForState  injected (key, st) context builder.
 */
export function showPostRebalanceWarnings(
  allStates,
  createModal,
  posContextHtmlForState,
) {
  const all = allStates || {};
  /*- Reap stale rangeRounded dedup entries so a future rebalance on
   *  the same position can re-surface. Residual uses `at` so it
   *  self-deduplicates. */
  for (const key of Array.from(_rrShown)) {
    if (!all[key]?.rangeRounded) _rrShown.delete(key);
  }
  for (const [key, st] of Object.entries(all)) {
    _showForKey(key, st, createModal, posContextHtmlForState);
  }
}

/** Test-only reset for dedup state. */
export function _resetPostRebalanceModalState() {
  _rrShown.clear();
  _rwShownAt.clear();
}
