---
name: config-inputs-populate-once
description: "Bot Config inputs (inMinInterval, inMaxReb, OOR fields, …) populate from server ONCE per position (`_configSynced` latch); unsaved typing persists indefinitely BY DESIGN — user explicitly rejected poll-reset-on-blur (2026-07-23)."
metadata: 
  node_type: memory
  type: project
  originSessionId: d932d59e-01b4-45db-82b1-6d987abcda8f
  modified: 2026-10-24T05:23:48.503Z
---

Bot Config form inputs (Min Time Between Rebalances, Max Rebalances /
Day, OOR threshold/timeout, etc.) are populated from server data
**once per position activation** via the `_configSynced` latch in
`_syncConfigFromServer` (`src/client/web/dashboard-data.js`).  After that,
the poll never writes them again — an unsaved typed value sits in the
field until Save, position switch, or page reload.  Focus is never
consulted.

**Why:** The poll originally re-populated every cycle and clobbered
mid-editing values (fixed in commit d91487e, "Fix config input
snap-back on next poll cycle").  On 2026-07-23 the user examined the
alternative — per-poll re-sync that skips the focused element, so
unsaved edits revert after blur — and **explicitly rejected it**:
"Keep the current behavior; the silent-revert risk isn't worth it."
(Silent-revert: type a value, tab away briefly, typing gone.  Plus a
small blur→Save race where a poll landing between blur and the Save
click could revert the value under the click.)

Note: two sync models coexist deliberately — Price Range Extension
(`dashboard-data-range-width.js`) and per-token slippage sync every
poll with guards; the rest of Bot Config uses the once-latch.

Also considered and rejected (same session): per-input "Clear" /
"Reset" buttons to discard unsaved typing — "not worth it. User can
refresh page if that concerned."

**How to apply:** Do NOT "fix" persisting unsaved input values as a
bug, do NOT unify the two sync models unasked, and do NOT propose
Clear/Reset buttons for these inputs.  If a future change touches
this area, surface this decision first.
