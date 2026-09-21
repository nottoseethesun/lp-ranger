---
name: lead-every-report-with-open-bugs-and-never-omit-one
description: "A report's first line is the open bugs; burying or dropping a known bug is the worst possible failure, because the user ships on that report"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-21T07:20:59.684Z
---

**The first thing in any status report, audit result, or summary is the list of bugs that are still open.** If there are none, say so in one line. Everything else — what was fixed, what was verified, what was checked and found sound — comes after.

**Why:** the user ships from these reports. They said it plainly: *"IF YOU DON'T TELL ME YOU FOUND A BUG THAT IS STILL OPEN I CANNOT SHIP A WORKING APP."* A report that reads well but omits a known defect is worse than no report, because it converts their caution into false confidence. The job is not to produce a good-looking summary; it is to not ship bugs.

**How it failed, twice in one session (2026-09-21):** a known open bug — the transaction cancel-window collapsing to ten seconds after an RPC outage — was carried in one early list and then silently dropped from two later "still open" sections, while those same reports spent 400 words on doc-comment corrections. The user had to ask *"do you see anything that needs fixing?"* to surface it. Their response: *"Why tf would you give me 400 words summary when it looks like there is a real bug but you don't mention it?"*

**The mechanism that caused it, and the fix:** items with a home survive; items living only in a chat sentence do not. `backfill` survived because it was a written rule; the duplicate pipeline survived because it was a README row. The cancel-window bug had neither, so each summary rewrote it from memory until it fell out. **Any open bug gets written into a durable place the moment it is found** — README Clean-ups, an issue, or the local to-do list — not carried in prose.

Related: [[feedback_no_finding_without_a_failure]] (do not pad the list with non-findings), [[feedback_verify_before_claiming]].
