/**
 * @file scripts/build-info.js
 * @description Generates public/build-info.js at build time with the current
 * git commit hash, commit date, and release tag (if HEAD is tagged).
 * Values are frozen at build time so they work under any deployment
 * scenario — even without the .git directory.
 */

"use strict";

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

const out = path.join(__dirname, "..", "public", "build-info.js");
const content = `/**
 * @file build-info.js
 * @description Auto-generated at build time by scripts/build-info.js.
 * Do not edit manually.
 */

export const BUILD_COMMIT = ${JSON.stringify(commit)};
export const BUILD_COMMIT_DATE = ${JSON.stringify(commitDate)};
export const BUILD_RELEASE_TAG = ${JSON.stringify(tag)};
`;

fs.writeFileSync(out, content);
console.log(
  "[build-info] commit=%s date=%s tag=%s",
  commit,
  commitDate,
  tag || "(none)",
);
