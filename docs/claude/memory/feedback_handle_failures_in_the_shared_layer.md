---
name: feedback_handle_failures_in_the_shared_layer
description: "A failure that can come from a shared reader or writer is handled inside it, for every caller, never at the one call site an audit found; plain words naming the cause the error shows, never a guessed one"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T05:31:33.367Z
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
  write. Log the error itself; give the operator plain advice and the
  remedy the user chose.
- Name the cause the error itself shows, and the fix for that cause:
  Node's error code (permissions, a full disk, a folder where the file
  should be), a SyntaxError for JSON that does not parse, text that is
  not what LP Ranger writes. Never a blanket cause the error does not
  show. The user first said *"Don't try to find out the exact file
  error"*; when my blanket "check the permissions and whether the disk
  is full" then met a file that was only invalid JSON, they ruled
  (2026-11-27): *"avoid a false negative of "can't read file or disk
  full" if that's not the case: NodeJS has a file api that can tell
  that. Somehow, you jacked that up bad."* An error that wraps another
  is told by the one it wraps.
- Any JSON file that is not valid stops LP Ranger gracefully, the server
  first, then the bot, with that cause in the log (the same ruling:
  *"LP Ranger always exits gracefully (as always, first server if any
  then bot) if any json file is not valid"*).
- No code that repairs the record (*"We don't write any additional
  executable code to try to repair the record"*), and never write over
  a file that could not be read.

Related: [[feedback_no_duplication]], [[feedback_kiss]],
[[feedback_no_junk_repair_code]], [[feedback_basic_fix_first]].
