---
name: Never start blockchain scans from genesis without discussion
description: Any new on-chain getLogs/queryFilter scan must have a tight lower bound; do not write fromBlock 0 / unbounded scans without explicit user discussion first
type: feedback
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T04:54:43.110Z
---
Never write a blockchain scan that uses `fromBlock: 0`, `fromBlock: undefined`,
or any other unbounded lower bound unless it is absolutely necessary AND you
have discussed it with the user first.

**Why:** Scans from genesis replay every block on the chain (hundreds of
millions on PulseChain), causing many minutes of cold-start RPC traffic on
the production Pi 5 host and burning the user's RPC budget on empty pre-pool
blocks. Multiple such scans accumulated unnoticed across `hodl-baseline`,
`bot-recorder._scanLifetimePoolData`, `position-history._supplementMintFromChain`,
and `position-details` lifetime IL — fixed in the
"add-compound-to-activity-log-and-start-all-historical-scans-from-pool-creation"
branch by routing every site through `src/lib/pool-creation-block.js`.

**How to apply:**
- For NFT or pool-event scans, use the cached pool-creation-block helper at
  `src/lib/pool-creation-block.js` (`getPoolCreationBlockCached`,
  `resolvePoolCreationBlockForPosition`, `resolvePoolAddressForToken`).
- For incremental scans, persist a `lastScannedBlock` checkpoint and resume.
- Only fall back to `0` as a last-resort default when the tight bound cannot
  be determined — and even then, the helper already returns 0 on failure,
  so callers do not need to author that fallback themselves.
- Before introducing any new scan path, identify the natural lower bound
  (pool creation, NFT mint, last checkpoint, recent-N-block window).
  If you genuinely cannot find one, stop and ask before scanning.
- This rule applies to `getLogs`, `queryFilter`, `provider.getLogs`,
  `contract.queryFilter`, and any wrapper that takes a `fromBlock` arg.
