/**
 * @file dashboard-abort-reason.js
 * @description Why a rebalance stopped, read from the error the bot
 *   published for the position (`rebalanceError`). The one place the
 *   kinds of stop are told apart: the alert dialog takes its title and
 *   advice from the kind (dashboard-alerts.js), and the Manage button's
 *   tooltip names the main reason in a few words (dashboard-manage-ui.js).
 */

/**
 * The kind of stop an error names, or "" for one it names in no way
 * these recognise.
 * @param {string|null|undefined} message  The published error.
 * @returns {"midway"|"thin"|"slip"|"gas"|"volatile"|""}
 */
export function abortKind(message) {
  const m = message || "";
  if (m.includes("mid-rebalance") || m.includes("Mid-rebalance"))
    return "midway";
  if (m.includes("liquidity is too thin") || m.includes("no liquidity"))
    return "thin";
  if (m.includes("exceeds slippage")) return "slip";
  if (m.includes("insufficient gas")) return "gas";
  if (m.includes("too volatile")) return "volatile";
  return "";
}

/** Each kind's main reason, worded to follow "Re-open just failed: ". */
const _SUMMARIES = {
  midway: "it stopped partway, and the coins are safe in your wallet",
  thin: "the pool's liquidity is too thin",
  slip: "the swap's price impact was above your Slippage setting",
  gas: "the wallet is short of gas",
  volatile: "the price was moving too fast",
};

/*-
 *  An unrecognised error is quoted rather than summarised, so it is cut
 *  to its first sentence and to this many characters: a tooltip, not a
 *  log.
 */
const _QUOTE_MAX = 120;

/**
 * The main reason a rebalance stopped, in a few words: the kind's own
 * summary, or else the error's first sentence.
 * @param {string|null|undefined} message  The published error.
 * @returns {string}
 */
export function abortReasonSummary(message) {
  const kind = abortKind(message);
  if (kind !== "") return _SUMMARIES[kind];
  const text = typeof message === "string" ? message.trim() : "";
  if (text === "") return "an unexpected error";
  const first = text.split(/(?<=\.)\s/)[0].replace(/\.$/, "");
  return first.length > _QUOTE_MAX
    ? first.slice(0, _QUOTE_MAX - 1) + "…"
    : first;
}
