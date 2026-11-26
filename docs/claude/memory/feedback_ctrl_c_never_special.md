---
name: feedback_ctrl_c_never_special
description: "Never handle Ctrl+C specially: it ends the program as it does anywhere, through the program's own exit handlers"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 54faebf5-9812-48c8-8743-e2dde6ca5007
  modified: 2026-11-26T02:08:19.962Z
---

Ctrl+C is never given a meaning of its own: no message saying it was
pressed, no prompt that treats it as an answer, no flow that waits it
out. It ends the program as Ctrl+C ends any program, and the program's
hooks and signal handlers make that exit graceful where one is needed.

**Why:** the user, 2026-11-25, on a password prompt that closed on
Ctrl+C with a warning naming only Ctrl+D: "never handle cntrl-c
specially (but of course, use a hook/etc to handle exit gracefully where
needed)".

**How to apply:** where code holds the terminal in raw mode, as the
password prompt does (src/lib/ask-password.js), Ctrl+C arrives as a key,
not a signal; pass it on as the signal (`process.kill(process.pid,
"SIGINT")`) so the program's own handlers run. Graceful exit belongs in
the handlers (src/server.js's SIGINT and SIGTERM), not in the code that
happened to be running.
