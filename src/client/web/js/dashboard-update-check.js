/**
 * @file dashboard-update-check.js
 * @description GitHub release update check for the About dialog.
 * Extracted from dashboard-events.js to keep that file under the 500-line limit.
 */

import { g, cloneTpl } from "./dashboard-helpers.js";

const _GH_API = "https://api.github.com/repos/nottoseethesun/lp-ranger";

/**
 * Compare two semver-ish version strings (e.g. "2.0.1" vs "2.1.0").
 * Returns negative if a < b, positive if a > b, 0 if equal.
 * Non-numeric segments are compared lexically.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const na = parseInt(pa[i] || "0", 10);
    const nb = parseInt(pb[i] || "0", 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const cmp = (pa[i] || "").localeCompare(pb[i] || "");
      if (cmp !== 0) return cmp;
    } else if (na !== nb) {
      return na - nb;
    }
  }
  return 0;
}

/**
 * Check GitHub for a release newer than the running build.  Prefers the
 * original commit-date comparison when commit info is available (dev /
 * release builds with .git).  Falls back to package-version comparison
 * only when commit info is unknown (production tarballs built without
 * .git available).
 */
export async function checkForUpdate() {
  const row = g("aboutUpdateRow");
  if (!row) return;
  const commitDate = row.dataset.commitDate;
  const packageVersion = row.dataset.packageVersion;
  const haveCommit = commitDate && commitDate !== "unknown";
  const havePkgVer = packageVersion && packageVersion !== "unknown";
  if (!haveCommit && !havePkgVer) {
    row.textContent = "";
    return;
  }
  row.textContent = "Checking for updates\u2026";
  try {
    const relRes = await fetch(_GH_API + "/releases/latest");
    if (!relRes.ok) {
      row.textContent = "";
      return;
    }
    const rel = await relRes.json();
    const tag = rel.tag_name;
    if (!tag) {
      row.textContent = "";
      return;
    }
    const latestVer = tag.replace(/^v/, "");
    const newer = await _isLatestNewer({
      tag,
      latestVer,
      haveCommit,
      commitDate,
      packageVersion,
    });
    if (newer === null) {
      row.textContent = "";
      return;
    }
    if (newer) {
      const frag = cloneTpl("tplAboutUpdate");
      if (frag) {
        frag.querySelector('[data-tpl="ver"]').textContent = latestVer;
        frag.querySelector('[data-tpl="link"]').href = rel.html_url;
        row.replaceChildren(frag);
      }
    } else {
      row.textContent = "Up to date";
    }
  } catch {
    row.textContent = "";
  }
}

/**
 * Decide whether the latest GitHub release is newer than the running build.
 * Returns true/false on success, or null if the comparison cannot be made.
 * @param {{ tag: string, latestVer: string, haveCommit: boolean,
 *           commitDate: string, packageVersion: string }} opts
 * @returns {Promise<boolean|null>}
 */
async function _isLatestNewer({
  tag,
  latestVer,
  haveCommit,
  commitDate,
  packageVersion,
}) {
  if (haveCommit) {
    const tagRes = await fetch(_GH_API + "/commits/" + tag);
    if (!tagRes.ok) return null;
    const tagCommit = await tagRes.json();
    const tagDate = tagCommit.commit?.committer?.date;
    if (!tagDate) return null;
    return new Date(tagDate) > new Date(commitDate);
  }
  return _compareVersions(latestVer, packageVersion) > 0;
}
