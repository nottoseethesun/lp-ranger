/**
 * @file logger.js
 * @description Colored console logging for server-side log prefixes.
 *   Patches console.log/warn/error to colorize known prefixes.
 *   Call once at startup — no per-file changes needed.
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

const COLORS = {
  "[server]": "\x1b[38;2;0;191;255m", // azure blue
  "[bot]": "\x1b[38;2;200;160;255m", // light purple
  "[rebalance]": "\x1b[38;2;255;250;205m", // Lemon Chiffon (#FFFACD)
  "[event-scanner]": "\x1b[38;2;60;80;180;48;2;255;228;196m", // dark blue on bisque
  "[history]": "\x1b[38;2;160;120;80m", // light brown
  "[pos-mgr]": "\x1b[35;48;2;242;242;242m", // magenta on 95% white
  "[pos-route]": "\x1b[35;48;2;255;255;255m", // magenta on white
  "[pos-state]": "\x1b[35;48;2;230;230;230m", // magenta on 90% white
  "[compound]": "\x1b[38;2;163;255;43m", // neon green #a3ff2b
  "[pnl]": "\x1b[38;2;0;130;0m", // dark green
  "[position details]": "\x1b[38;2;225;217;209m", // dark white (#E1D9D1)
  "[native]": "\x1b[33m", // yellow
  "[aggregator]": "\x1b[33m", // yellow (same as [rebalance])
  "[price-fetcher]": "\x1b[38;2;124;252;0m", // lawn green
  "[wallet]": "\x1b[38;2;211;211;211;48;2;15;70;15m", // light gray on dark forest green
  "[gas-monitor]": "\x1b[38;2;255;255;0;48;2;139;0;0m", // yellow on dull red
  "[moralis]": "\x1b[38;2;232;228;201m", // Dirty White (#E8E4C9)
  "[telegram]": "\x1b[38;2;232;228;201m", // Dirty White (#E8E4C9)
  // Classic Burgundy (#800020) on Metallic Gold (#D4AF37)
  "[dust-unit-price]": "\x1b[38;2;128;0;32;48;2;212;175;55m",
  // Black (#000000) on Dollar Bill Green (#85BB65)
  "[deposit]": "\x1b[38;2;0;0;0;48;2;133;187;101m",
};
const RESET = "\x1b[0m";

// Substring highlights: bold black on colored backgrounds
const HIGHLIGHTS = [
  { text: "Rebalance requested", style: "\x1b[1;30;48;2;255;140;0m" }, // bold black on chevrolet orange
  {
    text: "Manual rebalance",
    style: "\x1b[38;2;60;60;60;48;2;255;140;0m",
    toEnd: true,
  }, // dark grey on chevrolet orange (rest of line)
  { text: "Rebalance OK", style: "\x1b[48;2;0;60;120m", toEnd: true }, // light purple text (from [bot] prefix) on deep azure bg
  {
    text: "Position selected:",
    style: "\x1b[38;2;80;40;0;48;2;124;252;0m",
    toEnd: true,
  }, // dark brown text on lawn green bg
];

function _colorize(args) {
  if (typeof args[0] !== "string") return args;
  for (const [tag, color] of Object.entries(COLORS)) {
    if (args[0].startsWith(tag)) {
      args[0] = color + args[0] + RESET;
      break;
    }
  }
  for (const h of HIGHLIGHTS) {
    const idx = args[0].indexOf(h.text);
    if (idx >= 0) {
      if (h.toEnd) {
        args[0] = args[0].slice(0, idx) + h.style + args[0].slice(idx) + RESET;
      } else {
        args[0] = args[0].replace(h.text, h.style + h.text + RESET);
      }
      break;
    }
  }
  return args;
}

/** Patch console.log and console.warn to colorize known prefixes. */
function installColorLogger() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args) => origLog(..._colorize(args));
  console.warn = (...args) => origWarn(..._colorize(args));
  console.error = (...args) => origErr(..._colorize(args));
}

module.exports = { installColorLogger, emojiId };
