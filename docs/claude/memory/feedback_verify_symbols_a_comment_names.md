---
name: verify-every-symbol-a-comment-names-whenever-you-touch-that-comment
description: "Comments that name a function, file or flag drift silently; grep each name before leaving the line you edited"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-10-01T01:02:34.072Z
---

**A comment that names a symbol — a function, module, flag or config key — is a claim, and it must be checked like one.** Before leaving any comment you edited, grep every name in it. If the symbol does not exist, or does not do what the sentence says, fix the sentence.

**Why:** these are the only defects that no gate catches. Lint, tests, coverage, and the type of review that reads a diff all pass a comment describing behaviour the code has never had. A reader then trusts it, greps for a function that is not there, and loses the time the comment was supposed to save.

**How often it actually happens:** four times on one branch (2026-09-21), all of them found by audit rather than by any gate:

- `docs/engineering.md` pointed at `timerSecProblem()`, which existed nowhere — the function is `_timerKeyProblem`.
- `rebalancer-execute.js` said the resolver "returns the legacy single slippagePct" as a fallback. It returns the shipped default; that fallback did not exist.
- Three places — a code comment, CLAUDE.md, and the operator docs — said a retired config key is dropped "on load". It is dropped on **save**.
- `bot-config-keys.js` credited `bot-pnl-updater._currentNftGasUsd` for populating a cache. That symbol's only occurrence in the entire repo was the comment naming it.

The fourth is the instructive one: it was found immediately after *editing that exact line* to change one word, without checking the symbol sitting beside it. Touching a comment is precisely when its claims are cheapest to verify and most likely to be stale.

## Re-pointing a sentence at a different file makes every number in it a new claim (2026-09-30)

Correcting "`_waitOrSpeedUp()` in `src/rebalancer.js`" to
`src/tx-speedup.js` across three docs looked like relocating a pointer.
It is not. **The rest of the sentence was written about a different
implementation, and each of its claims has to be re-checked against the
new one.** Two were wrong once re-pointed:

- "bump by 1.5×" — hard-coded in the copy being left behind; in
  `tx-speedup.js:185` it is `config.CHAIN?.speedUpGasBump ?? 1.5`, a
  per-chain setting. Both shipped chains happen to say 1.5, so this one
  survived on luck, not on checking.
- "stuck nonces **always** free themselves" / "never permanently
  blocked" — both cancel paths are best-effort and say so in their own
  logs (`tx-speedup.js` logs "nonce %d may still be stuck"; the
  aggregator's cancel races `wait()` against a timer and cannot tell an
  unconfirmed cancel from a landed one). Worse, having found a *second*
  route I asserted the same guarantee of both — turning one file's
  overstatement into a claim about two.

**How to apply:** when a doc edit changes which file a sentence is about,
treat the whole sentence as newly written. Grep every constant in it
against the new file, and check every "always", "never" and "ensures"
against the error branch. A guarantee is only as strong as the path that
fails: if the code logs "may still be stuck", the doc may not say
"always freed".

And **never widen a claim because you found another thing it seems to
cover.** Extending an existing absolute to a second path is not
housekeeping — it is a new, stronger assertion, and it needs more
evidence than the sentence you copied it from.

Related: [[feedback_verify_before_claiming]], [[feedback_trace_semantic_coherence]],
[[feedback_no_finding_without_a_failure]].
