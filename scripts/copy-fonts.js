/**
 * @file scripts/copy-fonts.js
 * @description Copy self-hosted WOFF2 font files from the `@fontsource/*`
 * npm packages into `public/fonts/`. Runs automatically via the
 * `postinstall` lifecycle hook after `npm install` / `npm ci`.
 *
 * Keeping the fonts self-hosted (no CDN) avoids a third-party request
 * chain on dashboard load — see docs/engineering.md § Security for the
 * no-CDN posture.
 */

"use strict";

const { log } = require("../src/log");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "public", "fonts");

/** WOFF2 files to copy, relative to `node_modules/`. */
const FONTS = [
  // Space Mono — latin subset, 400 normal + italic, 700 normal
  "@fontsource/space-mono/files/space-mono-latin-400-normal.woff2",
  "@fontsource/space-mono/files/space-mono-latin-400-italic.woff2",
  "@fontsource/space-mono/files/space-mono-latin-700-normal.woff2",
  // Urbanist — latin subset, 400/600/700/800 normal
  "@fontsource/urbanist/files/urbanist-latin-400-normal.woff2",
  "@fontsource/urbanist/files/urbanist-latin-600-normal.woff2",
  "@fontsource/urbanist/files/urbanist-latin-700-normal.woff2",
  "@fontsource/urbanist/files/urbanist-latin-800-normal.woff2",
  // Rye — latin subset, 400 normal (Old West display face)
  "@fontsource/rye/files/rye-latin-400-normal.woff2",
];

fs.mkdirSync(DEST, { recursive: true });

for (const rel of FONTS) {
  const src = path.join(ROOT, "node_modules", rel);
  const dst = path.join(DEST, path.basename(rel));
  fs.copyFileSync(src, dst);
}

log.info("Fonts copied to %s", DEST);
