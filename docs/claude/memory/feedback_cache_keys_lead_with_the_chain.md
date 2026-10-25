---
name: feedback_cache_keys_lead_with_the_chain
description: "Every cache of chain data is keyed with the canonical chain-first key (cacheKey in src/lib/cache-store.js), browser caches included; the chain cannot change while a server runs"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-24T04:54:55.222Z
---

Every cache of chain or price-service data keys its entries with the
canonical format: the chain's key in chains.json first, then what
identifies the entry, dash-joined and lower-cased. That is
`cacheKey(chain, ...parts)` in `src/lib/cache-store.js`, or the canonical
pool key in `src/lib/pool-key.js` for a pool's identity. This applies to
memory and disk caches on the server and to the browser's localStorage
copies of scan results (those end with the chain:
`9mm_position_store_<chain>`).

**Why:** the user, 2026-10-17: "All caches of course need to be keyed
with our canonical key format - fix that." A token or pool can sit at
the same address on two chains, and PulseChain's copy of Ethereum's
state means many do. The user also said the chain cannot change while a
server runs ("we don't allow the blockchain to be changed ... maybe
someday"), but it can change between runs. Disk and browser caches
outlive the run, so an address-only key hands one chain's answer to the
other.

**How to apply:** a new cache leads its key with the chain from the
start. Do not raise chain-change handling inside a running server (a
dashboard reload on a chain switch, say) as an issue, because that
cannot happen today. Re-keying a cache that is costly to rebuild needs
the cost stated first, and no migration code
([[feedback_no_junk_repair_code]]): the event cache's in-file key and
the epoch cache are already chain-scoped and were left alone on
2026-10-17 for that reason. Related: [[feedback_generic_chain_cache_keys]].
