---
name: range-pct-leeway-tooltip
description: "Nice-to-have for the next release — add a circle-i next to the \"±X% below/above price\" figures on the Price Range Monitor card, explaining that each figure is the per-token leeway before the position goes out of range."
metadata: 
  node_type: memory
  type: project
  originSessionId: d932d59e-01b4-45db-82b1-6d987abcda8f
  modified: 2026-09-20T22:43:47.313Z
---

Add a circle-`i` info affordance next to the two "±X% below price" / "+Y% above price" figures rendered by `updateRangePctLabels()` in `public/dashboard-data-range.js` (the `rangePctLower` and `rangePctUpper` spans just below the range visual bar).

**Popover copy — one plain-English sentence per side, plus a summary line:**

> Each figure is the per-token leeway before the position stops earning fees.
>
> **−X% below price:** if the pair moves X% down (base token drops vs quote), the position goes out of range on the bottom. It stops earning fees until the price recovers, and holds only the quote token in the meantime.
>
> **+Y% above price:** if the pair moves Y% up (base token rises vs quote), the position goes out of range on the top. It stops earning fees until the price returns, and holds only the base token in the meantime.

**Why:** User asked (2026-07-18, this session) what the two figures actually tell them, then confirmed "one line, per side, showing how much price movement each token can absorb before the position stops earning" was the takeaway they wanted surfaced. Baking that into the UI removes the need to re-derive it.

**How to apply:**
- Follow the existing param-help pattern (`data-param-help="rangePctLeeway"` on the circle-`i` span; add the entry to `public/param-help-content.js`).
- Two visual `i` icons — one next to each figure — that share the same popover, or a single icon between the two labels; user choice on layout.
- No test coverage needed beyond making sure the popover key resolves; the two figures themselves are already covered by existing `updateRangePctLabels` tests.
- Nice-to-have (not a bug) — no urgency. Bundle it into whichever near-term release has related UI polish.

---

**Was on the public list (2026-09-02).** Published on the README's
Nice-to-Have list as "Explain the Range Leeway Percentages", with a
roadmap file beside it. Both were removed the same day, when the item
turned out to have already shipped — see below. Neither exists now, and
nothing needs keeping in step.

---

**RESOLVED &mdash; archived 2026-09-02.** The tooltip exists and is
wired up: `public/index.html` carries the circle-i with
`data-param-help="rangePctLeeway"` next to the range percentages, and
`public/param-help-content.js` holds the `rangePctLeeway` entry. This
memory had gone stale, describing as outstanding something already
shipped. Nothing to do.
