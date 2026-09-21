---
name: verify-every-symbol-a-comment-names-whenever-you-touch-that-comment
description: "Comments that name a function, file or flag drift silently; grep each name before leaving the line you edited"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-21T07:21:10.623Z
---

**A comment that names a symbol — a function, module, flag or config key — is a claim, and it must be checked like one.** Before leaving any comment you edited, grep every name in it. If the symbol does not exist, or does not do what the sentence says, fix the sentence.

**Why:** these are the only defects that no gate catches. Lint, tests, coverage, and the type of review that reads a diff all pass a comment describing behaviour the code has never had. A reader then trusts it, greps for a function that is not there, and loses the time the comment was supposed to save.

**How often it actually happens:** four times on one branch (2026-09-21), all of them found by audit rather than by any gate:

- `docs/engineering.md` pointed at `timerSecProblem()`, which existed nowhere — the function is `_timerKeyProblem`.
- `rebalancer-execute.js` said the resolver "returns the legacy single slippagePct" as a fallback. It returns the shipped default; that fallback did not exist.
- Three places — a code comment, CLAUDE.md, and the operator docs — said a retired config key is dropped "on load". It is dropped on **save**.
- `bot-config-keys.js` credited `bot-pnl-updater._currentNftGasUsd` for populating a cache. That symbol's only occurrence in the entire repo was the comment naming it.

The fourth is the instructive one: it was found immediately after *editing that exact line* to change one word, without checking the symbol sitting beside it. Touching a comment is precisely when its claims are cheapest to verify and most likely to be stale.

Related: [[feedback_verify_before_claiming]], [[feedback_trace_semantic_coherence]].
