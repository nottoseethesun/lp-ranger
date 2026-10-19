/**
 * @file scripts/build-pages-site.js
 * @description Assemble the static GitHub Pages site into a target
 * directory, driven entirely by `.github/pages-site.yml`.
 *
 * Usage:
 *   node scripts/build-pages-site.js _site               # CI deploy
 *   node scripts/build-pages-site.js tmp/gallery-preview # local preview
 *
 * This file holds NO list of pages, assets, or rewrites. All of that is
 * declared in `.github/pages-site.yml` and read at run time. Restating
 * any of it here would recreate the duplication the spec exists to
 * remove: the same page list in YAML and in JS, free to drift.
 *
 * Why the site must be assembled at all: the published pages reference
 * their CSS absolutely and stamped (`/style.css?v=123`), which only
 * resolves while the dashboard server is running, the manual loads a
 * script that asks the running app, and the gallery references images
 * as `images/…`, which sits next to the HTML rather than in
 * `docs/images/`. A static host needs everything flat and relative, and
 * no script that asks for an app.
 *
 * Both callers — the deploy workflow and `npm run show-gallery` — go
 * through this function, so a local preview cannot drift from what
 * deploys. The workflow retains only what is genuinely CI's job
 * (`npm ci`, `npm run copy-fonts`); running those locally would wipe and
 * reinstall node_modules.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

/** Declarative spec: what to publish and how to rewrite it. */
const SPEC_PATH = path.join(".github", "pages-site.yml");

/**
 * Read and parse the site spec.
 *
 * Throws on a missing or malformed file rather than falling back to a
 * default: a silent partial build would deploy a site with pages or
 * assets quietly absent, which is worse than a failed build.
 * @returns {object} Parsed spec.
 */
function readSpec() {
  if (!fs.existsSync(SPEC_PATH)) {
    throw new Error(`Missing Pages site spec: ${SPEC_PATH}`);
  }
  const spec = YAML.parse(fs.readFileSync(SPEC_PATH, "utf8"));
  if (spec === null || typeof spec !== "object") {
    throw new Error(`Malformed Pages site spec: ${SPEC_PATH}`);
  }
  return spec;
}

/**
 * Copy a directory tree recursively.
 * @param {string} src
 * @param {string} dest
 * @returns {void}
 */
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Flatten `href="/sheet.css?v=123"` to `href="sheet.css"`.
 *
 * Done with string scanning rather than a constructed RegExp: the sheet
 * name comes from the spec file, and building a pattern from it would
 * both trip `security/detect-non-literal-regexp` and require escaping
 * every regex metacharacter a filename may legally contain.
 *
 * Only a segment continuing with `"` (no stamp) or `?` (a stamp) counts
 * as a match, so a longer name sharing the prefix — `gallery.css.map`
 * against `gallery.css` — is left alone rather than silently truncated.
 *
 * @param {string} html
 * @param {string} css  Stylesheet filename, e.g. `gallery.css`.
 * @returns {string}
 */
function flattenStampedHref(html, css) {
  const needle = `href="/${css}`;
  const parts = html.split(needle);
  if (parts.length === 1) return html;

  let out = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg.startsWith('"')) {
      out += `href="${css}${seg}`;
    } else if (seg.startsWith("?")) {
      const close = seg.indexOf('"');
      out += `href="${css}${close === -1 ? seg : seg.slice(close)}`;
    } else {
      /*- Prefix collision, not our stylesheet — put it back untouched. */
      out += needle + seg;
    }
  }
  return out;
}

/**
 * Remove each tag that loads the script at `src`, such as
 * `<script src="/dist/manual-figures.js?v=123" defer></script>`, with its
 * line when the tag stands alone on it, whatever stamp follows the path.
 *
 * String scanning, as `flattenStampedHref` does, for the same reasons;
 * and as there, a longer path sharing the prefix is left alone.
 *
 * @param {string} html
 * @param {string} src  The script's path as the page names it.
 * @returns {string}
 */
function dropScriptTag(html, src) {
  const needle = `<script src="${src}`;
  const close = "</script>";
  let out = html;
  let from = 0;
  for (;;) {
    const at = out.indexOf(needle, from);
    if (at === -1) return out;
    const next = out[at + needle.length];
    const end = out.indexOf(close, at);
    if ((next !== '"' && next !== "?") || end === -1) {
      from = at + needle.length;
      continue;
    }
    const lineStart = out.lastIndexOf("\n", at) + 1;
    const newline = out.indexOf("\n", end);
    const lineEnd = newline === -1 ? out.length : newline + 1;
    const alone =
      out.slice(lineStart, at).trim() === "" &&
      out.slice(end + close.length, lineEnd).trim() === "";
    const start = alone ? lineStart : at;
    const stop = alone ? lineEnd : end + close.length;
    out = out.slice(0, start) + out.slice(stop);
    from = start;
  }
}

/**
 * Make one page's stylesheet links relative and unstamped, drop the
 * scripts that ask the running app, and write the page into the output
 * directory.
 * @param {{src: string, css: string}} page
 * @param {{sharedSheets?: string[], droppedScripts?: string[]}} spec
 * @param {string} outDir
 * @returns {void}
 */
function writePage(page, spec, outDir) {
  if (!fs.existsSync(page.src)) return;
  let html = fs.readFileSync(page.src, "utf8");
  for (const css of [...(spec.sharedSheets ?? []), page.css])
    html = flattenStampedHref(html, css);
  for (const src of spec.droppedScripts ?? []) html = dropScriptTag(html, src);
  fs.writeFileSync(path.join(outDir, path.basename(page.src)), html);
}

/**
 * Copy the self-hosted fonts named by the spec, when present.
 * @param {{from: string, to: string, extension: string}|undefined} fonts
 * @param {string} outDir
 * @returns {void}
 */
function copyFonts(fonts, outDir) {
  if (!fonts || !fs.existsSync(fonts.from)) return;
  const dest = path.join(outDir, fonts.to);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(fonts.from)) {
    if (f.endsWith(fonts.extension)) {
      fs.copyFileSync(path.join(fonts.from, f), path.join(dest, f));
    }
  }
}

/**
 * Assemble the full site into `outDir`, replacing anything already there.
 * @param {string} outDir  Target directory, e.g. `_site`.
 * @returns {void}
 */
function buildPagesSite(outDir) {
  const spec = readSpec();

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const page of spec.pages || []) {
    writePage(page, spec, outDir);
  }

  for (const file of spec.flatAssets || []) {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(outDir, path.basename(file)));
    }
  }

  copyFonts(spec.fonts, outDir);

  for (const tree of spec.trees || []) {
    if (fs.existsSync(tree.from)) {
      copyTree(tree.from, path.join(outDir, tree.to));
    }
  }
}

module.exports = { buildPagesSite, readSpec, writePage, SPEC_PATH };

/*- CLI entry point: only runs when invoked directly, so `show-gallery`
 *  can require the builder without triggering a build on import. */
if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node scripts/build-pages-site.js <outDir>");
    process.exit(1);
  }
  buildPagesSite(outDir);
  console.log(
    "[build-pages-site] assembled into %s from %s",
    outDir,
    SPEC_PATH,
  );
}
