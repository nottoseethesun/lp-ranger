---
name: regenerate-lockfile-periodically-and-before-assuming-overrides-are-needed
description: "The lockfile exists so the team shares an identical tree, but it must be deleted and regenerated periodically to pick up updates"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 53c63b8a-d973-4be1-8005-50ac113c57eb
  modified: 2026-09-20T00:13:43.092Z
---

The lockfile (`package-lock.json`) exists so every developer (and CI) installs the exact same dependency tree. But it must be **deleted and regenerated periodically** — otherwise transitive deps stay pinned at old versions indefinitely, even when the parent's caret range already accepts a newer patched release. Stale lockfiles are how unnecessary overrides and unpatched advisories accumulate.

Never add an npm override as the first response to a transitive-dep issue. Instead: delete **both `node_modules` and `package-lock.json`**, run `npm install`, and check whether the newer version resolves naturally. Only add an override if the parent's declared range genuinely excludes the fix (exact pin, range ceiling).

Do NOT do incremental `npm install` / `npm update <pkg>` and then investigate the resulting tree — that produced spurious dedup churn and even a stale `invalid` resolution (`@noble/hashes` under `@exodus/bytes`) that a clean full regen fixed automatically. Just blow the tree away and let Node rebuild it; don't overthink the dep graph.

**Why:** Two overrides (flatted, protobufjs) turned out to be unnecessary — lockfile regeneration resolved both because the parent ranges already accepted the patched versions. The overrides added false complexity to package.json.

**How to apply:** When an `npm audit` finding or a stale transitive dep appears: (1) check the parent's declared range via `npm view <parent> dependencies.<dep>`, (2) if the fix satisfies the range, delete `package-lock.json` and `npm install`, (3) only override if the range genuinely excludes the fix.

## Order matters, and `--dry-run` lies (2026-08-08)

This rule already said "delete **both**". I did not follow it, and CI went
red on PR #189 — every job that starts with `npm ci` died in ~10 seconds:

```text
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json are in sync.
npm error Missing: @noble/hashes@1.8.0 from lock file   (x3)
```

Adding one devDependency (`yaml`) had updated package.json but left the
lock tree incomplete — it carried that transitive only under `pdfkit`,
while the resolved tree also needed it under `jsdom` and
`html-encoding-sniffer`.

Two things this incident adds:

- **Delete the lockfile FIRST, then `node_modules`, then install.**
  Deleting the lockfile alone did nothing: `npm install` reported "up to
  date" and rebuilt the identical broken tree, because the surviving
  `node_modules` steered resolution straight back to it. The user, after
  watching me try it the slow way: "First before anything, delete the
  package-lock and then delete node_modules and only then, continue."
- **`npm ci --dry-run` PASSES against a broken lockfile.** It passed for
  me while real CI failed. Only `rm -rf node_modules && npm ci` reproduces
  what CI does. Never take a dry run as proof.

**Failure signature to recognize:** several CI jobs failing in ~10s each
(install-time, not test-time) with "Missing: <pkg> from lock file". Go
straight to the two-step deletion; do not investigate the dep graph.

## The procedure IS the response — run it first (2026-09-02)

A `fast-uri` high advisory appeared. I already knew the fix. Instead of
running the procedure I spent the turn on: an isolated temp dir, a
`--package-lock-only` resolve, a full old-vs-new lockfile diff, a
dependency-edge trace of `@noble/hashes`, and a survey of all five
existing overrides. Every bit of it was wasted, and one part was worse
than wasted.

**Do this, in this order, and nothing else:**

1. Confirm the server/bot is stopped (the one legitimate pause — see
   below).
2. `rm package-lock.json`
3. `rm -rf node_modules`
4. `npm i`
5. Verify: `npm audit --audit-level=high`, then `npm run build` and
   `npm run check`.

Then report. Do not diff the lockfile, trace dependency edges, audit the
overrides block, or predict what will change. The regeneration decides
that, and it is right almost every time. Investigate **only if step 4 or
5 actually fails.**

**`npm install --package-lock-only` is not a rehearsal — it lies.** It
resolved a tree that dropped three nested `@noble/hashes@1.8.0` copies
that `@exodus/bytes` requires. `npm ci` against that lock still exited 0,
so it looked validated. On the strength of it I told the user an
`invalid` resolution was "pre-existing and not a regression" — the
opposite of the truth. The real `npm i` restored all three and `npm ls`
went from `ELSPROBLEMS` to exit 0. Same family as
[[feedback_prove_the_revert_applied]]: a green result from the wrong
instrument is not evidence.

**The one legitimate reason to pause:** a running bot. `rm -rf
node_modules` under a live server managing real positions risks a failed
`require` mid-rebalance. Ask who stops it, then proceed — that question
is worth asking; the dependency archaeology is not.

**On overrides:** do not review them as part of an advisory fix. If the
regeneration clears the advisory, the overrides are not the subject.

## `markdownlint-cli2` is a repeat exact-pinner (2026-09-10)

Twice now an advisory has traced to `markdownlint-cli2` exact-pinning a
transitive dep, so regeneration cannot clear it:

- `js-yaml` — the existing scoped override.
- `smol-toml` — GHSA-7w5x-hrqm-74c2, high, 2026-09-10.  `0.23.2`, the
  latest published version, declares `"smol-toml": "1.7.0"`.  No caret,
  no range.  npm's suggested fix was a major DOWNGRADE to `0.21.0`.

**Still run the regeneration first** — it is cheap and it is right most
of the time; this parent is the exception, not the rule.  But when the
advisory survives it and the culprit is `markdownlint-cli2`, go straight
to a scoped override beside the one already there.  Do not re-derive the
decision, and do not accept the downgrade.

Confirm the pin with `npm view markdownlint-cli2@<ver> dependencies.<dep>`
before overriding — one command, and it is what distinguishes "exact pin"
from "stale lockfile".

**Then actually run the tool.** An override forces a version the parent
never tested against, so `npm audit` going quiet is not sufficient
evidence.  Run `./node_modules/.bin/markdownlint-cli2 <some files>` and
see it exit 0.  (Never `npx` — see [[feedback_no_npx]].)

## Never go back from a deleted lockfile (2026-09-19)

`npm run check` failed on 16 advisories. I ran the procedure, the
regenerated tree came back with **21** including a new high
(`undici@7.24.4`, where the committed lockfile had `7.29.1`), and I
restored the committed lockfile with `git checkout --`.

**That restore was wrong.** The user, on being told:

> "on the lockfile, no, delete it and regenerate, and attempt to fix
> piecemeal if that does not work — but don't ever go back from a deleted
> lockfile."

So the regenerated tree is the tree. A worse advisory count is not a
reason to go back; it is the starting point for the next step.

**The procedure, corrected:**

1. Confirm the server/bot is stopped.
2. `rm package-lock.json`
3. `rm -rf node_modules`
4. `npm i`
5. `npm audit`. Whatever it says, **keep the regenerated lockfile.**
6. Anything left, fix piecemeal — a scoped override for the specific
   parent that pins a bad transitive, as the `markdownlint-cli2` section
   above describes. Confirm the pin with
   `npm view <parent>@<ver> dependencies.<dep>` before overriding, and
   run the tool afterwards to prove the forced version works.

Never `git checkout -- package-lock.json` to undo a regeneration. Going
back restores the stale pins the regeneration existed to clear, and
leaves the next person to rediscover the same thing.

## `npm run check` cannot catch a lockfile desync (2026-09-19)

After ANY change that touches `package-lock.json` — a regeneration, an
added override, a dependency added or removed — verify with the two
commands CI actually runs:

```sh
rm -rf node_modules && npm ci   # must exit 0
npm ls                          # must exit 0, not ELSPROBLEMS
```

**`npm run check` passing proves nothing about this.** It reuses the
`node_modules` already on disk and never re-resolves from the lockfile,
so a package.json/lockfile mismatch is structurally invisible to it. A
full green local check and a CI install failure are perfectly consistent
states.

**What it cost:** I added the `@scalar/json-magic` override and then ran
`npm i` against the existing tree — an incremental resolve, which the top
of this file already warns against. The lockfile came out missing three
nested `@noble/hashes@1.8.0` entries. `npm run check` exited 0. Four CI
jobs then died in about ten seconds each on `npm ci` with
`Missing: @noble/hashes@1.8.0 from lock file`, the same package and the
same signature recorded in the 2026-08-08 section above.

The fix was not a repair of that lockfile: delete it and `node_modules`,
`npm i` with the override already in `package.json`, and verify as above.
An override belongs in `package.json` BEFORE the regeneration, never
bolted on after one.
