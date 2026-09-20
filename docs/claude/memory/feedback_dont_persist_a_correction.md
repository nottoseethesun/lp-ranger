---
name: feedback_dont_persist_a_correction
description: "Before adding state to remember a fix-up, ask whether the wrong value should be written at all"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-18T18:34:00.270Z
---

When a value can be written wrong and needs correcting later, do not
reach for state that remembers the correction. Ask first whether that
write should happen at all. Not writing beats recording that a write was
wrong.

**Why:** state that carries a correction has to survive everything the
process does — a restart discards it, and the wrong value it was meant
to fix is already on disk looking settled. Declining to write leaves the
field absent, and absence is usually already the signal that makes the
work rerun. It is durable for free, because it is absent on disk too.

The user's questions are what found this, 2026-09-18. I had a lifetime
scan saving a compounded total computed before a compound landed, and
proposed persisting a request flag so the next scan would redo it —
a config key, an OpenAPI entry, and a fourth request flag. He asked
twice, plainly: "if there's no total, then why would we need to persist
it?" and "is there anything to persist, and if so, what is it?" The
answer was nothing: the coins were on chain and the absence was on disk.
The fix became one predicate that skips the save. His verdict: "avoids
unnecessary complexity for an issue that even if a thousand people used
the app, would almost never happen — but still provides a seamless
recovery path."

**How to apply:**

- Ask what the durable facts already are. Chain data, and a field's own
  absence, both survive a kill; in-memory flags do not.
- If a computation's inputs went stale mid-pass, drop the result rather
  than saving it and scheduling a repair.
- Weigh the machinery against the odds. A config key plus an OpenAPI
  entry to cover a window that needs two rare events to coincide is the
  wrong trade.
- Watch for me answering a "should we store X" question by explaining
  the mechanism instead of saying yes or no. He calls that out.
- Related: [[feedback_no_extra_state]], [[feedback_kiss]],
  [[feedback_never_clear_to_force_a_recompute]],
  [[feedback_no_junk_repair_code]].
