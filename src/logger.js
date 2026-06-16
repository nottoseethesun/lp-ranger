/**
 * @file logger.js
 * @description Per-log-line formatting helpers (`emojiId`, `abbrAddr`,
 *   `logCtx`).  The actual colorization + console wrapping was folded
 *   into `src/log.js` so the opt-in `log.*` chain handles every
 *   cross-cutting concern (timestamp, color, sink injection) in one
 *   place — see Core Essentials in `docs/claude/CLAUDE-BEST-PRACTICES.md`.
 */

"use strict";

const crypto = require("crypto");
const _EMOJI = [
  "🌵",
  "🔥",
  "⚡",
  "🌊",
  "🎯",
  "💎",
  "🚀",
  "🌙",
  "⭐",
  "🎪",
  "🦅",
  "🐎",
  "🌻",
  "🍀",
  "🎲",
  "🔔",
];
/** Convert a string to a 3-emoji fingerprint for quick visual identification. */
function emojiId(str) {
  const h = crypto.createHash("md5").update(String(str)).digest();
  return (
    "\x1b[48;2;0;0;0m" +
    _EMOJI[h[0] % 16] +
    _EMOJI[h[1] % 16] +
    _EMOJI[h[2] % 16] +
    "\x1b[0m"
  );
}

/** Abbreviated address: `0x4e44…61A`. Returns `?` for missing input. */
function abbrAddr(addr) {
  if (!addr || addr.length < 10) return addr || "?";
  return addr.slice(0, 6) + "…" + addr.slice(-3);
}

/*- Build the canonical 6-field log context string used by compound,
 *  rebalance, and swap entry-point loggers.  Keeps a single source of
 *  truth so every entry-point line is self-describing (chain, wallet,
 *  factory, tokenId+emoji, both token symbols) and disambiguates between
 *  positions when several are running concurrently.  See the
 *  `feedback-log-full-context` memory for the rule and rationale. */
function logCtx(opts) {
  const chain = opts.chain || "?";
  const wallet = abbrAddr(opts.wallet);
  const factory = abbrAddr(opts.factory);
  const tokenId =
    opts.tokenId === null || opts.tokenId === undefined
      ? "?"
      : String(opts.tokenId);
  const emoji = emojiId(tokenId);
  const s0 = opts.symbol0 || opts.token0Symbol || "Token0";
  const s1 = opts.symbol1 || opts.token1Symbol || "Token1";
  return `${chain} ${wallet} ${factory} #${tokenId} ${emoji} ${s0}/${s1}`;
}

module.exports = { emojiId, abbrAddr, logCtx };
