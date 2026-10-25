# Unused HTML ids — one-shot audit, 2026-07-23

Audit run under the fork agent on 2026-07-23. Cross-referenced every
`id="..."` in `src/client/web/*.html` against JS quoted-string references,
CSS `#id` selectors, HTML `for=` / `aria-*` linkages, and dynamic-ID
construction patterns in JS. **47 provably-unused IDs** in
`src/client/web/index.html`; `0` orphan `data-tpl` slots.

Cluster 1 (5 IDs: dblPanel + friends) was deleted the same day —
see the "remove-dead-doubling-panel-html" branch / merged PR.  The
remaining ~42 are catalogued here so a future session working in
one of these code paths can opportunistically clean up.

Full verifier script and unfiltered report live in the session
scratchpad (regenerable — the fork prompt is on file).

---

## Cluster 2 — Inline-edit dialogs (~25 IDs, biggest cluster)

**Where:** Current-Position and Lifetime panel edit rows.

**IDs:** `curDepositRow`, `curDepositNote`, `curDepositPriceInfo`,
`curDepositSaveBtn`, `curDepositCancelBtn`, `curDepositResetBtn`
(lines 840–849); parallel `curRealizedRow` / `Note` / `SaveBtn` /
`CancelBtn` / `ResetBtn` (852–860); `initialDepositNote` /
`SaveBtn` / `CancelBtn` / `ResetBtn` (937–943); `realizedGainsNote`
/ `SaveBtn` / `CancelBtn` / `ResetBtn` (959–965); `lifetimeDaysNote`
/ `SaveBtn` / `CancelBtn` / `ResetBtn` (948–954); `ltDepositPriceInfo`
(935).

**Suspected reason:** Save/Cancel/Reset were refactored to
class-based event delegation (grep for `data-role=` or
`addEventListener('click', ...)` with class matching) and the
individual IDs are now vestigial.

**Before touching:** grep for `data-role`, `data-action`, or a
delegated `document.body.addEventListener('click', ...)` that reads
`e.target.closest(...)`.  Confirm the delegation covers all six
buttons across the four dialogs before deleting the IDs.

**Trigger conditions to clean up:** any code change in
`src/client/web/dashboard-data-deposit.js`, `src/client/web/dashboard-events-manage.js`,
or the inline-edit dialog markup in `src/client/web/index.html`.

---

## Cluster 3 — Wallet-import validation shell (10 IDs)

**Where:** Wallet-import (seed / key / generate tab) markup.

**IDs:** `seedValidStatus`, `seedValidTitle`, `seedValidDetail`
(105–109), `seedConfirmPanel` (115), `seedPwMatch` (145);
parallel `keyValidStatus`, `keyValidTitle`, `keyValidDetail`
(163–167), `keyConfirmPanel` (173), `keyPwMatch` (203); `genPwMatch`
(86).

**Suspected reason:** the validation status pane the earlier
wallet-import UI was written around; nothing reads or writes them
today.  Probably safe to remove without further investigation.

**Trigger conditions to clean up:** any code change in
`src/client/web/dashboard-wallet.js`, `src/client/web/dashboard-wallet-import.js`,
or the wallet-import dialog markup in `src/client/web/index.html`.

---

## Individual finds (7 IDs)

Investigate on contact — no cluster narrative, each may be a real
layout anchor or a small drift like Cluster 1.

- `activeTriggerDisplay` (1045) — "OUT OF RANGE" badge shell,
  nothing writes it.  Look at whether the trigger-type display was
  moved elsewhere.
- `posBrowserBtn` (598) — Position Browser header button.  Grep for
  a click handler bound via a different mechanism; if none, delete.
- `pnlBreakdown` (824), `kpiNetBreakdown` (919) — P&L breakdown
  containers, referenced only in a JSDoc comment.  Suspicious given
  the recent `dashboard-data-kpi-breakdown` work — may be an alias
  or successor ID conflict.
- `compoundHelp` (893), `kpiCDSub` (907) — Mission Control help /
  subtext divs.  Check whether Mission Control help text has moved
  to a tooltip or param-help modal.
- `syncRow` (968) — bottom Sync-status row wrapper.  Verify the
  Sync badge painter targets the badge id, not the row wrapper.
- `privacySubform` (625) — Privacy Mode sub-options wrapper.
  Check `src/client/web/dashboard-privacy-subform.js` for the actual
  handles it uses.
- `tgBalancedNote` (1320) — Telegram-config note.  Check
  `src/client/web/dashboard-telegram.js`.

**Trigger conditions to clean up:** each individual find lives near
a specific dashboard module — the trigger is any code change in
that neighbouring module.  See per-item hint.

---

## Kept off the list (dynamic — do NOT delete)

The fork correctly excluded these because JS constructs their IDs
at runtime:

- `pdChart_dexscreener` / `dextools` / `geckoterminal` —
  `` g(`pdChart_${p.key}`) `` in `dashboard-chart-providers.js:72`.
- 10 `tgEvt_*` IDs — Telegram event checkboxes, JS builds them
  by prefix concat.
- `wpanel-generate` / `key` / `seed` — wallet-panel tab targets
  (URL-hash driven).

---

## Guideline — opportunistic cleanup on contact

**When to consult this file:** at the START of any task that touches
one of the "trigger conditions" areas above.  This is the same
posture as [feedback_finish_logic.md] and
[feedback_trace_patterns_first.md] — do the local hygiene pass while
the context is already loaded.

**Rule of engagement:**

1. If the current task lands you in one of the areas listed above,
   check whether the orphan ID in that neighbourhood is still
   provably unused (grep the current tree — this doc is a
   point-in-time snapshot).  Point-in-time drift is the exact class
   of bug the audit catches; the audit itself can drift.
2. If confirmed still-unused → delete the IDs AND any exclusively-
   orphaned CSS in the same commit as the primary task.  Same
   pattern as the Cluster 1 delete: HTML subtree + orphaned CSS +
   verifier grep in the commit message.
3. If any of the "trigger conditions" area's IDs turn out to be
   used now → remove them from this doc.  Track in a note.
4. Do NOT bulk-delete across multiple clusters in one PR — one
   cluster at a time, small blast radius, easy to review.
5. Do NOT rerun the full audit unless you're doing a dedicated
   cleanup pass — it took the fork ~14 minutes and is only worth
   it when the payoff is broad.

**Do NOT propose deleting these IDs at random turns** when the user
hasn't opened the door.  Same rule as
[project_code_cleanup_nice_to_haves]: only surface when the user
explicitly asks for cleanup, or when the current task already puts
you in the neighbourhood.
