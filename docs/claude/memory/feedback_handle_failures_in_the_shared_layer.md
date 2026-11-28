---
name: feedback_handle_failures_in_the_shared_layer
description: "A failure that can come from a shared reader or writer is handled inside it, for every caller, never at the one call site an audit found; plain words, no error classification"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T00:35:16.879Z
---

When a failure can come from a shared reader or writer (a file, a log,
a store), handle it inside that reader or writer, for every read and
write, not at the one call site where it was found.

**Why:** an audit found that a failed write of the rebalance log cut a
rebalance's record-keeping short, and I guarded that one call. The user,
2026-11-27: *"the code should do that for any failed write of the log"*,
*"So you probably want to put the core work deep in the log writer"*,
*"Don't code it just for rebalance - it should be simpler actually that
way, to code it for all writes to the log"*, then *"do the same for a
read"*. Guarding one caller leaves every other reader and writer
unguarded, and repeats the handling at each call site added later.

**How to apply:**
- Give the file one module holding every read and write of it; move
  other modules' copies of the reader into it.
- A missing file a first write creates is no error (*"handle the state
  where there is no log yet - that is not an error"*).
- Say whether reading or writing failed, never calling a failed read a
  write; don't classify the error (*"Don't try to find out the exact
  file error"*). Log the error itself; give the operator plain advice and
  the remedy the user chose.
- No code that repairs the record (*"We don't write any additional
  executable code to try to repair the record"*), and never write over
  a file that could not be read.

Related: [[feedback_no_duplication]], [[feedback_kiss]],
[[feedback_no_junk_repair_code]], [[feedback_basic_fix_first]].
