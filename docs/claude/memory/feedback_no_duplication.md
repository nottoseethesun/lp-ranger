---
name: feedback_no_duplication
description: Never duplicate code or RPC calls — reuse the existing implementation; fetch once and pass the value down. Client/server is not an excuse: extract the pure part into a dependency-free module both tiers import
metadata:
  type: feedback
---

# No duplication

Merged from: feedback_no_duplicate_code, feedback_no_duplicate_rpc.

## no duplicate code

Never duplicate code, and proactively remove duplication when you encounter it. Reuse existing functions; extract shared helpers when needed.
**Why:** User called this out when Moralis key save logic was duplicated between Settings and wallet setup ("Re-use the code in the Settings menu... never duplicate code or add duplicate implementations"). Reinforced 2026-04-30 after deduplicating `buildPollDeps` out of `bot.test.js` into the shared `_bot-loop-helpers.js` ("Always remove duplication").
**How to apply:** (1) Before writing any new function, check if the logic already exists elsewhere — extract a shared helper and import it. (2) When you spot existing duplication while working in an area, remove it as part of the change, even if the immediate task didn't require it. Don't leave duplication in place once you've seen it.

## no duplicate rpc

Never duplicate RPC calls. When multiple features need the same on-chain data, fetch once and pass to all consumers.

**Why:** RPC calls are slow, rate-limited, and costly at scale. The user flagged this as a high priority design concern when planning the lifetime HODL baseline feature (which shares IncreaseLiquidity/Collect/DecreaseLiquidity events with compound detection).

**How to apply:** Always separate data-fetching (RPC layer) from classification/business logic. Design scan functions that return raw data, then pass that data to multiple classifiers. Check existing scan functions before adding new RPC calls — the data you need may already be fetched elsewhere.

## client and server can almost always share

A rule needed by both `src/` and `public/` looks unshareable — `src/`
is CommonJS and the dashboard bundle is ESM — but **the module format is
rarely the real blocker**. esbuild bundles CommonJS into the browser
build without complaint. What actually blocks the import is Node-only
dependencies further down the file: `fs`, `ethers`, `async-mutex`.

**So extract the pure part into its own dependency-free module and have
both tiers import it.** Established 2026-09-16 on the
one-position-per-pool gate: `positionMgr.poolKey` lives in
`src/position-manager.js`, which pulls in `async-mutex`, `ethers` and
`fs`, so the dashboard could not import it. The pair normalisation
inside it was pure, so it moved to `src/pool-key.js` with zero imports,
and `public/dashboard-manage-ui.js` now imports the very function the
server decides with.

**Why it matters:** the user offered the duplication as acceptable in
this case, and it was still worth removing — a duplicated rule means the
dashboard can decide a Manage click is fine while the server refuses it,
with every gate green on both sides.

**How to apply:** before accepting any client/server duplication, check
whether the decision is pure. If it is, extract it, keep the new module
import-free, and pin that constraint with a test that reads the file and
asserts it has no `require`/`import` — a Node-only import added later
breaks the dashboard build, not a test, so nothing else catches it. Only
if the logic genuinely cannot be made pure is a second copy acceptable,
and then write it ONCE per side and say which side is authoritative.
See [[project_esm_migration]] for why the CJS/ESM split persists.
