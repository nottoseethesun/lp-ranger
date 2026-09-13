/**
 * @file scripts/show-gallery.js
 * @description Serve the Screenshot Gallery locally, exactly as GitHub
 * Pages will publish it.
 *
 * The assembly itself is NOT here — it lives in
 * `scripts/build-pages-site.js`, the single implementation shared with
 * the "Assemble site" step of `.github/workflows/pages.yml`. This file
 * only chooses an output directory, serves it, and reports missing
 * images. That split is the point: a preview that reimplemented the
 * assembly could drift from what actually deploys, which is precisely
 * the failure it exists to catch.
 *
 * Why a server rather than opening the file: the published pages
 * reference their CSS absolutely and the gallery references images as
 * `images/…`, which resolves next to the HTML rather than into
 * `docs/images/`. Opened straight off disk the page shows no images at
 * all.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { buildPagesSite } = require("./build-pages-site");
const { findListenerPids } = require("./_find-process");

/** Where the assembled site is written. Gitignored, like the rest of tmp/. */
const OUT_DIR = path.join("tmp", "gallery-preview");

/** Port for the preview server. 5555 is the app, 5556 the API reference. */
const PORT = 5557;

/** Extension → Content-Type for the static handler. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

/**
 * Report every image the gallery references that is absent from disk.
 * @returns {string[]} Missing filenames, empty when the gallery is whole.
 */
function findMissingImages() {
  const src = "public/screenshot-gallery.html";
  if (!fs.existsSync(src)) return [];
  const html = fs.readFileSync(src, "utf8");
  const referenced = new Set(
    [...html.matchAll(/images\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]),
  );
  return [...referenced]
    .filter((f) => !fs.existsSync(path.join(OUT_DIR, "images", f)))
    .sort();
}

/**
 * Resolve a request path to a file inside OUT_DIR, refusing anything that
 * escapes it.
 * @param {string} urlPath
 * @returns {string|null} Absolute path, or null when out of bounds.
 */
function resolveSafe(urlPath) {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  const target = path.resolve(OUT_DIR, rel || "screenshot-gallery.html");
  const root = path.resolve(OUT_DIR);
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

/**
 * Stop anything already listening on the preview port.
 *
 * Without this, re-running the command exits with EADDRINUSE against
 * its own leftover server. Killing by PORT rather than by process name
 * is deliberate: a name pattern like `show-gallery` also matches the
 * shell that launched the lookup, so a pattern-based kill can take out
 * its own caller.
 * @returns {void}
 */
function freePort() {
  for (const pid of findListenerPids(PORT)) {
    try {
      process.kill(pid, "SIGTERM");
      console.log("[show-gallery] stopped previous preview (pid %d)", pid);
    } catch {
      /* Already gone, or not ours to kill — listen() will report it. */
    }
  }
}

/**
 * Open a URL in the default browser.
 *
 * Detached and with streams ignored so the opener cannot hold this
 * process open or spam its output. Failure is non-fatal: the URL is
 * printed regardless, so a headless or unusual desktop just means
 * clicking the link manually.
 * @param {string} url
 * @returns {void}
 */
function openBrowser(url) {
  const opener =
    process.platform === "darwin"
      ? { cmd: "open", args: [url] }
      : process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] };
  try {
    const child = spawn(opener.cmd, opener.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* No opener available — the printed URL is the fallback. */
  }
}

/**
 * Serve the assembled directory and print where to visit.
 * @returns {void}
 */
function serve() {
  const server = http.createServer((req, res) => {
    const file = resolveSafe(req.url || "/");
    if (
      file === null ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(PORT, "127.0.0.1", () => {
    const missing = findMissingImages();
    if (missing.length > 0) {
      console.log(
        "\n[show-gallery] %d referenced image(s) missing from docs/images:",
        missing.length,
      );
      for (const f of missing) console.log("  - %s", f);
    }
    const url = `http://127.0.0.1:${PORT}/screenshot-gallery.html`;
    console.log("\n[show-gallery] Screenshot Gallery preview — Ctrl+C to stop");
    console.log(url);
    console.log("");
    openBrowser(url);
  });
}

freePort();
buildPagesSite(OUT_DIR);
serve();
