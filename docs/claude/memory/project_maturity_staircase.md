---
name: project_maturity_staircase
description: "Project maturity milestones: MVP (2026-04-09) → soft-launch ready (2026-04-24) → approaching fully battle-tested (2026-06-21). Each step weights risk-vs-friction further toward production; stability and docs/UX beat new features throughout."
metadata: 
  node_type: memory
  type: project
  originSessionId: fbb9ad2b-bfb6-4113-a2f4-fcb15a7900da
  modified: 2026-08-08T05:15:28.957Z
---

Merged from: `project_mvp_reached`, `project_soft_launch_ready`,
`project_approaching_battle_tested` — those slugs no longer exist as separate
files (originals in `archive/`); search this one.

## The staircase

- **Candidate for 1.0 — 2026-09-03.** After 0.9.2 shipped to Production:
  *"I think that perhaps, this app is done. If it stands up for burn-in
  and some more months of use, it will be ready to be Version 1.0."* No
  further features are wanted; the remaining work is burn-in. Treat any
  proposal that adds surface area as needing a strong case, and prefer
  leaving working code alone. See [[project_0092_burn_in_watch]].


- **MVP — 2026-04-09.** User began running the app in production with real LP
  positions on PulseChain.
- **Soft-launch ready — 2026-04-24.** Declared after Pi 5 resource validation:
  *"Ok well if no more significant bugs, then this can be soft-launched"*, then
  *"We'll need to wait and let it run for a while"* — i.e. a prod burn-in comes
  first. Release tag **"High Plains Drifter - 1"** cut the same day, the first
  burn-in release off main. Precondition: no further significant bugs surface.
- **Approaching fully battle-tested — 2026-06-21.** *"Everyone was warned from
  the beginning that this is still an Experimental app; not fully-battle
  tested. Actually I think that with this release, we are about 'there'."*

**Why it matters:** the "Experimental" framing was the standing disclaimer
justifying low-friction trade-offs — e.g. the clean-break `app-config/` →
`app-config/user-configurable/` reorganization, where operators had to `mv`
their own files with no auto-migration, on the grounds they were warned all
along. As the app approaches fully battle-tested, that license to leave sharp
edges expires. Production data is real money.

**How to apply:**

- Stability, bug fixes, and docs/UX polish outrank new features. Before any
  non-trivial change, ask whether it's necessary or safe enough not to
  destabilize what's running.
- Weight risk-vs-friction toward production: fewer breaking defaults, more
  migration safety nets, more user-facing guard rails.
- Be extra careful with anything touching running positions or stored config.
- Known nice-to-haves stay deferred unless the user explicitly picks one up.
- A significant bug resets the "ready to soft-launch" flag — surface it to the
  user rather than quietly fixing and moving on.
- Do NOT escalate the Experimental disclaimer in user-facing copy unsolicited;
  the user controls disclaimer wording and Release Notes.
- Do NOT treat the battle-tested step as licence to re-do already-agreed work
  (the clean-break migration stays clean-break).

Cross-links: [[feedback_hardening_minimal_scope]], [[feedback_try_before_commit]],
[[feedback_nice_to_haves_not_bugs]].
