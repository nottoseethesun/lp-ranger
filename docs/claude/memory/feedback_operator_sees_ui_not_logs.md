---
name: feedback_operator_sees_ui_not_logs
description: Operators judge the app by badges and dialogs, never by the log; answer in UI terms and treat the log as the assistant's instrument
metadata:
  type: feedback
---

The operator watches the dashboard — the Sync badge, the status pills,
the modals. They do not read `logs/lp-ranger.log`. When answering "is it
done", "is it safe to stop", "why is it doing that", lead with what the
UI shows and what it means. The log is the assistant's instrument for
establishing the facts, not the operator's interface.

**Why:** advice phrased around a log line is advice the operator cannot
act on without being told to go and grep, which is not how they use the
app. Told to watch for `Lifetime P&L for #165032 done`, the right answer
was "wait for the Sync badge to go green". Worse, a defect only visible
in the log is invisible in practice — if the UI reads Synced while the
history is short, the operator has no way to know, which is why the
badge must assert something real rather than merely "a scan returned".

**How to apply:** state the answer in UI terms first, and cite the log
only as the evidence behind it. When designing, ask what the operator
would see — a figure that is wrong but confident is worse than one
visibly absent. When a log-only signal matters operationally, that is a
sign the UI is missing something, not that the operator should learn to
grep. Related: [[feedback_no_internal_constants_in_design_talk]],
[[project_unmanaged_na_principle]], [[feedback_keep_browser_logs]].
