/**
 * @file util/test/migrate-app-state.test.js
 * @description Tests for `util/update/migrate-app-state.js`, the Step Six
 *   helper that carries operator state into a freshly extracted release.
 *
 *   Two properties matter more than the rest and are asserted directly:
 *   the copy never overwrites what the release ships, and the old
 *   install is never modified. Everything runs against `os.tmpdir()`
 *   directories, so no production file is in reach (see
 *   docs/claude/CLAUDE-BEST-PRACTICES.md § Test Isolation).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MIGRATED_ITEMS,
  parseArgs,
  isLpRangerInstall,
  findSourceCandidates,
  resolveSource,
  buildPlan,
  applyPlan,
  formatPlan,
  planTotal,
  validateDirs,
  main,
} = require("../update/migrate-app-state");

/** A throwaway parent directory. */
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
}

/** Write a file, creating parents. */
function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** An old install carrying operator state. */
function makeOld(root, name) {
  const d = path.join(root, name);
  put(path.join(d, "package.json"), '{"name":"lp-ranger"}');
  put(path.join(d, ".env"), "SECRET=1");
  put(path.join(d, "app-config/user-configurable/wallet.json"), "wallet");
  put(path.join(d, "app-data/rebalance_log.json"), "log");
  put(path.join(d, "tmp/pnl-epochs-cache.json"), "epochs");
  put(path.join(d, "node_modules/pkg/big.bin"), "x".repeat(64));
  return d;
}

/** A freshly extracted release: shipped code and shipped defaults only. */
function makeNew(root, name) {
  const d = path.join(root, name);
  put(path.join(d, "package.json"), '{"name":"lp-ranger"}');
  put(path.join(d, "src/bot.js"), "NEW CODE");
  put(
    path.join(d, "app-config/app-defaults-for-user-configurable/chains.json"),
    "SHIPPED",
  );
  put(path.join(d, "app-config/user-configurable/README.md"), "SHIPPED README");
  return d;
}

describe("MIGRATED_ITEMS — what an update carries", () => {
  it("never includes node_modules", () => {
    /*- The whole reason this script replaced a plain `cp -rn`: the old
     *  command copied hundreds of megabytes that the next step threw
     *  away and reinstalled from the new lockfile. */
    assert.ok(!MIGRATED_ITEMS.includes("node_modules"));
  });

  it("covers exactly the operator-state paths the README documents", () => {
    assert.deepEqual(MIGRATED_ITEMS, [".env", "app-config", "app-data", "tmp"]);
  });
});

describe("parseArgs", () => {
  it("reads the flags", () => {
    const a = parseArgs(["--dry-run", "--from", "../old"]);
    assert.equal(a.dryRun, true);
    assert.equal(a.from, "../old");
    assert.equal(a.bad, "");
  });

  it("rejects --from with no value", () => {
    assert.match(parseArgs(["--from"]).bad, /needs a directory/);
    assert.match(parseArgs(["--from", "--dry-run"]).bad, /needs a directory/);
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    assert.match(parseArgs(["--frm", "../old"]).bad, /Unrecognized/);
  });

  it("recognises --help", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
  });
});

describe("isLpRangerInstall / findSourceCandidates", () => {
  it("accepts a real install and rejects anything else", () => {
    const root = tmpRoot();
    const good = makeNew(root, "lp-ranger-1.0.0");
    put(path.join(root, "other/package.json"), '{"name":"something-else"}');
    assert.equal(isLpRangerInstall(good), true);
    assert.equal(isLpRangerInstall(path.join(root, "other")), false);
    assert.equal(isLpRangerInstall(path.join(root, "nope")), false);
  });

  it("finds siblings, excluding itself and non-installs", () => {
    const root = tmpRoot();
    const self = makeNew(root, "lp-ranger-0.9.2");
    makeOld(root, "lp-ranger-0.9.1");
    fs.mkdirSync(path.join(root, "lp-ranger-notes"), { recursive: true });
    put(path.join(root, "unrelated/package.json"), '{"name":"lp-ranger"}');
    const found = findSourceCandidates(self);
    assert.deepEqual(
      found.map((p) => path.basename(p)),
      ["lp-ranger-0.9.1"],
    );
  });
});

describe("resolveSource — which install to copy from", () => {
  it("takes --from as given", () => {
    assert.deepEqual(resolveSource({ from: "../old", candidates: [] }), {
      dir: "../old",
    });
  });

  it("uses the single candidate when there is exactly one", () => {
    const r = resolveSource({ from: "", candidates: ["/x/lp-ranger-0.9.1"] });
    assert.equal(r.dir, "/x/lp-ranger-0.9.1");
  });

  it("refuses to guess between several", () => {
    /*- Copying the wrong install's wallet and bot config into a new
     *  release is not something an operator would notice quickly. */
    const r = resolveSource({
      from: "",
      candidates: ["/x/lp-ranger-0.9.0", "/x/lp-ranger-0.9.1"],
    });
    assert.ok(r.error);
    assert.match(r.error, /lp-ranger-0\.9\.0/);
    assert.match(r.error, /lp-ranger-0\.9\.1/);
    assert.equal(r.dir, undefined);
  });

  it("explains itself when there is nothing to copy from", () => {
    const r = resolveSource({ from: "", candidates: [] });
    assert.match(r.error, /--from/);
  });
});

describe("validateDirs", () => {
  it("rejects a destination that is not an install", () => {
    const root = tmpRoot();
    const src = makeOld(root, "lp-ranger-0.9.1");
    assert.match(validateDirs(root, src), /does not look like/);
  });

  it("rejects copying a directory onto itself", () => {
    const root = tmpRoot();
    const d = makeNew(root, "lp-ranger-0.9.2");
    assert.match(validateDirs(d, d), /same directory/);
  });

  it("passes a genuine pair", () => {
    const root = tmpRoot();
    const dest = makeNew(root, "lp-ranger-0.9.2");
    const src = makeOld(root, "lp-ranger-0.9.1");
    assert.equal(validateDirs(dest, src), "");
  });
});

describe("buildPlan / applyPlan", () => {
  it("plans every operator file and no node_modules", () => {
    const root = tmpRoot();
    const src = makeOld(root, "lp-ranger-0.9.1");
    const dest = makeNew(root, "lp-ranger-0.9.2");
    const plan = buildPlan(src, dest, MIGRATED_ITEMS);
    const all = plan.flatMap((e) => e.copy);
    assert.ok(all.includes(".env"));
    assert.ok(all.some((f) => f.endsWith("wallet.json")));
    assert.ok(all.some((f) => f.endsWith("rebalance_log.json")));
    assert.ok(all.some((f) => f.endsWith("pnl-epochs-cache.json")));
    assert.ok(!all.some((f) => f.includes("node_modules")));
    assert.equal(planTotal(plan), 4);
  });

  it("marks a file already in the new install as kept, not copied", () => {
    const root = tmpRoot();
    const src = makeOld(root, "lp-ranger-0.9.1");
    const dest = makeNew(root, "lp-ranger-0.9.2");
    /*- The release ships this file; the old install has one too. */
    put(path.join(src, "app-config/user-configurable/README.md"), "OLD README");
    const plan = buildPlan(src, dest, MIGRATED_ITEMS);
    const appConfig = plan.find((e) => e.item === "app-config");
    assert.ok(appConfig.skipped.some((f) => f.endsWith("README.md")));
    assert.ok(!appConfig.copy.some((f) => f.endsWith("README.md")));
    assert.match(formatPlan(plan).join("\n"), /kept as shipped/);
  });

  it("flags an item the old install never had", () => {
    const root = tmpRoot();
    const src = makeOld(root, "lp-ranger-0.9.1");
    fs.rmSync(path.join(src, ".env"));
    const dest = makeNew(root, "lp-ranger-0.9.2");
    const plan = buildPlan(src, dest, MIGRATED_ITEMS);
    assert.equal(plan.find((e) => e.item === ".env").missing, true);
    assert.match(formatPlan(plan).join("\n"), /not in the old install/);
  });

  it("copies the operator files and leaves shipped content alone", () => {
    const root = tmpRoot();
    const src = makeOld(root, "lp-ranger-0.9.1");
    const dest = makeNew(root, "lp-ranger-0.9.2");
    put(path.join(src, "app-config/user-configurable/README.md"), "OLD README");
    put(path.join(src, "src/bot.js"), "OLD CODE");
    const written = applyPlan(src, dest, buildPlan(src, dest, MIGRATED_ITEMS));
    assert.equal(written, 4);
    assert.equal(fs.readFileSync(path.join(dest, ".env"), "utf8"), "SECRET=1");
    /*- Shipped file with the same path must survive untouched. */
    assert.equal(
      fs.readFileSync(
        path.join(dest, "app-config/user-configurable/README.md"),
        "utf8",
      ),
      "SHIPPED README",
    );
    /*- src/ is not an operator path, so old code cannot leak in. */
    assert.equal(
      fs.readFileSync(path.join(dest, "src/bot.js"), "utf8"),
      "NEW CODE",
    );
    assert.equal(fs.existsSync(path.join(dest, "node_modules")), false);
  });

  it("never modifies the old install", () => {
    const root = tmpRoot();
    const src = makeOld(root, "lp-ranger-0.9.1");
    const dest = makeNew(root, "lp-ranger-0.9.2");
    applyPlan(src, dest, buildPlan(src, dest, MIGRATED_ITEMS));
    assert.equal(fs.readFileSync(path.join(src, ".env"), "utf8"), "SECRET=1");
    assert.equal(
      fs.existsSync(path.join(src, "node_modules/pkg/big.bin")),
      true,
    );
  });
});

describe("main — the CLI", () => {
  /** Run main() with cwd pointed at a directory, always restoring it. */
  function inDir(dir, argv) {
    const prev = process.cwd();
    try {
      process.chdir(dir);
      return main(argv);
    } finally {
      process.chdir(prev);
    }
  }

  it("auto-detects the sibling install and copies", () => {
    const root = tmpRoot();
    makeOld(root, "lp-ranger-0.9.1");
    const dest = makeNew(root, "lp-ranger-0.9.2");
    assert.equal(inDir(dest, []), 0);
    assert.equal(fs.existsSync(path.join(dest, ".env")), true);
  });

  it("writes nothing on --dry-run", () => {
    const root = tmpRoot();
    makeOld(root, "lp-ranger-0.9.1");
    const dest = makeNew(root, "lp-ranger-0.9.2");
    assert.equal(inDir(dest, ["--dry-run"]), 0);
    assert.equal(fs.existsSync(path.join(dest, ".env")), false);
  });

  it("exits non-zero when run outside an install", () => {
    const root = tmpRoot();
    makeOld(root, "lp-ranger-0.9.1");
    assert.equal(
      inDir(root, ["--from", path.join(root, "lp-ranger-0.9.1")]),
      1,
    );
  });

  it("exits non-zero on a bad argument", () => {
    const root = tmpRoot();
    const dest = makeNew(root, "lp-ranger-0.9.2");
    assert.equal(inDir(dest, ["--nope"]), 1);
  });

  it("prints help and exits zero", () => {
    const root = tmpRoot();
    const dest = makeNew(root, "lp-ranger-0.9.2");
    assert.equal(inDir(dest, ["--help"]), 0);
  });
});
