---
name: project_deferred_comment_cleanup
description: "Comment cleanups queued behind the two behaviour items (#2.2 and #3) on branch batch-nft-walk"
metadata: 
  node_type: memory
  type: project
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-17T21:21:43.890Z
---

Three comment jobs, deliberately queued behind the two behaviour items:
the unmanaged view saving an empty rebuild (#2.2), and the Sync badge
that stays on "Syncing…" with no reason shown (#3). The user set that
order on 2026-09-17.

**1. `src/position-history.js` — storytelling, and one false claim.**
The JSDoc on `_supplementFeesFromChain` retells the 2026-09-02 fix: the
"$149 of a lifetime $1,084" case and the old
`Collect(last) − DecreaseLiquidity(last)` formula. Rewrite to state the
mechanism only (see [[feedback_no_finding_without_a_failure]] and the
docs rule in CLAUDE-BEST-PRACTICES).

One claim there is **wrong**: a comment says fees are re-derived from
chain even for NFTs "the rebalance log already supplied a figure for,
because that figure is the understated one". The log never records a
fee — nothing in `src/` writes `feesEarnedUsd`. The understated figure
came from the old chain formula. `_applyCloseEntry` also still reads a
`feesEarnedUsd` field the log never contains.

**2. Old-form comment openers.** The rule wants `/*-` alone on its line,
text on the next, `*/` alone on its line
([[feedback_multiline_comment_style]]). The old form puts text on the
opener line. Counts on 2026-09-17: 119 added by branch
`batch-nft-walk`, of which 23 came from commits `e77c7d9` and
`b61b888`; 1,936 repo-wide across 352 files. Scope is the branch's own,
starting with the 23 — not a repo-wide sweep, which is churn during
burn-in.

**3. `docs/engineering.md` storytelling.** A passage recounting the July
2026 discrepancy ($11.63 versus ~$255.50) in content the assistant did
not write. The user's call whether that is institutional memory or
narrative to replace with the invariant.
