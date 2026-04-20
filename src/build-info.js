/**
 * @file src/build-info.js
 * @description Server-side build/version info helper. Mirrors the browser's
 * auto-generated public/build-info.js but computes values lazily at require
 * time so no build step is required to run the server.
 *
 * Reads package.json (always present) for release version and shells out to
 * git for commit + tag (may be unavailable in a release tarball — falls back
 * to "unknown").
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

/**
 * Resolve build/version info for server-side logging.
 * @returns {{version:string, commit:string, commitDate:string, tag:(string|null)}}
 */
function getBuildInfo() {
  return {
    version: _pkgVersion(),
    commit: _git("git rev-parse --short HEAD") || "unknown",
    commitDate: _git("git log -1 --format=%cI") || "unknown",
    tag: _git("git describe --exact-match --tags HEAD") || null,
  };
}

/*-
 * Sentinel value for the development version in package.json. When the
 * package version matches this, the banner skips the `version=` segment
 * entirely — unreleased dev builds should not claim a version number.
 * Release workflow bumps package.json away from this sentinel before
 * building the release tarball.
 */
const DEV_VERSION_SENTINEL = "0.0.0-dev";

/**
 * Log a one-line version banner with the given prefix.
 * @param {string} prefix  Log prefix, e.g. "[server]".
 */
function logVersionBanner(prefix) {
  const bi = getBuildInfo();
  const isDev = bi.version === DEV_VERSION_SENTINEL;
  if (isDev) {
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
      bi.version,
      bi.commit,
      bi.commitDate,
      bi.tag || "(none)",
    );
  }
}

module.exports = { getBuildInfo, logVersionBanner, DEV_VERSION_SENTINEL };
