---
name: feedback_logging
description: "Log content rules: token symbols, NFT id + emoji, full context on compound/rebalance/swap, add logs to new features"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T17:39:22.520Z
---

# Logging

Merged from: feedback_log_token_symbols, feedback_log_nft_id_emoji, feedback_log_full_context, feedback_add_good_logs — those slugs no longer exist as
separate files; search this one.

## log token symbols

When logging anything about a token, always include the human-readable symbol next to the address. An address alone (`0xA107…9a27`) is unreadable; a symbol (`WPLS`) is instantly recognizable.

**Why:** User explicitly said "include the human-readable token name, as you always should do." This is a project-wide rule, not a one-off. Logs are the primary debugging surface and a bare 0x… makes them useless at a glance.

**How to apply:** Wherever a log mentions a token address, render it with `formatToken(addr)` from `src/price-source-cascade.js`: `WPLS (0xA107…9a27)`, or the abbreviated address alone if the symbol cache hasn't loaded the token yet. Compute it on its own line before the log call ([[feedback_no_computation_in_params]]). For the bare symbol, `getTokenSymbol(addr)` lives in `src/token-symbol-cache.js` and answers null when unknown; never print a stand-in such as `?` for it.

## log nft id emoji

Every log line that mentions an NFT position must include both:

1. The numeric `tokenId` (e.g. `161234`)
2. The 3-emoji fingerprint from `emojiId(tokenId)` (defined in `src/logger.js`; the dashboard has its own, same algorithm, in `public/dashboard-helpers.js`) &mdash; an MD5-derived 3-emoji sequence wrapped in an ANSI black-background reset

**Why:** Two-fold identification: the number is for grep / search / cross-referencing with on-chain explorers, the emoji fingerprint is for instant visual recognition when scanning a long log without reading every digit. The user works with many concurrent positions; the emoji fingerprint disambiguates at a glance. Existing reference impls: `src/position-manager.js:242`, `src/position-manager.js:294`, `src/server-routes.js`.

**How to apply:**

- In Node code: `const { emojiId } = require("./logger");` then `console.log("[bot] %s/%s NFT #%s %s: <msg>", t0Sym, t1Sym, tokenId, emojiId(tokenId), ...)`.
- In dashboard code: `import { emojiId } from "./dashboard-helpers.js"` then use the same pattern.
- Compose with [[feedback-log-token-symbols]]: when a log line names *both* a position AND its tokens, both rules apply &mdash; include token symbols AND NFT number AND NFT emoji.
- Don't include emoji-only or tokenId-only; always both together when an NFT is the log's subject.
- Empty tokenId is fine (`emojiId("")` is harmless), but skip the formatting if there's no position context at all.

## log full context

The three high-impact operation classes — **compound**, **rebalance**, **swap** — must log with full identifying context so a single line is self-describing (no need to scroll up for context, no ambiguity if multiple positions run concurrently).

Required fields in every such log line:

1. **Blockchain** name (e.g. `pulsechain`)
2. **Wallet** address (abbreviated form OK, e.g. `0xWALL…ET1`)
3. **NFT factory** address (the NonfungiblePositionManager, abbreviated OK, e.g. `0xCC05…7f2`)
4. **NFT tokenId** number (e.g. `#100001`)
5. **NFT emoji** fingerprint — per [[feedback-log-nft-id-emoji]]
6. **Both token symbols** as `<token0Sym>/<token1Sym>` — per [[feedback-log-token-symbols]]

**Canonical format**: `[<event>] <chain> <wallet> <factory> #<tokenId> <emoji> <t0sym>/<t1sym>: <event-detail>`. Example: `[compound] pulsechain 0xWALL…ET1 0xCC05…7f2 #100001 ⭐🌵🐎 PLSX/WPLS: 3 IncreaseLiquidity (2 standalone), 2 Collect, 0 drain`.

**Why:** Multi-position concurrent operation, multi-chain support on the roadmap, and burn-in debugging all benefit from logs that don't require context-stitching across lines. A `?` for any of those fields is a bug — it means an opts object somewhere along the call chain lost the field (usually because two slot names mean the same thing, e.g. `wallet:` vs `walletAddress:`).

**How to apply:**

- Audit `_logCompoundSummary` (`src/compounder.js`), the rebalance entrypoint loggers (`src/rebalancer.js`), and the swap entrypoint loggers (`src/rebalancer-swap.js` / `rebalancer-aggregator.js`) when adding new log lines or modifying existing ones.
- Compose the line with all 6 fields whenever the event class is one of compound / rebalance / swap.
- If a caller is missing a field, **fix the caller** (don't silently render `?`). Cross-reference with the rule that opts objects should not use inconsistent field names (`wallet` vs `walletAddress`).
- This rule does NOT apply to high-frequency cycle logs (poll, skip, threshold-check, etc.) — those are best kept compact. The rule is for the three named operation classes.

## add good logs

Always add meaningful logs to new features. User said "add good logs dude" when the fresh deposit detection had no visibility into what was happening.
**Why:** Without logs, debugging requires guesswork. The user monitors the server console to verify correctness.
**How to apply:** Log key decision points: what was found, what was filtered, what was counted, final totals. Include identifying info (TX hashes, block numbers, amounts, USD values). Use `[prefix]` tags consistently (e.g., `[hodl]`, `[deposit]`).
