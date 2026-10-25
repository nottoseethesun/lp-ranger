/**
 * @file scripts/build-info.js
 * @description Generates src/client/web/build-info.js AND src/server/build-info.json at
 * build time with the current git commit hash, commit date, and release
 * tag (if HEAD is tagged). Values are frozen at build time so they work
 * under any deployment scenario — even without the .git directory.
 *
 * Two outputs:
 *   * `src/client/web/build-info.js` — ES-module consumed by the dashboard bundle.
 *   * `src/server/build-info.json`  — read by `src/server/build-info.js` at server
 *     startup, so a release tarball (which excludes `.git`) can still log
 *     its version banner without shelling out to git.
 */

"use strict";

const { log } = require("../src/lib/log");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function git(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const commit = git("git rev-parse --short HEAD") || "unknown";
const commitDate = git("git log -1 --format=%cI") || "unknown";
const tag = git("git describe --exact-match --tags HEAD") || null;

/*- Read version from package.json. Unlike the git-derived fields above,
 *  this is ALWAYS available in a release tarball because package.json
 *  ships in the tarball. This is the canonical release-version source —
 *  git tags require a tagged HEAD at build time, which isn't guaranteed. */
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);
const packageVersion = pkg.version || "unknown";

const out = path.join(__dirname, "..", "src", "client", "web", "build-info.js");
const content = `/**
 * @file build-info.js
 * @description Auto-generated at build time by scripts/build-info.js.
 * Do not edit manually.
 */

export const BUILD_COMMIT = ${JSON.stringify(commit)};
export const BUILD_COMMIT_DATE = ${JSON.stringify(commitDate)};
export const BUILD_RELEASE_TAG = ${JSON.stringify(tag)};
export const BUILD_PACKAGE_VERSION = ${JSON.stringify(packageVersion)};
`;

fs.writeFileSync(out, content);

/*- Server-side sidecar. Mirrors the four fields above as plain JSON so
 *  `src/server/build-info.js` can read them at startup inside a release tarball
 *  that has no `.git` directory. Gitignored — regenerated on every build. */
const jsonOut = path.join(__dirname, "..", "src", "server", "build-info.json");
fs.writeFileSync(
  jsonOut,
  JSON.stringify(
    {
      version: packageVersion,
      commit,
      commitDate,
      tag,
    },
    null,
    2,
  ) + "\n",
);

log.info(
  "[npm run build process] [build-info] version=%s commit=%s date=%s tag=%s",
  packageVersion,
  commit,
  commitDate,
  tag || "(none)",
);
