/**
 * @file scripts/check-build-artifacts.js
 * @description Fail-loud pre-start guard.  Verifies that the build
 *   artifacts which `npm run build` generates are present on disk
 *   before `node server.js` starts.  Without them, the dashboard
 *   would load a 404'd `bundle.js` and silently skip the disclaimer
 *   and setup-wallet modals — a frustrating debugging trap that bit
 *   us in production on 0.8.0.
 *
 *   Wired into the `prestart` npm script so it runs automatically
 *   before `npm start` (no extra step required from the operator).
 *
 *   Two install paths produce a tree missing these files:
 *     1. Operator downloaded the GitHub-auto-generated "Source code
 *        (tar.gz)" archive instead of the release ASSET — the source
 *        archive is `git archive` output which strips every gitignored
 *        path, including `public/dist/`, `public/build-info.js`,
 *        `public/disclosure-content.js`, and `src/build-info.json`.
 *     2. Operator cloned the repo with `git clone` and skipped
 *        `npm run build` before `npm start`.
 *
 *   In both cases the fix is the same: run `npm run build` (or
 *   re-download the correct release asset).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/*- The four artifacts that `npm run build` writes and that the server
 *  / dashboard depend on at runtime.  Listed with a one-line "what it
 *  is" so the error message points at the symptom each one causes. */
const REQUIRED = [
  {
    rel: "public/dist/bundle.js",
    role: "dashboard JS bundle (built by esbuild from dashboard-init.js)",
  },
  {
    rel: "public/build-info.js",
    role: "version banner module imported by the dashboard bundle",
  },
  {
    rel: "public/disclosure-content.js",
    role: "disclaimer modal content (extracted from docs/disclosure.md)",
  },
  {
    rel: "src/build-info.json",
    role: "server-side version sidecar read by src/build-info.js at boot",
  },
];

const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, f.rel)));

if (missing.length === 0) process.exit(0);

/*- Write directly to process.stderr instead of going through console
 *  / log so this guard works even if the log module / its imports
 *  are themselves missing (defence in depth: the guard fires first). */
const lines = [
  "",
  "✘ Missing build artifacts — `npm start` cannot run.",
  "",
  "The following file(s) were expected but not found:",
  ...missing.map((f) => `  • ${f.rel}  — ${f.role}`),
  "",
  "Cause: this tree was installed without the build artifacts that",
  "`npm run build` generates.  Two common ways this happens:",
  "",
  "  1. You downloaded the GitHub `Source code (tar.gz)` auto-link",
  "     from the release page instead of the release ASSET.  The",
  "     auto-link is `git archive` output which strips every",
  "     gitignored path (including all four files above).",
  "     Fix: re-download the file named",
  "     `lp-ranger-<version>.tar.gz` from the Assets section of",
  "     https://github.com/nottoseethesun/lp-ranger/releases — NOT",
  "     the `Source code` link.",
  "",
  "  2. You cloned the repo via `git clone` and skipped the build.",
  "     Fix: run `npm run build` before `npm start`.",
  "",
];
process.stderr.write(lines.join("\n") + "\n");
process.exit(1);
