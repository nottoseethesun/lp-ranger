---
name: feedback-eip55-checksum-url-segments
description: "All EVM addresses MUST be EIP-55 checksummed before use. URL segments (or sub-segments) containing addresses arrive lowercase from browsers; pass them through a corrector (`ethers.getAddress`) before any downstream consumption."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-24T05:23:58.349Z
---

**All EVM addresses must conform to the EIP-55 checksum spec** (`ethers.getAddress(addr)`). URLs in browsers come in as lowercase — Chrome / Brave canonicalize the path before sending. Anywhere code reads an EVM address from a URL path / query / fragment, **convert to checksum form before any downstream use** (comparing, hashing, building composite keys, sending to server, etc.).

**Why:** Composite keys (e.g., `pulsechain-{wallet}-{contract}-{tokenId}`) are built from these addresses. If one source is checksummed (server-side, from ethers reads) and another is lowercase (URL), the key mismatches and lookups fail. This was the root cause of multiple bugs in the closed-position-reopen PR:

- Dashboard's `myKey` (built in `flattenV2Status`) didn't match server's per-position state keys
- `positions[myKey]` returned `undefined` → `d.rebalanceInProgress` undefined → Manage button stayed clickable during active rebalance (failing the in-progress gate)
- Error modal didn't fire because `d.rebalancePaused` was also undefined
- LP-Browser cross-pool data appeared to leak (actually was the wrong position's `posData` from the rebalance-follow fallback)
- All silent — no thrown error, just wrong data.

**How to apply:**

- Anywhere a URL segment is parsed for an address: `ethers.getAddress(rawSegment)` BEFORE storing or using
- `ethers.getAddress` throws on invalid input — catch and surface a clear error rather than passing garbage downstream
- `compositeKey()` should NOT normalize (it's a string-concat) — normalize at the source instead
- Server-side: already checksummed because addresses come from `ethers.Contract` reads. Don't trust client-supplied address bodies — checksum on receipt
- Tests: when constructing addresses in fixtures, use checksummed form to match production

**Code locations to audit/protect:**

- `src/client/web/dashboard-router.js` — parses URL into wallet/contract/tokenId
- `src/client/web/dashboard-positions.js` — posStore add path
- `src/client/web/dashboard-data-cache.js` `flattenV2Status` — builds composite key from posStore
- `src/client/web/dashboard-data-deposit.js` `_poolKey()` — builds localStorage keys; calls `.toLowerCase()` so it's consistent on its own, but make sure server data also normalizes
- Anywhere `fetch(/api/...)` includes an address in body or query

**CLAUDE.md already states the constraint** ("EVM addresses use EIP-55 checksummed capitalization"). This memory documents the URL-segment-specific application of that rule, since URLs are the most common contamination vector and the failure mode is silent.
