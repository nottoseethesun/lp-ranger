#!/usr/bin/env node
/**
 * @file scripts/inline-svgs.js
 * @description Build-time SVG inliner for `public/index.html`.
 *
 * Reads the source HTML (with `data-svg="icons/…" data-w=".." data-h=".."`
 * placeholder attributes) and writes `public/dist/index.html` (checked
 * into `.gitignore`) with each placeholder replaced by the actual
 * `<svg>` element from disk, sized per the `data-w` / `data-h` values.
 *
 * The server (`server.js`) serves `public/dist/index.html` at `/` when
 * it exists, falling back to `public/index.html` when it doesn't, so a
 * skipped build degrades gracefully — the page still boots, just with
 * empty placeholders where the UI icons would be.
 *
 * Runs from `npm run build` after `cache-bust.js` so the cache-bust
 * `?v=…` stamps flow through into the composed output.  See
 * docs/engineering.md § "SVG Assets" for the full policy.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { log } = require("../src/log");

const _ROOT = path.join(__dirname, "..");
const _SRC = path.join(_ROOT, "public", "index.html");
const _DIST_DIR = path.join(_ROOT, "public", "dist");
const _OUT = path.join(_DIST_DIR, "index.html");

/*- Extract a specific attribute's value from a raw HTML attrs blob.
 *  Returns null when the attribute isn't present.  Assumes double-
 *  quoted values (matches how index.html is authored). */
function _attr(attrs, name) {
  const re = new RegExp("\\b" + name + '="([^"]+)"');
  const m = attrs.match(re);
  return m ? m[1] : null;
}

/*- Remove a set of attribute assignments (with leading whitespace)
 *  from an attrs blob.  Leaves the surrounding attrs intact. */
function _stripAttrs(attrs, names) {
  let out = attrs;
  for (const n of names) {
    out = out.replace(new RegExp("\\s+" + n + '="[^"]*"', "g"), "");
  }
  return out;
}

/*- Load an icon file's contents.  Fails loudly (throws) when the
 *  referenced file is missing — better to break the build than to
 *  silently ship a page with a broken icon reference. */
function _readIcon(rel) {
  const abs = path.join(_ROOT, "public", rel);
  if (!fs.existsSync(abs)) {
    throw new Error("inline-svgs: referenced icon file not found: " + rel);
  }
  return fs.readFileSync(abs, "utf8").trim();
}

/*- Inject or replace width= / height= on the root <svg> tag.
 *  The source icons don't carry width/height (only viewBox), so this
 *  is normally a straight injection right after `<svg`. */
function _sizeSvg(svgText, w, h) {
  if (!w && !h) return svgText;
  const attrs = [];
  if (w) attrs.push('width="' + w + '"');
  if (h) attrs.push('height="' + h + '"');
  const injected = attrs.join(" ");
  return svgText.replace(/^<svg\b/, "<svg " + injected);
}

/*- Match any element (span / div / button, self-closing pair) that
 *  carries a data-svg="…" attribute.  The tag name is captured and
 *  back-referenced so we only match balanced open/close pairs, and
 *  the placeholder MUST be empty (no inner text) — we're replacing
 *  the whole inner content with the inlined SVG. */
const _PLACEHOLDER_RE = /<([a-zA-Z]+)([^>]*\bdata-svg="[^"]+"[^>]*)><\/\1>/g;

function _inlineHtml(html) {
  let replaced = 0;
  const out = html.replace(_PLACEHOLDER_RE, (whole, tag, attrs) => {
    const url = _attr(attrs, "data-svg");
    if (!url) return whole;
    const w = _attr(attrs, "data-w");
    const h = _attr(attrs, "data-h");
    const svgText = _sizeSvg(_readIcon(url), w, h);
    const cleaned = _stripAttrs(attrs, ["data-svg", "data-w", "data-h"]);
    replaced += 1;
    return "<" + tag + cleaned + ">" + svgText + "</" + tag + ">";
  });
  return { out, replaced };
}

function main() {
  if (!fs.existsSync(_SRC)) {
    console.error("[inline-svgs] source not found: " + _SRC);
    process.exit(1);
  }
  const html = fs.readFileSync(_SRC, "utf8");
  const { out, replaced } = _inlineHtml(html);
  if (!fs.existsSync(_DIST_DIR)) fs.mkdirSync(_DIST_DIR, { recursive: true });
  fs.writeFileSync(_OUT, out);
  log.info(
    "[npm run build process][inline-svgs] %d placeholder(s) inlined → %s\n",
    replaced,
    path.relative(process.cwd(), _OUT),
  );
}

main();
