---
name: feedback_tests_use_a_free_port
description: "A test that listens takes a port the system says is free (test/helpers/free-port.js), never a fixed one; do it without asking"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-27T21:15:23.631Z
---

A test that starts the server, or a child process that listens, takes
its port from `freePort()` (test/helpers/free-port.js), never a fixed
number, however high.

**Why:** Linux hands out ports in the same range (32768–60999) for
outgoing connections, so a fixed port such as 54383 can be held by
another program at that moment, and the test fails with nothing wrong in
the code. The user, 2026-11-27, on a test with a fixed port: "yes of
course always do that - no need to ask me".

**How to apply:** use `freePort()` in every new test that listens, and
move an older test to it when touching that test. Don't ask first. See
[[feedback_no_flaky_push]].
