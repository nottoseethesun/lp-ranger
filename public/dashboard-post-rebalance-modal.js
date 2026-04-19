/**
 * @file dashboard-post-rebalance-modal.js
 * @description Single combined modal for post-rebalance warnings.  The
 * "tick-adjustment" warning (range width rounded to tick spacing) and
 * the "residual above threshold" warning (corrective-swap cap reached)
 * are merged into one dialog when both fire in the same status update,
 * so the user only has to dismiss one modal per rebalance.  Extracted
 * from dashboard-data-status.js for line-count compliance.
 */

let _rangeRoundedShown = false;
let _residualWarningAtShown = null;

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
 * so the user can skim.  Explains why the residual is left over and
 * that they can manually rebalance later to reduce it.
 */
function _residualWarningHtml(rw) {
  const imb = Number(rw.imbalanceUsd || 0).toFixed(2);
  const thr = Number(rw.thresholdUsd || 0).toFixed(2);
  return (
    "<p>A small amount of tokens was left over after this rebalance.</p>" +
    "<p>Residual value: <strong>$" +
    imb +
    "</strong>. Our dust threshold is <strong>$" +
    thr +
    "</strong>.</p>" +
    '<p class="9mm-pos-mgr-text-muted">' +
    "This happens when the corrective swap also moves the pool price. " +
    "We retried up to " +
    rw.iterations +
    " times and gave up to avoid endless looping. " +
    "Your tokens are safe in your wallet. " +
    "You can click <strong>Rebalance</strong> later to try again and reduce the residual." +
    "</p>"
  );
}

/**
 * Compose one combined modal for whichever post-rebalance warnings
 * are new in this status update.  Does nothing if neither is new.
 *
 * @param {object} d         status doc from /api/status
 * @param {Function} createModal  injected _createModal (avoids circular import)
 * @param {Function} posContextHtml  injected _posContextHtml
 */
export function showPostRebalanceWarnings(d, createModal, posContextHtml) {
  const rrNew = d.rangeRounded && !_rangeRoundedShown;
  const rwAt = d.residualWarning?.at || null;
  const rwNew = d.residualWarning && rwAt !== _residualWarningAtShown;
  if (!rrNew && !rwNew) return;
  const parts = [];
  let title;
  if (rrNew && rwNew) {
    title = "Rebalance \u2014 Range Adjusted & Residual Left";
    parts.push(
      "<h4>Range width adjusted</h4>",
      _rangeRoundedHtml(d.rangeRounded),
    );
    parts.push(
      "<h4>Residual above threshold</h4>",
      _residualWarningHtml(d.residualWarning),
    );
  } else if (rrNew) {
    title = "Range Width Adjusted";
    parts.push(_rangeRoundedHtml(d.rangeRounded));
  } else {
    title = "Residual Above Threshold";
    parts.push(_residualWarningHtml(d.residualWarning));
  }
  if (rrNew) _rangeRoundedShown = true;
  if (rwNew) _residualWarningAtShown = rwAt;
  createModal(
    null,
    "9mm-pos-mgr-modal-caution",
    title,
    posContextHtml() + parts.join(""),
  );
}

/** Test-only reset for dedup state. */
export function _resetPostRebalanceModalState() {
  _rangeRoundedShown = false;
  _residualWarningAtShown = null;
}
