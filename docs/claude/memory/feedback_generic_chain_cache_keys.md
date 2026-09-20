---
name: feedback-generic-chain-cache-keys
description: Caches of blockchain-derived data are keyed as generically as possible (e.g. by pool) so every position can use them — never tied to one position
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-17T04:32:09.126Z
---

Key any cache of blockchain-derived data as generically as possible, so
that all positions can access it. For pool-scoped results, that means the
pool identity the codebase already uses (see
[[project_event_cache_scoping_rationale]]), not one position's composite
key or its `bot-config.json` slot.

**Why:** stated by the user on 2026-09-16: "caches from the blockchain
must be keyed as generically as possible, so that all positions can
access them. E.g., by pool." It came up because an unmanaged position's
lifetime request computes Fees Compounded and the deposit total, but
those are saved only in a position's config slot, which an unmanaged
position lacks. So when that position is managed later, its first scan
reads the whole chain again.

**How to apply:** when designing or reviewing a cache of chain data, ask
who else reads the same facts (another position in the pool, the
unmanaged view, a later managed run) and key the cache so all of them
can read it. This governs the planned per-NFT walk cache (Fix 2 in
`docs/roadmap/nice-to-haves/project_cache_per_nft_walk.md`).
