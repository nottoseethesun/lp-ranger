---
name: feedback_never_clear_to_force_a_recompute
description: Never delete a saved figure to make code rebuild it; add an explicit request and overwrite when the new value exists
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-17T19:29:20.448Z
---

To make a guarded computation run again, ask for it. Never clear the
saved value so the guard stops seeing it.

**Why:** the clear is visible to everything else. Between the clear and
the rebuild the figure is missing, so another writer can fill it with a
partial value and the guard then preserves that. A rebuild that never
lands leaves nothing at all. Both happened in Re-scan Prices
(2026-08-05 to 2026-09-17): it deleted the compound totals to defeat the
lifetime scan's "already saved" guard, a rebalance's fee credit could
land in the gap, and the partial figure stuck until a Reload.

The user's framing, 2026-09-17: "The only purpose of re-scan prices is
to update the historical price entries — not to change anything other
than the value in the established calculations." He also said not to
veer into complexity: "That's where AI-powered development falls down
and it's almost better to just do things by hand."

**How to apply:**

- Add a request flag on the state (`_needsPriceRevalue` alongside
  `_needsFullRescan`), read it where the guard is, and clear it only
  when the work finishes — so an interrupted run retries.
- Overwrite each figure only once its replacement exists, and keep the
  old one when the source returns nothing.
- Check what the fresh value is read through: a cache with no expiry
  hands back the same bad number (`fetchHistoricalPriceGecko` needed a
  `refresh` option; current prices needed `withFreshPricesAllowed`).
- Related: [[feedback_no_junk_repair_code]],
  [[feedback_audit_program_state]], [[feedback_kiss]].
