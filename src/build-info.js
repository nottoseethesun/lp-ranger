/**
 * @file src/build-info.js
 * @description Server-side build/version info helper. Mirrors the browser's
 * auto-generated public/build-info.js.
 *
 * Resolution order:
 *   1. `src/build-info.json` — baked sidecar written by
 *      `scripts/build-info.js` during `npm run build`. Ships in release
 *      tarballs, which don't include `.git`.
 *   2. Live git + package.json — the fallback for dev clones that haven't
 *      run a build yet (git metadata is available locally).
 *
 * Never throws — missing data degrades to "unknown" so the banner always
 * prints something.
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function _git(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function _pkgVersion() {
  try {
    const p = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    );
    return p.version || "unknown";
  } catch {
    return "unknown";
  }
}

function _readBaked() {
  try {
    const baked = JSON.parse(
      fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8"),
    );
    return {
      version: baked.version || "unknown",
      commit: baked.commit || "unknown",
      commitDate: baked.commitDate || "unknown",
      tag: baked.tag || null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve build/version info for server-side logging. Prefers the baked
 * sidecar; falls back to live git when it's absent (pre-build dev clones).
 * @returns {{version:string, commit:string, commitDate:string, tag:(string|null)}}
 */
function getBuildInfo() {
  const baked = _readBaked();
  if (baked) return baked;
  return {
    version: _pkgVersion(),
    commit: _git("git rev-parse --short HEAD") || "unknown",
    commitDate: _git("git log -1 --format=%cI") || "unknown",
    tag: _git("git describe --exact-match --tags HEAD") || null,
  };
}

/*-
 * Sentinel value for the unreleased-dev version in package.json.  An
 * unreleased dev build that also has no git tag on HEAD shouldn't
 * claim any version at all in the banner.  A release tarball, by
 * contrast, is authoritative via its baked-in git tag even though its
 * package.json still reads "0.0.0-dev" — the tag wins.
 */
const DEV_VERSION_SENTINEL = "0.0.0-dev";

/**
 * Compute the banner-display version. Prefers the git tag (authoritative
 * for releases); falls back to package.json version; suppresses the
 * segment entirely for unreleased dev builds on untagged commits.
 * Exported for unit tests.
 * @param {{version:string, tag:(string|null)}} bi  Build info.
 * @returns {string|null}  Version to display, or null to suppress.
 */
function _displayVersion(bi) {
  if (bi.tag) return bi.tag;
  if (bi.version && bi.version !== DEV_VERSION_SENTINEL) return bi.version;
  return null;
}

/**
 * Log a one-line version banner with the given prefix.
 * @param {string} prefix  Log prefix, e.g. "[server]".
 */
function logVersionBanner(prefix) {
  const bi = getBuildInfo();
  const display = _displayVersion(bi);
  if (display === null) {
    console.log(
      "%s LP Ranger commit=%s commitDate=%s tag=%s",
      prefix,
      bi.commit,
      bi.commitDate,
      bi.tag || "(none)",
    );
  } else {
    console.log(
      "%s LP Ranger version=%s commit=%s commitDate=%s tag=%s",
      prefix,
      display,
      bi.commit,
      bi.commitDate,
      bi.tag || "(none)",
    );
  }
}

module.exports = {
  getBuildInfo,
  logVersionBanner,
  _displayVersion,
  DEV_VERSION_SENTINEL,
};
