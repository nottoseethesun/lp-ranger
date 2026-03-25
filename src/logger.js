/**
 * @file logger.js
 * @description Colored console logging for server-side log prefixes.
 *   Patches console.log/warn/error to colorize known prefixes.
 *   Call once at startup — no per-file changes needed.
 */

'use strict';

const crypto = require('crypto');
const _EMOJI = ['🌵','🔥','⚡','🌊','🎯','💎','🚀','🌙','⭐','🎪','🦅','🐎','🌻','🍀','🎲','🔔'];
/** Convert a string to a 3-emoji fingerprint for quick visual identification. */
function emojiId(str) { const h = crypto.createHash('md5').update(String(str)).digest(); return _EMOJI[h[0] % 16] + _EMOJI[h[1] % 16] + _EMOJI[h[2] % 16]; }

const COLORS = {
  '[server]':        '\x1b[38;2;0;191;255m',   // azure blue
  '[bot]':           '\x1b[38;2;200;160;255m',   // light purple
  '[rebalance]':     '\x1b[33m',                // yellow
  '[event-scanner]': '\x1b[38;2;60;80;180m',     // dark blue
  '[history]':       '\x1b[38;2;160;120;80m',   // light brown
  '[pos-mgr]':       '\x1b[35m',                // magenta
  '[pos-route]':     '\x1b[35m',                // magenta
  '[pos-state]':     '\x1b[35m',                // magenta
  '[pnl]':           '\x1b[38;2;0;130;0m',       // dark green
  '[details]':       '\x1b[38;2;0;191;255m',    // azure blue (server-side)
  '[native]':        '\x1b[33m',                // yellow
  '[price-fetcher]': '\x1b[38;2;124;252;0m',    // lawn green
};
const RESET = '\x1b[0m';

// Substring highlights: bold black on colored backgrounds
const HIGHLIGHTS = [
  { text: 'Rebalance requested', style: '\x1b[1;30;48;2;255;140;0m' }, // bold black on chevrolet orange
];

function _colorize(args) {
  if (typeof args[0] !== 'string') return args;
  for (const [tag, color] of Object.entries(COLORS)) {
    if (args[0].startsWith(tag)) { args[0] = color + args[0] + RESET; break; }
  }
  for (const h of HIGHLIGHTS) {
    if (args[0].includes(h.text)) { args[0] = args[0].replace(h.text, h.style + h.text + RESET); break; }
  }
  return args;
}

/** Patch console.log and console.warn to colorize known prefixes. */
function installColorLogger() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  console.log = (...args) => origLog(..._colorize(args));
  console.warn = (...args) => origWarn(..._colorize(args));
}

module.exports = { installColorLogger, emojiId };
