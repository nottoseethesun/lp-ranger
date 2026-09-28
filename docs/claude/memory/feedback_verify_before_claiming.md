---
name: feedback_verify_before_claiming
description: Never state a conclusion about how the system behaved until the check that would falsify it has actually run
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-28T19:34:32.194Z
---

Do not assert what the code or the running app did until the specific
check that could prove it wrong has been run. When the evidence on hand
is partial — a truncated log paste, a grep over a subset of the tree, a
sampled output — say "I can't tell from this" and name the check that
would settle it. Absence from a sample is not absence in fact.

**Why:** every wrong claim costs the user a round trip to correct, and
that is their time and energy, not the assistant's. In one session four
claims were stated confidently and each was wrong: "nothing server-side
reads this setting" (the grep excluded the repo root, where `server.js`
read it); "a second request started" (built on a line missing from a
partial paste, which the user then had to explain was truncated); "the
done log fires before the work finishes" (never checked where the
returned value was assigned — it was settled before the log); and
"the two phases issue duplicate queries" (conflated the RPC call with
the question being asked). Being fast and wrong is slower than being
slow and right, because the user pays the difference.

**A grep proves the presence of a pattern, never the absence of a
behavior.** On 2026-09-28 the question was which ethers reads carry an
extra `eth_chainId`. A grep for `#checkNetwork(` found two call sites,
so the answer given was "`call()` and account reads only — not
`getLogs`." Wrong: most methods call `getNetwork()` directly rather than
through that wrapper, `getLogs` among them. A stub node counting real
requests had the answer in one run — `getLogs` cost two HTTP posts per
read, exactly like `call`. The pattern searched for was real; it just
was not the only way to reach the behavior. When the question is "what
does it actually do at runtime", measure it; a grep only narrows where
to look.

**How to apply:** before writing a conclusion, name the one check that
would falsify it and run that first — the whole-repo grep, the line
where the variable is assigned, the actual Node semantics rather than
the comment claiming them. Prefer "here is what I verified, here is what
I did not" over a clean narrative that outruns the evidence. When
corrected, fix the claim and move on rather than defending the framing.
Related: [[feedback_no_finding_without_a_failure]],
[[feedback_instrument_before_inferring]], [[feedback_full_repo_grep]],
[[feedback_signal_substitution]].
