---
name: no-computation-in-params
description: Never put a computation — especially an await or a fetch — inside an argument expression; compute it on its own line first
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-13T05:44:50.095Z
---

Never write a computation inside a parameter. No `await`, no function
call that does work, no lookup — compute it on its own line first and
pass the variable.

```js
// NO — _scanFloor runs even when scanFloorFor discards its answer
fromBlock: scanFloorFor(mintBlocks, tokenId, await _scanFloor(poolAddress));

// YES — the lookup happens only when it is actually needed
let fromBlock = scanFloorFor(mintBlocks, tokenId, null);
if (fromBlock === null) fromBlock = await _scanFloor(poolAddress);
```

**Why:** arguments are evaluated eagerly, before the call. A "fallback"
parameter is therefore not a fallback at all — it always runs, even when
the callee ignores it. That silently pays for work nobody asked for, and
it hides the cost inside a line that reads like a default value. It also
makes the expensive step invisible to anyone scanning the function for
I/O.

**How to apply:** if an argument expression contains `await` or calls
anything that touches the network, disk, or cache, hoist it to its own
statement. When it is genuinely a fallback, make the laziness explicit
with a `null` sentinel and a branch — see `_detectCurrentNftValues` in
`src/position-details-compound.js` and `_backfill` in
`src/bot-pnl-current-nft.js`, which both use that shape. Related:
[[feedback_no_duplication]].
